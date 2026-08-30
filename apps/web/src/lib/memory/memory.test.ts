import { describe, expect, it } from "vitest";

import type { MemoryItem } from "@/lib/data/types";
import { interpretMemoryCommand } from "@/lib/memory/commands";
import { inspectMemoryPolicy } from "@/lib/memory/policy";
import { rankMemories } from "@/lib/memory/ranking";

const baseMemory = (changes: Partial<MemoryItem>): MemoryItem => ({
  id: crypto.randomUUID(),
  userId: "user-1",
  memoryType: "semantic",
  title: "Business context",
  content: "General business information",
  importanceScore: 0.6,
  confidenceScore: 0.9,
  isPinned: false,
  accessCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...changes,
});

describe("memory privacy and commands", () => {
  it("recognizes explicit commands without treating casual facts as consent", () => {
    expect(interpretMemoryCommand("Remember that Growth clients receive priority support")).toMatchObject({
      kind: "remember",
      content: "Growth clients receive priority support",
    });
    expect(interpretMemoryCommand("MRE, remember that spoken responses are preferred")).toMatchObject({
      kind: "remember",
      content: "spoken responses are preferred",
    });
    expect(interpretMemoryCommand("Growth clients receive priority support")).toEqual({ kind: "none" });
    expect(interpretMemoryCommand("Forget everything")).toMatchObject({ kind: "forget", scope: "all" });
  });

  it.each([
    ["password is super-secret-value", "authentication-secret"],
    ["api_key: sk-this-is-a-secret-token-value", "authentication-secret"],
    ["-----BEGIN PRIVATE KEY-----", "private-key"],
    ["My diagnosis is a medical condition", "medical-information"],
  ])("blocks sensitive long-term memory: %s", (content, category) => {
    const result = inspectMemoryPolicy(content);
    expect(result.allowed).toBe(false);
    expect(result.blockedCategories).toContain(category);
  });
});

describe("memory ranking", () => {
  it("returns relevant facts ahead of pinned but unrelated facts", () => {
    const results = rankMemories(
      [
        baseMemory({ id: "pricing", title: "Growth pricing", content: "Growth plan costs 499 monthly" }),
        baseMemory({ id: "unrelated", title: "Office color", content: "The office wall is blue", isPinned: true }),
      ],
      "What is Growth pricing?",
      { now: new Date("2026-01-02T00:00:00.000Z") },
    );
    expect(results.map((item) => item.memory.id)).toEqual(["pricing"]);
  });
});
