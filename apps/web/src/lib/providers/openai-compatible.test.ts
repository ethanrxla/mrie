import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatibleLanguageModelProvider } from "@/lib/providers/openai-compatible";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible streaming adapter", () => {
  it("parses SSE deltas without exposing the API key to output", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}',
      "",
      'data: {"choices":[{"delta":{"content":"operator"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleLanguageModelProvider(
      "https://models.example.test/v1",
      "secret-key",
      "test-model",
    );
    let text = "";
    for await (const chunk of provider.streamResponse({
      messages: [{ role: "user", content: "Hello" }],
    })) {
      if (chunk.type === "text") text += chunk.text;
    }
    expect(text).toBe("Hello operator");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://models.example.test/v1/chat/completions");
  });
});
