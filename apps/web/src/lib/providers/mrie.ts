import { throwIfAborted } from "./errors";
import { MrieRpcClient } from "./mrie-rpc";
import { currentUserMessage, formatMemoryContext } from "./prompt";
import type { AIChunk, AIRequest, LanguageModelProvider, ProviderHealth } from "./types";

interface MrieAnswer {
  response: string;
  session_id: string;
}

export class MrieLanguageModelProvider implements LanguageModelProvider {
  readonly name = "mrie";
  private readonly rpc: MrieRpcClient;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {
    this.rpc = new MrieRpcClient(host, port);
  }

  async *streamResponse(input: AIRequest): AsyncIterable<AIChunk> {
    throwIfAborted(input.signal, this.name);
    yield { type: "activity", label: "Consulting the MRE intelligence runtime" };

    const result = await this.rpc.request<MrieAnswer>(
      "ask",
      {
        message: this.composeMessage(input),
        session_id: input.conversationId ?? "mrie-web",
      },
      input.signal,
    );

    // MRE's current TCP transport returns one complete JSON-RPC response. Re-chunking
    // keeps the web contract uniform until the Python transport gains native streaming.
    for (const token of result.response.match(/\S+\s*/g) ?? []) {
      throwIfAborted(input.signal, this.name);
      yield { type: "text", text: token };
      await Promise.resolve();
    }
    yield { type: "done", finishReason: "stop" };
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    try {
      await this.rpc.request<{ pong: boolean }>("ping", {}, signal, 3_000);
      return { available: true, provider: this.name, detail: `MRE at ${this.host}:${this.port}` };
    } catch (error) {
      return {
        available: false,
        provider: this.name,
        detail: error instanceof Error ? error.message : "MRE is unavailable",
      };
    }
  }

  private composeMessage(input: AIRequest): string {
    const sections: string[] = [];
    if (input.systemPrompt?.trim()) sections.push(`MRE system guidance:\n${input.systemPrompt.trim()}`);
    const memory = formatMemoryContext(input);
    if (memory) sections.push(memory);
    sections.push(`Current user request:\n${currentUserMessage(input)}`);
    return sections.join("\n\n");
  }

}
