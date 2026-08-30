import { throwIfAborted } from "./errors";
import { currentUserMessage } from "./prompt";
import type { AIChunk, AIRequest, LanguageModelProvider, ProviderHealth } from "./types";

function testAnswer(input: AIRequest): string {
  const question = currentUserMessage(input).trim();
  const normalized = question.toLowerCase();

  if (/what do you remember|show (?:me )?(?:your|my) memor/.test(normalized)) {
    if (!input.memories?.length) {
      return "I do not have any relevant saved memory for this request yet. You can say 'Remember that...' to add a durable fact.";
    }
    const facts = input.memories.slice(0, 4).map((memory) => `${memory.title}: ${memory.content}`);
    return `I found ${facts.length} relevant ${facts.length === 1 ? "memory" : "memories"}: ${facts.join("; ")}. You can review or change these in the Memory control center.`;
  }

  if (/^remember\b/.test(normalized)) {
    return "I can save that as long-term memory. The memory service will show the exact fact and its category so you remain in control.";
  }

  if (/^(forget|delete|remove)\b/.test(normalized)) {
    return "I found a memory-management request. I'll show the matching memories and ask for confirmation before anything is removed.";
  }

  if (/schedul|appointment|calendar/.test(normalized)) {
    return "I've prepared the scheduling request. Please review the attendee, date, time zone, and meeting details before I place it on the calendar.";
  }

  if (/outreach|follow[- ]?up|lead/.test(normalized)) {
    return "I've prepared the outreach action and kept it in draft. Sending or contacting a lead will require your approval.";
  }

  const memoryNote = input.memories?.length
    ? ` I used ${input.memories.length} relevant saved ${input.memories.length === 1 ? "memory" : "memories"} as context.`
    : "";
  return `MRE test provider received the request.${memoryNote} You asked: "${question || "How can I help?"}"`;
}

function abortablePause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class MockLanguageModelProvider implements LanguageModelProvider {
  readonly name = "mock";

  constructor(private readonly chunkDelayMs = 8) {}

  async *streamResponse(input: AIRequest): AsyncIterable<AIChunk> {
    throwIfAborted(input.signal, this.name);
    yield { type: "activity", label: "Running test intelligence" };

    for (const token of testAnswer(input).match(/\S+\s*/g) ?? []) {
      throwIfAborted(input.signal, this.name);
      try {
        await abortablePause(this.chunkDelayMs, input.signal);
      } catch (error) {
        throwIfAborted(input.signal, this.name);
        throw error;
      }
      yield { type: "text", text: token };
    }

    yield { type: "done", finishReason: "stop" };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { available: true, provider: this.name, detail: "Automated-test provider" };
  }
}
