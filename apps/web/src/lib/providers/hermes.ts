import { Buffer } from "node:buffer";

import WebSocket from "ws";

import { ProviderError, throwIfAborted } from "./errors";
import { currentUserMessage, formatMemoryContext } from "./prompt";
import type { AIChunk, AIRequest, LanguageModelProvider, ProviderHealth, TokenUsage } from "./types";

type HermesApprovalPolicy = "manual-required" | "respect-hermes";

export interface HermesProviderOptions {
  gatewayUrl: string;
  token: string;
  profile?: string;
  cwd?: string;
  approvalPolicy: HermesApprovalPolicy;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  socketFactory?: HermesSocketFactory;
}

export interface HermesSocketLike {
  readonly readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export type HermesSocketFactory = (url: string) => HermesSocketLike;

interface HermesRpcFrame {
  id?: string | number | null;
  method?: string;
  params?: HermesEvent;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface HermesEvent {
  type: string;
  session_id?: string;
  payload?: unknown;
}

interface HermesSessionCreateResult {
  session_id: string;
  stored_session_id?: string;
}

interface HermesSessionResumeResult {
  session_id: string;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

interface ReadyWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

interface QueueWaiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

class HermesRpcError extends ProviderError {
  readonly rpcCode?: number;

  constructor(message: string, rpcCode?: number) {
    super(message, { code: "BAD_RESPONSE", provider: "hermes" });
    this.name = "HermesRpcError";
    this.rpcCode = rpcCode;
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private terminalError?: Error;

  push(value: T): void {
    if (this.terminalError) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  next(): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise<T>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.values.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

class HermesGatewayConnection {
  private socket?: HermesSocketLike;
  private opened = false;
  private ready = false;
  private closed = false;
  private nextId = 0;
  private readonly pending = new Map<string, PendingCall>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readonly eventHandlers = new Set<(event: HermesEvent) => void>();
  private readonly closeHandlers = new Set<(error: Error) => void>();

  constructor(private readonly options: HermesProviderOptions) {}

  onEvent(handler: (event: HermesEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, "hermes");
    const socket = (this.options.socketFactory ?? defaultSocketFactory)(this.authenticatedUrl());
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate?.();
        reject(providerTimeout("Hermes gateway did not accept the WebSocket connection", this.options.connectTimeoutMs));
      }, this.options.connectTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        socket.terminate?.();
        finish(abortedError(signal));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      socket.on("open", () => {
        this.opened = true;
        finish();
      });
      socket.on("message", (raw) => this.handleMessage(raw));
      socket.on("error", (raw) => {
        const error = connectionError(raw);
        if (!this.opened) finish(error);
        this.fail(error);
      });
      socket.on("close", (code, reason) => {
        const suffix = typeof code === "number" && code !== 1000 ? ` (close code ${code})` : "";
        const error = new ProviderError(`Hermes gateway closed the connection${suffix}`, {
          code: "UNAVAILABLE",
          provider: "hermes",
          retryable: true,
          cause: reason,
        });
        if (!this.opened) finish(error);
        this.fail(error);
      });
    });

    await this.waitUntilReady(signal);
  }

  request<T>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<T> {
    throwIfAborted(signal, "hermes");
    const socket = this.socket;
    if (!socket || !this.opened || this.closed || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ProviderError("Hermes gateway is not connected", {
        code: "UNAVAILABLE",
        provider: "hermes",
        retryable: true,
      }));
    }

    const id = `mrie-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id);
        call.removeAbort?.();
        reject(providerTimeout(`Hermes RPC timed out: ${method}`, timeoutMs));
      }, timeoutMs);

      const pending: PendingCall = {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      };

      if (signal) {
        const onAbort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          reject(abortedError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, pending);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
        if (!error) return;
        const call = this.takePending(id);
        call?.reject(connectionError(error));
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.close(1000, "MRE request complete");
    } catch {
      this.socket?.terminate?.();
    }
  }

  private authenticatedUrl(): string {
    let url: URL;
    try {
      url = new URL(this.options.gatewayUrl);
    } catch (error) {
      throw new ProviderError("HERMES_GATEWAY_URL is not a valid URL", {
        code: "CONFIGURATION",
        provider: "hermes",
        cause: error,
      });
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new ProviderError("HERMES_GATEWAY_URL must use ws:// or wss://", {
        code: "CONFIGURATION",
        provider: "hermes",
      });
    }
    for (const credential of ["token", "ticket", "internal"]) {
      if (url.searchParams.has(credential)) {
        throw new ProviderError("Keep Hermes credentials in HERMES_GATEWAY_TOKEN, not HERMES_GATEWAY_URL", {
          code: "CONFIGURATION",
          provider: "hermes",
        });
      }
    }
    url.searchParams.set("token", this.options.token);
    return url.toString();
  }

  private waitUntilReady(signal?: AbortSignal): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.closed) return Promise.reject(new ProviderError("Hermes gateway closed before it became ready", {
      code: "UNAVAILABLE",
      provider: "hermes",
      retryable: true,
    }));

    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.readyWaiters.delete(waiter);
          waiter.removeAbort?.();
          reject(providerTimeout("Hermes gateway did not emit gateway.ready", this.options.connectTimeoutMs));
        }, this.options.connectTimeoutMs),
      };
      if (signal) {
        const onAbort = () => {
          if (!this.readyWaiters.delete(waiter)) return;
          clearTimeout(waiter.timer);
          reject(abortedError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.readyWaiters.add(waiter);
    });
  }

  private handleMessage(raw: unknown): void {
    let frame: HermesRpcFrame;
    try {
      frame = JSON.parse(frameText(raw)) as HermesRpcFrame;
    } catch {
      return;
    }

    if (frame.id !== undefined && frame.id !== null) {
      const call = this.takePending(String(frame.id));
      if (!call) return;
      if (frame.error) {
        call.reject(new HermesRpcError(
          sanitizeDetail(frame.error.message) || "Hermes RPC failed",
          frame.error.code,
        ));
      } else {
        call.resolve(frame.result);
      }
      return;
    }

    if (frame.method !== "event" || !frame.params?.type) return;
    if (frame.params.type === "gateway.ready") {
      this.ready = true;
      for (const waiter of this.readyWaiters) {
        clearTimeout(waiter.timer);
        waiter.removeAbort?.();
        waiter.resolve();
      }
      this.readyWaiters.clear();
    }
    for (const handler of this.eventHandlers) handler(frame.params);
  }

  private takePending(id: string): PendingCall | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    return pending;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id] of this.pending) this.takePending(id)?.reject(error);
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.removeAbort?.();
      waiter.reject(error);
    }
    this.readyWaiters.clear();
    for (const handler of this.closeHandlers) handler(error);
  }
}

const storedSessionByConversation = new Map<string, string>();

export class HermesLanguageModelProvider implements LanguageModelProvider {
  readonly name = "hermes";

  constructor(private readonly options: HermesProviderOptions) {}

  async *streamResponse(input: AIRequest): AsyncIterable<AIChunk> {
    throwIfAborted(input.signal, this.name);
    const prompt = this.currentPrompt(input);
    if (!prompt.trim()) {
      throw new ProviderError("Hermes requires a user message", {
        code: "BAD_RESPONSE",
        provider: this.name,
      });
    }

    yield { type: "activity", label: "Connecting to the Hermes agent runtime" };

    const connection = new HermesGatewayConnection(this.options);
    const events = new AsyncQueue<HermesEvent>();
    let sessionId: string | undefined;
    let completed = false;

    const detachEvent = connection.onEvent((event) => {
      if (sessionId && event.session_id && event.session_id !== sessionId) return;

      if (event.type === "approval.request") {
        events.push(event);
        const target = event.session_id ?? sessionId;
        if (target) {
          void connection.request("approval.respond", { session_id: target, choice: "deny" }, undefined, 5_000)
            .catch((error) => events.fail(normalizeError(error)));
        }
        return;
      }

      if (["clarify.request", "secret.request", "sudo.request"].includes(event.type)) {
        const target = event.session_id ?? sessionId;
        if (target) void connection.request("session.interrupt", { session_id: target }, undefined, 5_000).catch(() => undefined);
        events.fail(new ProviderError(
          event.type === "clarify.request"
            ? "Hermes requested interactive clarification; the MRE-to-Hermes clarification bridge is not enabled"
            : "Hermes requested a secret or elevated credential; MRE refused the request",
          { code: "UNAVAILABLE", provider: this.name },
        ));
        return;
      }

      events.push(event);
    });
    const detachClose = connection.onClose((error) => events.fail(error));
    const onAbort = () => {
      if (sessionId) {
        void connection.request("session.interrupt", { session_id: sessionId }, undefined, 5_000).catch(() => undefined);
      }
      events.fail(abortedError(input.signal));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await connection.connect(input.signal);
      yield { type: "activity", label: "Verifying the Hermes safety boundary" };
      await this.assertApprovalPolicy(connection, input.signal);

      const session = await this.openSession(connection, input, input.signal);
      sessionId = session.sessionId;
      await connection.request("config.set", {
        key: "yolo",
        scope: "session",
        session_id: sessionId,
        value: "0",
      }, input.signal, 10_000);

      yield { type: "activity", label: "Hermes is working on the request" };
      await connection.request("prompt.submit", {
        session_id: sessionId,
        text: prompt,
      }, input.signal, this.options.requestTimeoutMs);

      let streamedText = "";
      const deadline = Date.now() + this.options.requestTimeoutMs;
      while (!completed) {
        throwIfAborted(input.signal, this.name);
        const event = await withDeadline(events.next(), deadline, "Hermes turn did not complete in time");
        const payload = recordPayload(event.payload);

        if (event.type === "message.delta") {
          const text = typeof payload.text === "string" ? payload.text : "";
          if (text) {
            streamedText += text;
            yield { type: "text", text };
          }
          continue;
        }

        if (event.type === "message.complete") {
          const finalText = typeof payload.text === "string" ? payload.text : "";
          if (!streamedText && finalText) yield { type: "text", text: finalText };
          else if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
            yield { type: "text", text: finalText.slice(streamedText.length) };
          }

          const usage = normalizeUsage(payload.usage);
          if (usage) yield { type: "usage", usage };

          const status = typeof payload.status === "string" ? payload.status : "complete";
          if (status === "error") {
            throw new ProviderError(
              sanitizeDetail(typeof payload.error === "string" ? payload.error : finalText) || "Hermes failed to complete the turn",
              { code: "BAD_RESPONSE", provider: this.name },
            );
          }
          completed = true;
          yield { type: "done", finishReason: status === "interrupted" ? "interrupted" : "stop" };
          continue;
        }

        if (event.type === "error") {
          throw new ProviderError(
            sanitizeDetail(typeof payload.message === "string" ? payload.message : "Hermes reported an error"),
            { code: "BAD_RESPONSE", provider: this.name },
          );
        }

        const activity = activityFor(event, payload);
        if (activity) yield { type: "activity", label: activity };
      }
    } catch (error) {
      if (sessionId && !completed && !input.signal?.aborted) {
        await connection.request("session.interrupt", { session_id: sessionId }, undefined, 5_000).catch(() => undefined);
      }
      throw normalizeError(error);
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      detachEvent();
      detachClose();
      connection.close();
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const connection = new HermesGatewayConnection(this.options);
    try {
      await connection.connect(signal);
      const approvalMode = await this.assertApprovalPolicy(connection, signal);
      return {
        available: true,
        provider: this.name,
        detail: `Hermes JSON-RPC connected (${gatewayLabel(this.options.gatewayUrl)}; approvals=${approvalMode})`,
      };
    } catch (error) {
      return {
        available: false,
        provider: this.name,
        detail: normalizeError(error).message,
      };
    } finally {
      connection.close();
    }
  }

  private async assertApprovalPolicy(connection: HermesGatewayConnection, signal?: AbortSignal): Promise<string> {
    const result = await connection.request<{ value?: string }>(
      "config.get",
      { key: "approvals.mode" },
      signal,
      10_000,
    );
    const mode = result?.value?.trim().toLowerCase() || "unknown";
    if (this.options.approvalPolicy === "manual-required" && mode !== "manual") {
      throw new ProviderError(
        `Hermes approvals.mode is ${mode}; set it to manual or explicitly choose HERMES_APPROVAL_POLICY=respect-hermes`,
        { code: "CONFIGURATION", provider: this.name },
      );
    }
    return mode;
  }

  private async openSession(
    connection: HermesGatewayConnection,
    input: AIRequest,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; storedSessionId: string }> {
    const key = this.conversationKey(input);
    const storedSessionId = key ? storedSessionByConversation.get(key) : undefined;

    if (storedSessionId) {
      try {
        const resumed = await connection.request<HermesSessionResumeResult>("session.resume", {
          session_id: storedSessionId,
          source: "mrie-web",
          omit_messages: true,
          ...(this.options.profile ? { profile: this.options.profile } : {}),
        }, signal, this.options.requestTimeoutMs);
        if (!resumed?.session_id) throw new HermesRpcError("Hermes session.resume returned no session_id");
        return { sessionId: resumed.session_id, storedSessionId };
      } catch (error) {
        if (!isSessionNotFound(error)) throw error;
        storedSessionByConversation.delete(key!);
      }
    }

    const created = await connection.request<HermesSessionCreateResult>("session.create", {
      cols: 120,
      source: "mrie-web",
      close_on_disconnect: false,
      messages: this.seedMessages(input),
      ...(this.options.profile ? { profile: this.options.profile } : {}),
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    }, signal, this.options.requestTimeoutMs);
    if (!created?.session_id) throw new HermesRpcError("Hermes session.create returned no session_id");
    const durableId = created.stored_session_id || created.session_id;
    if (key) storedSessionByConversation.set(key, durableId);
    return { sessionId: created.session_id, storedSessionId: durableId };
  }

  private seedMessages(input: AIRequest): Array<{ role: string; content: string }> {
    const history = input.messages.filter((message) => message.content.trim());
    let currentUserIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.role === "user") {
        currentUserIndex = index;
        break;
      }
    }
    const prior = currentUserIndex >= 0 ? history.slice(0, currentUserIndex) : history;
    return [
      ...(input.systemPrompt?.trim() ? [{ role: "system", content: input.systemPrompt.trim() }] : []),
      ...prior.slice(-23).map((message) => ({ role: message.role, content: message.content })),
    ];
  }

  private currentPrompt(input: AIRequest): string {
    const memory = formatMemoryContext(input);
    const current = currentUserMessage(input).trim();
    return [memory, current ? `Current user request:\n${current}` : ""].filter(Boolean).join("\n\n");
  }

  private conversationKey(input: AIRequest): string | undefined {
    if (!input.conversationId) return undefined;
    return [gatewayLabel(this.options.gatewayUrl), this.options.profile ?? "default", input.userId ?? "anonymous", input.conversationId].join("|");
  }
}

function defaultSocketFactory(url: string): HermesSocketLike {
  return new WebSocket(url) as unknown as HermesSocketLike;
}

function frameText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  if (Array.isArray(raw) && raw.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(raw as Buffer[]).toString("utf8");
  }
  return String(raw);
}

function recordPayload(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
}

function activityFor(event: HermesEvent, payload: Record<string, unknown>): string | undefined {
  if (event.type === "approval.request") return "Hermes requested an action approval; MRE denied it pending an operator-approved bridge";
  if (event.type === "message.interim") return "Hermes completed an intermediate step";
  if (event.type === "status.update") {
    const text = typeof payload.text === "string" ? sanitizeActivity(payload.text) : "";
    return text || "Hermes updated the task status";
  }
  if (event.type === "tool.start" || event.type === "tool.progress" || event.type === "tool.complete") {
    const tool = [payload.name, payload.tool_name, payload.label]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const phase = event.type === "tool.start" ? "Using" : event.type === "tool.complete" ? "Completed" : "Running";
    return tool ? `${phase} ${sanitizeActivity(tool)}` : `${phase} a Hermes tool`;
  }
  return undefined;
}

function sanitizeActivity(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
}

function sanitizeDetail(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/([?&](?:token|ticket|internal)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 500);
}

function normalizeUsage(raw: unknown): TokenUsage | undefined {
  const usage = recordPayload(raw);
  const inputTokens = numberValue(usage.input_tokens ?? usage.inputTokens ?? usage.input);
  const outputTokens = numberValue(usage.output_tokens ?? usage.outputTokens ?? usage.output);
  const totalTokens = numberValue(usage.total_tokens ?? usage.totalTokens ?? usage.total)
    ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function gatewayLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "configured gateway";
  }
}

function connectionError(raw: unknown): ProviderError {
  const detail = raw instanceof Error ? sanitizeDetail(raw.message) : "";
  return new ProviderError(detail ? `Hermes gateway connection failed: ${detail}` : "Hermes gateway connection failed", {
    code: "UNAVAILABLE",
    provider: "hermes",
    retryable: true,
    cause: raw,
  });
}

function abortedError(signal?: AbortSignal): ProviderError {
  return new ProviderError("The Hermes turn was interrupted", {
    code: "ABORTED",
    provider: "hermes",
    cause: signal?.reason,
  });
}

function providerTimeout(message: string, timeoutMs: number): ProviderError {
  return new ProviderError(`${message} after ${Math.round(timeoutMs / 1_000)}s`, {
    code: "TIMEOUT",
    provider: "hermes",
    retryable: true,
  });
}

function normalizeError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError(sanitizeDetail(error instanceof Error ? error.message : String(error)) || "Hermes provider failed", {
    code: "UNAVAILABLE",
    provider: "hermes",
    retryable: true,
    cause: error,
  });
}

function isSessionNotFound(error: unknown): boolean {
  return error instanceof HermesRpcError && (error.rpcCode === 4007 || /session not found/i.test(error.message));
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw providerTimeout(message, 0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(providerTimeout(message, remaining)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
