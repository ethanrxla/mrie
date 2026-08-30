import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatService, MRE_SYSTEM_PROMPT } from "@/lib/chat/service";
import { MockStore } from "@/lib/data/mock-store";
import { MockLanguageModelProvider } from "@/lib/providers/mock-language";

const temporaryDirectories: string[] = [];

it("defines MRE as the assistant and XynPrize as the company", () => {
  expect(MRE_SYSTEM_PROMPT).toContain("You are MRE");
  expect(MRE_SYSTEM_PROMPT).toContain("XynPrize Ltd. is the company brand, not the assistant");
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable chat flow", () => {
  it("persists both turns and explicit safe memory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mre-chat-test-"));
    temporaryDirectories.push(directory);
    const store = new MockStore(path.join(directory, "store.json"));
    const user = await store.findUserByEmail("operator@mre.local");
    expect(user).not.toBeNull();

    const service = new ChatService(store, new MockLanguageModelProvider(0));
    const prepared = await service.prepare(
      user!,
      "Remember that Growth clients receive priority support",
    );
    let answer = "";
    for await (const chunk of service.stream(prepared, user!)) {
      if (chunk.type === "text") answer += chunk.text;
    }
    await service.finish(prepared, answer);

    const messages = await store.listMessages(user!.id, prepared.conversation.id);
    const memories = await store.listMemories(user!.id);
    expect(messages.slice(-2).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(memories.some((memory) => memory.content.includes("Growth clients"))).toBe(true);
  });

  it("persists sanitized attachment data separately from visible message text", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mre-attachment-test-"));
    temporaryDirectories.push(directory);
    const store = new MockStore(path.join(directory, "store.json"));
    const user = await store.findUserByEmail("operator@mre.local");
    const service = new ChatService(store, new MockLanguageModelProvider(0));

    const prepared = await service.prepare(user!, "Summarize this brief.", undefined, [
      { name: "brief.md", mediaType: "text/markdown", size: 13, content: "Launch Friday" },
    ]);
    const messages = await store.listMessages(user!.id, prepared.conversation.id);

    expect(messages.at(-1)?.content).toBe("Summarize this brief.");
    expect(messages.at(-1)?.attachments).toEqual([
      { name: "brief.md", mediaType: "text/markdown", size: 13, content: "Launch Friday" },
    ]);
  });
});
