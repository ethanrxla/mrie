import { describe, expect, it, vi } from "vitest";

import {
  HermesLanguageModelProvider,
  type HermesProviderOptions,
  type HermesSocketLike,
} from "./hermes";
import type { AIRequest } from "./types";

type Handler = (...args: unknown[]) => void;

class FakeHermesSocket implements HermesSocketLike {
  readyState = 0;
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly url: string;
  private readonly handlers = new Map<string, Handler[]>();

  constructor(
    url: string,
    private readonly approvalMode = "manual",
    private readonly completeTurns = true,
    private readonly resumedSessionId = "hermes-runtime-resumed",
  ) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
      this.frame({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } });
    });
  }

  on(event: string, listener: Handler): unknown {
    const listeners = this.handlers.get(event) ?? [];
    listeners.push(listener);
    this.handlers.set(event, listeners);
    return this;
  }

  send(data: string, callback?: (error?: Error) => void): void {
    const request = JSON.parse(data) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    this.calls.push({ method: request.method, params: request.params });
    callback?.();

    const respond = (result: unknown) => this.frame({ jsonrpc: "2.0", id: request.id, result });
    switch (request.method) {
      case "config.get":
        respond({ value: this.approvalMode });
        break;
      case "config.set":
        respond({ key: "yolo", value: "0", scope: "session" });
        break;
      case "session.create":
        respond({ session_id: "hermes-runtime-1", stored_session_id: "hermes-stored-1" });
        break;
      case "session.resume":
        respond({ session_id: this.resumedSessionId, resumed: request.params.session_id });
        break;
      case "session.interrupt":
        respond({ status: "interrupted" });
        break;
      case "prompt.submit":
        respond({ status: "streaming" });
        if (this.completeTurns) {
          const sessionId = String(request.params.session_id);
          queueMicrotask(() => {
            this.event("message.start", sessionId);
            this.event("tool.start", sessionId, { name: "search_memory" });
            this.event("message.delta", sessionId, { text: "Hello " });
            this.event("message.delta", sessionId, { text: "from Hermes" });
            this.event("message.complete", sessionId, {
              text: "Hello from Hermes",
              status: "complete",
              usage: { input_tokens: 12, output_tokens: 3 },
            });
          });
        }
        break;
      case "approval.respond":
        respond({ resolved: true });
        break;
      default:
        this.frame({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `method not found: ${request.method}` },
        });
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.close();
  }

  private event(type: string, sessionId: string, payload: Record<string, unknown> = {}): void {
    this.frame({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload } });
  }

  private frame(frame: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

function request(conversationId = crypto.randomUUID(), signal?: AbortSignal): AIRequest {
  return {
    conversationId,
    userId: "mre-user",
    systemPrompt: "You are MRE.",
    messages: [
      { role: "user", content: "Previous question" },
      { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Current question" },
    ],
    signal,
  };
}

function options(factory: HermesProviderOptions["socketFactory"]): HermesProviderOptions {
  return {
    gatewayUrl: "ws://127.0.0.1:9119/api/ws",
    token: "test-token-with-32-characters-long",
    approvalPolicy: "manual-required",
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 2_000,
    socketFactory: factory,
  };
}

async function collect(provider: HermesLanguageModelProvider, input: AIRequest) {
  let text = "";
  const activities: string[] = [];
  for await (const chunk of provider.streamResponse(input)) {
    if (chunk.type === "text") text += chunk.text;
    if (chunk.type === "activity") activities.push(chunk.label);
  }
  return { text, activities };
}

describe("HermesLanguageModelProvider", () => {
  it("uses the vendored session/prompt event protocol and streams deltas", async () => {
    let socket: FakeHermesSocket | undefined;
    const provider = new HermesLanguageModelProvider(options((url) => {
      socket = new FakeHermesSocket(url);
      return socket;
    }));

    const result = await collect(provider, request());

    expect(result.text).toBe("Hello from Hermes");
    expect(result.activities).toContain("Using search_memory");
    expect(socket?.calls.map((call) => call.method)).toEqual([
      "config.get",
      "session.create",
      "config.set",
      "prompt.submit",
    ]);
    expect(socket?.calls.find((call) => call.method === "prompt.submit")?.params).toMatchObject({
      session_id: "hermes-runtime-1",
      text: "Current user request:\nCurrent question",
    });
    expect(new URL(socket!.url).searchParams.get("token")).toBe("test-token-with-32-characters-long");
    expect(result.text).not.toContain("test-token");
  });

  it("resumes the Hermes durable session for a later MRE turn", async () => {
    const conversationId = crypto.randomUUID();
    const sockets: FakeHermesSocket[] = [];
    const provider = new HermesLanguageModelProvider(options((url) => {
      const socket = new FakeHermesSocket(url);
      sockets.push(socket);
      return socket;
    }));

    await collect(provider, request(conversationId));
    await collect(provider, request(conversationId));

    expect(sockets[1]?.calls.map((call) => call.method)).toContain("session.resume");
    expect(sockets[1]?.calls.find((call) => call.method === "session.resume")?.params).toMatchObject({
      session_id: "hermes-stored-1",
      omit_messages: true,
    });
    expect(sockets[1]?.calls.find((call) => call.method === "prompt.submit")?.params.session_id)
      .toBe("hermes-runtime-resumed");
  });

  it("fails closed when Hermes approval mode is not manual", async () => {
    const provider = new HermesLanguageModelProvider(options((url) => new FakeHermesSocket(url, "off")));
    const health = await provider.healthCheck();
    expect(health).toMatchObject({ available: false, provider: "hermes" });
    expect(health.detail).toContain("approvals.mode is off");
  });

  it("interrupts the Hermes runtime when the browser aborts generation", async () => {
    let socket: FakeHermesSocket | undefined;
    const controller = new AbortController();
    const provider = new HermesLanguageModelProvider(options((url) => {
      socket = new FakeHermesSocket(url, "manual", false);
      return socket;
    }));

    const running = collect(provider, request(crypto.randomUUID(), controller.signal));
    await vi.waitFor(() => expect(socket?.calls.some((call) => call.method === "prompt.submit")).toBe(true));
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "ABORTED", provider: "hermes" });
    await vi.waitFor(() => expect(socket?.calls.some((call) => call.method === "session.interrupt")).toBe(true));
  });
});
