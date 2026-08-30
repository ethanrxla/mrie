import { boundedErrorBody, errorForHttpStatus, ProviderError, throwIfAborted } from "./errors";
import { messagesForProvider } from "./prompt";
import type { AIChunk, AIRequest, LanguageModelProvider } from "./types";

interface OpenAIStreamPayload {
  choices?: Array<{
    delta?: { content?: string | Array<{ type?: string; text?: string }> };
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

type DeltaContent = string | Array<{ type?: string; text?: string }> | undefined;

function completionUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!/\/chat\/completions\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  }
  return url.toString();
}

function contentText(content: DeltaContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

async function* sseData(response: Response, signal?: AbortSignal): AsyncIterable<string> {
  if (!response.body) {
    throw new ProviderError("The model returned an empty streaming response", {
      code: "BAD_RESPONSE",
      provider: "openai-compatible",
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      throwIfAborted(signal, "openai-compatible");
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (events.pop() ?? "");

      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export class OpenAICompatibleLanguageModelProvider implements LanguageModelProvider {
  readonly name = "openai-compatible";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async *streamResponse(input: AIRequest): AsyncIterable<AIChunk> {
    throwIfAborted(input.signal, this.name);
    let response: Response;
    try {
      response = await fetch(completionUrl(this.baseUrl), {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: messagesForProvider(input),
          stream: true,
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
          ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
        }),
        cache: "no-store",
        signal: input.signal,
      });
    } catch (error) {
      throwIfAborted(input.signal, this.name);
      throw new ProviderError("The language-model endpoint is unavailable", {
        code: "UNAVAILABLE",
        provider: this.name,
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) {
      throw errorForHttpStatus(this.name, response.status, await boundedErrorBody(response));
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const payload = (await response.json()) as OpenAIStreamPayload;
      if (payload.error?.message) {
        throw new ProviderError(payload.error.message, { code: "BAD_RESPONSE", provider: this.name });
      }
      const text = payload.choices?.[0]?.message?.content;
      if (text) yield { type: "text", text };
      yield { type: "done", finishReason: payload.choices?.[0]?.finish_reason ?? "stop" };
      return;
    }

    let finishReason: string | undefined;
    for await (const data of sseData(response, input.signal)) {
      if (data === "[DONE]") break;
      let payload: OpenAIStreamPayload;
      try {
        payload = JSON.parse(data) as OpenAIStreamPayload;
      } catch (error) {
        throw new ProviderError("The model returned malformed streaming data", {
          code: "BAD_RESPONSE",
          provider: this.name,
          cause: error,
        });
      }
      if (payload.error?.message) {
        throw new ProviderError(payload.error.message, { code: "BAD_RESPONSE", provider: this.name });
      }
      const choice = payload.choices?.[0];
      const text = contentText(choice?.delta?.content);
      if (text) yield { type: "text", text };
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (payload.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
          },
        };
      }
    }
    throwIfAborted(input.signal, this.name);
    yield { type: "done", finishReason: finishReason ?? "stop" };
  }
}
