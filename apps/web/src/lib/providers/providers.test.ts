import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "./errors";
import { BrowserSpeechToTextProvider, BrowserTextToSpeechProvider } from "./browser-speech";
import { MockLanguageModelProvider } from "./mock-language";
import { OpenAICompatibleLanguageModelProvider } from "./openai-compatible";

async function textFrom(provider: MockLanguageModelProvider | OpenAICompatibleLanguageModelProvider) {
  let answer = "";
  for await (const chunk of provider.streamResponse({
    messages: [{ role: "user", content: "Schedule a discovery call." }],
  })) {
    if (chunk.type === "text") answer += chunk.text;
  }
  return answer;
}

afterEach(() => vi.unstubAllGlobals());

describe("MockLanguageModelProvider", () => {
  it("streams a functional credential-free response", async () => {
    const answer = await textFrom(new MockLanguageModelProvider(0));
    expect(answer).toContain("prepared the scheduling request");
  });

  it("honors interruption", async () => {
    const controller = new AbortController();
    const iterator = new MockLanguageModelProvider(0).streamResponse({
      messages: [{ role: "user", content: "Hello" }],
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "ABORTED" } satisfies Partial<ProviderError>);
  });

  it("identifies the assistant as MRE in its local fallback response", async () => {
    let answer = "";
    for await (const chunk of new MockLanguageModelProvider(0).streamResponse({
      messages: [{ role: "user", content: "Who are you?" }],
    })) {
      if (chunk.type === "text") answer += chunk.text;
    }
    expect(answer).toContain("MRE");
  });
});

describe("Browser speech providers", () => {
  it("returns a real browser speech-synthesis directive", async () => {
    const result = await new BrowserTextToSpeechProvider().synthesize({
      text: "MRE is ready.",
      speed: 1.1,
    });
    expect(result).toMatchObject({
      kind: "browser-speech",
      provider: "browser",
      text: "MRE is ready.",
      rate: 1.1,
    });
  });

  it("passes through the browser's final transcript without fabricating text", async () => {
    const result = await new BrowserSpeechToTextProvider().transcribe({
      audio: new Blob(["captured audio"]),
      mimeType: "audio/webm",
      browserTranscript: "Hello MRE",
    });
    expect(result).toMatchObject({
      text: "Hello MRE",
      provider: "browser",
      isFinal: true,
      clientFallback: "web-speech-recognition",
    });
  });
});

describe("OpenAICompatibleLanguageModelProvider", () => {
  it("parses OpenAI-compatible SSE without exposing the key to callers", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"MRE"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const answer = await textFrom(
      new OpenAICompatibleLanguageModelProvider("https://example.test/v1", "server-secret", "test-model"),
    );
    expect(answer).toBe("Hello MRE");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ authorization: "Bearer server-secret" });
  });
});
