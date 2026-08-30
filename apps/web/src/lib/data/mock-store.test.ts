import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LocalDatabase } from "@/lib/data/local-data";
import { MockStore } from "@/lib/data/mock-store";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStore(): Promise<{ filePath: string; store: MockStore }> {
  const directory = await mkdtemp(path.join(tmpdir(), "mre-store-test-"));
  cleanup.push(directory);
  const filePath = path.join(directory, "store.json");
  return { filePath, store: new MockStore(filePath) };
}

describe("MockStore privacy and onboarding operations", () => {
  it("completes onboarding with its profile and preferences in one operation", async () => {
    const { store } = await createStore();
    const user = await store.createUser({
      email: "new-operator@example.com",
      displayName: "New Operator",
      timezone: "UTC",
    });

    const completion = await store.completeOnboarding(user.id, {
      profile: {
        displayName: "Taylor Morgan",
        preferredName: "Taylor",
        timezone: "America/New_York",
      },
      preferences: [
        { key: "memory.autoSave", value: false },
        { key: "voice.handsFree", value: true },
      ],
    });

    expect(completion.user).toMatchObject({
      displayName: "Taylor Morgan",
      preferredName: "Taylor",
      timezone: "America/New_York",
    });
    expect(completion.user.onboardingCompletedAt).toBeTruthy();
    expect(completion.preferences).toHaveLength(2);
    expect(await store.listPreferences(user.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "memory.autoSave", value: false }),
        expect.objectContaining({ key: "voice.handsFree", value: true }),
      ]),
    );

    const repeated = await store.completeOnboarding(user.id, {
      profile: {
        displayName: "Taylor Morgan",
        preferredName: "Taylor",
        timezone: "America/New_York",
      },
      preferences: [{ key: "memory.autoSave", value: true }],
    });
    expect(repeated.preferences).toHaveLength(1);
    expect((await store.listPreferences(user.id)).filter((item) => item.key === "memory.autoSave"))
      .toEqual([expect.objectContaining({ value: true })]);
  });

  it("hard-deletes all of one user's conversations and cascades mock messages", async () => {
    const { filePath, store } = await createStore();
    const target = await store.findUserByEmail("operator@mre.local");
    const survivor = await store.createUser({
      email: "survivor@example.com",
      displayName: "Survivor",
      timezone: "UTC",
    });
    const survivorConversation = await store.createConversation(survivor.id, "Keep this");
    await store.createMessage(survivor.id, {
      conversationId: survivorConversation.id,
      role: "user",
      content: "This message belongs to another user.",
      sources: [],
      memoryIds: [],
      toolActivity: [],
    });
    const archived = await store.createConversation(target!.id, "Archived but still private");
    await store.createMessage(target!.id, {
      conversationId: archived.id,
      role: "user",
      content: "Delete this archived transcript too.",
      sources: [],
      memoryIds: [],
      toolActivity: [],
    });
    await store.updateConversation(target!.id, archived.id, {
      archivedAt: new Date().toISOString(),
    });

    const before = JSON.parse(await readFile(filePath, "utf8")) as LocalDatabase;
    const targetConversationIds = new Set(
      before.conversations.filter((item) => item.userId === target!.id).map((item) => item.id),
    );
    const deleted = await store.deleteAllConversations(target!.id);
    const after = JSON.parse(await readFile(filePath, "utf8")) as LocalDatabase;

    expect(deleted).toBe(targetConversationIds.size);
    expect(after.conversations.some((item) => item.userId === target!.id)).toBe(false);
    expect(after.messages.some((item) => targetConversationIds.has(item.conversationId))).toBe(false);
    expect(after.conversations).toContainEqual(expect.objectContaining({ id: survivorConversation.id }));
    expect(after.messages).toContainEqual(
      expect.objectContaining({ conversationId: survivorConversation.id }),
    );
  });

  it("hard-deletes every memory for the user, including expired records", async () => {
    const { filePath, store } = await createStore();
    const target = await store.findUserByEmail("operator@mre.local");
    const survivor = await store.createUser({
      email: "memory-survivor@example.com",
      displayName: "Memory Survivor",
      timezone: "UTC",
    });
    await store.createMemory(target!.id, {
      memoryType: "episodic",
      title: "Expired private fact",
      content: "This expired item must still be erased by clear all.",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const survivorMemory = await store.createMemory(survivor.id, {
      memoryType: "semantic",
      title: "Keep this memory",
      content: "This belongs to a different user.",
    });

    const before = JSON.parse(await readFile(filePath, "utf8")) as LocalDatabase;
    const targetCount = before.memories.filter((item) => item.userId === target!.id).length;
    expect(before.memories).toContainEqual(
      expect.objectContaining({ userId: target!.id, title: "Expired private fact" }),
    );

    const deleted = await store.deleteAllMemories(target!.id);
    const after = JSON.parse(await readFile(filePath, "utf8")) as LocalDatabase;

    expect(deleted).toBe(targetCount);
    expect(after.memories.some((item) => item.userId === target!.id)).toBe(false);
    expect(after.memories).toContainEqual(expect.objectContaining({ id: survivorMemory.id }));
  });
});
