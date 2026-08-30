import type { DataStore, MemoryItem, MemoryType, NewMemoryItem } from "@/lib/data/types";

import { interpretMemoryCommand, type MemoryCommand } from "./commands";
import { assertMemoryAllowed, inspectMemoryPolicy, MemoryPolicyError } from "./policy";
import { rankMemories, type MemorySearchOptions, type RankedMemory } from "./ranking";

export interface MemoryCandidate {
  item: NewMemoryItem;
  reason: "explicit-request" | "stable-business-fact" | "stable-profile-fact" | "meaningful-outcome";
  requiresReview: true;
}

export interface MemoryCommandOptions {
  confirmedIds?: string[];
  sourceMessageId?: string;
}

export type MemoryCommandResult =
  | { status: "ignored"; command: Extract<MemoryCommand, { kind: "none" }> }
  | { status: "suppressed"; command: Extract<MemoryCommand, { kind: "suppress" }> }
  | { status: "created"; command: Extract<MemoryCommand, { kind: "remember" }>; memory: MemoryItem }
  | { status: "found"; command: Extract<MemoryCommand, { kind: "inspect" }>; memories: MemoryItem[] }
  | { status: "needs-input"; command: MemoryCommand; message: string }
  | { status: "needs-confirmation"; command: MemoryCommand; memories: MemoryItem[] }
  | { status: "deleted"; command: Extract<MemoryCommand, { kind: "forget" }>; deletedIds: string[] }
  | { status: "updated"; command: Extract<MemoryCommand, { kind: "correct" }>; memory: MemoryItem }
  | {
      status: "rejected";
      command: MemoryCommand;
      message: string;
      blockedCategories: string[];
    };

export interface MemoryServiceContract {
  search(userId: string, query: string, options?: MemorySearchOptions): Promise<MemoryItem[]>;
  searchWithScores(userId: string, query: string, options?: MemorySearchOptions): Promise<RankedMemory[]>;
  create(userId: string, item: NewMemoryItem): Promise<MemoryItem>;
  update(userId: string, memoryId: string, changes: Partial<MemoryItem>): Promise<MemoryItem>;
  delete(userId: string, memoryId: string): Promise<void>;
  interpret(input: string): MemoryCommand;
  proposeFromExchange(userMessage: string, assistantMessage?: string, sourceMessageId?: string): MemoryCandidate | null;
  executeCommand(userId: string, input: string, options?: MemoryCommandOptions): Promise<MemoryCommandResult>;
}

function clampScore(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function cleanContent(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function memoryTitle(content: string, type: MemoryType): string {
  const prefix = type === "profile" ? "Profile" : type === "episodic" ? "Outcome" : "Business fact";
  const excerpt = content.replace(/[.!?]+$/, "").slice(0, 64);
  return excerpt.length < content.length ? `${prefix}: ${excerpt}…` : `${prefix}: ${excerpt}`;
}

function inferredType(content: string): MemoryType {
  if (/\b(?:my name|call me|i prefer|my role|i work|my time ?zone|address me as)\b/i.test(content)) return "profile";
  if (/\b(?:we decided|we agreed|completed|launched|meeting|appointment|outcome)\b/i.test(content)) return "episodic";
  return "semantic";
}

function statementContaining(input: string, pattern: RegExp): string | undefined {
  return input
    .split(/(?<=[.!?])\s+/)
    .map(cleanContent)
    .find((sentence) => pattern.test(sentence));
}

export class MemoryService implements MemoryServiceContract {
  constructor(private readonly store: DataStore) {}

  async search(userId: string, query: string, options: MemorySearchOptions = {}): Promise<MemoryItem[]> {
    return (await this.searchWithScores(userId, query, options)).map((result) => result.memory);
  }

  async searchWithScores(
    userId: string,
    query: string,
    options: MemorySearchOptions = {},
  ): Promise<RankedMemory[]> {
    const ranked = rankMemories(await this.store.listMemories(userId), query, options);
    if (options.touch !== false && ranked.length) {
      const accessedAt = (options.now ?? new Date()).toISOString();
      await Promise.allSettled(
        ranked.map(({ memory }) =>
          this.store.updateMemory(userId, memory.id, {
            accessCount: memory.accessCount + 1,
            lastAccessedAt: accessedAt,
          }),
        ),
      );
    }
    return ranked;
  }

  async create(userId: string, item: NewMemoryItem): Promise<MemoryItem> {
    const content = cleanContent(item.content);
    const title = cleanContent(item.title);
    if (!content || !title) throw new Error("Memory title and content are required");
    assertMemoryAllowed(`${title}\n${content}`);
    return this.store.createMemory(userId, {
      ...item,
      title,
      content,
      importanceScore: clampScore(item.importanceScore, 0.6),
      confidenceScore: clampScore(item.confidenceScore, 0.85),
      isPinned: item.isPinned ?? false,
    });
  }

  async update(userId: string, memoryId: string, changes: Partial<MemoryItem>): Promise<MemoryItem> {
    const safeChanges = { ...changes };
    if (typeof safeChanges.title === "string") safeChanges.title = cleanContent(safeChanges.title);
    if (typeof safeChanges.content === "string") safeChanges.content = cleanContent(safeChanges.content);
    if (safeChanges.title || safeChanges.content) {
      assertMemoryAllowed(`${safeChanges.title ?? ""}\n${safeChanges.content ?? ""}`);
    }
    if (safeChanges.importanceScore !== undefined) {
      safeChanges.importanceScore = clampScore(safeChanges.importanceScore, 0.6);
    }
    if (safeChanges.confidenceScore !== undefined) {
      safeChanges.confidenceScore = clampScore(safeChanges.confidenceScore, 0.85);
    }
    return this.store.updateMemory(userId, memoryId, safeChanges);
  }

  delete(userId: string, memoryId: string): Promise<void> {
    return this.store.deleteMemory(userId, memoryId);
  }

  interpret(input: string): MemoryCommand {
    return interpretMemoryCommand(input);
  }

  proposeFromExchange(
    userMessage: string,
    assistantMessage?: string,
    sourceMessageId?: string,
  ): MemoryCandidate | null {
    const command = interpretMemoryCommand(userMessage);
    let content: string | undefined;
    let reason: MemoryCandidate["reason"];

    if (command.kind === "suppress") return null;
    if (command.kind === "remember") {
      content = command.content;
      reason = "explicit-request";
    } else {
      const profilePattern = /\b(?:my name is|call me|i prefer|my role is|i work (?:as|at|for)|my time ?zone is|address me as)\b/i;
      const businessPattern = /\b(?:our company|our product|our pricing|clients? (?:receive|must|should)|standard operating procedure|\bSOP\b)\b/i;
      const outcomePattern = /\b(?:we decided|we agreed|we completed|we launched|the outcome was)\b/i;
      content = statementContaining(userMessage, profilePattern);
      reason = "stable-profile-fact";
      if (!content) {
        content = statementContaining(userMessage, businessPattern);
        reason = "stable-business-fact";
      }
      if (!content) {
        content = statementContaining(`${userMessage} ${assistantMessage ?? ""}`, outcomePattern);
        reason = "meaningful-outcome";
      }
    }

    if (!content) return null;
    content = cleanContent(content);
    const policy = inspectMemoryPolicy(content);
    if (!policy.allowed) return null;
    const memoryType = inferredType(content);
    return {
      item: {
        memoryType,
        title: memoryTitle(content, memoryType),
        content,
        importanceScore: reason === "explicit-request" ? 0.75 : 0.6,
        confidenceScore: reason === "explicit-request" ? 1 : 0.82,
        sourceMessageId,
      },
      reason,
      requiresReview: true,
    };
  }

  async executeCommand(
    userId: string,
    input: string,
    options: MemoryCommandOptions = {},
  ): Promise<MemoryCommandResult> {
    const command = interpretMemoryCommand(input);
    if (command.kind === "none") return { status: "ignored", command };
    if (command.kind === "suppress") return { status: "suppressed", command };

    if (command.kind === "remember") {
      if (!command.content) {
        return { status: "needs-input", command, message: "Tell me the exact fact you want remembered." };
      }
      const content = cleanContent(command.content);
      const memoryType = inferredType(content);
      try {
        const memory = await this.create(userId, {
          memoryType,
          title: memoryTitle(content, memoryType),
          content,
          importanceScore: 0.75,
          confidenceScore: 1,
          sourceMessageId: options.sourceMessageId,
        });
        return { status: "created", command, memory };
      } catch (error) {
        if (error instanceof MemoryPolicyError) {
          return {
            status: "rejected",
            command,
            message: "For your safety, MRE does not store secrets, payment details, identifiers, or medical information.",
            blockedCategories: error.blockedCategories,
          };
        }
        throw error;
      }
    }

    if (command.kind === "inspect") {
      return {
        status: "found",
        command,
        memories: await this.search(userId, command.query ?? "", { limit: 50, touch: false }),
      };
    }

    const candidates = command.kind === "forget" && command.scope === "all"
      ? await this.store.listMemories(userId)
      : command.query
        ? await this.search(userId, command.query, { limit: 50, touch: false })
        : [];

    if (!command.query && !(command.kind === "forget" && command.scope === "all")) {
      return {
        status: "needs-input",
        command,
        message: command.kind === "forget"
          ? "Which memory should I forget?"
          : "Which memory should I correct?",
      };
    }
    if (!candidates.length) {
      return { status: "needs-input", command, message: "I could not find a matching memory." };
    }

    const confirmed = new Set(options.confirmedIds ?? []);
    const candidateIds = new Set(candidates.map((memory) => memory.id));
    const exactConfirmedIds = [...confirmed].filter((id) => candidateIds.has(id));
    if (!exactConfirmedIds.length) {
      return { status: "needs-confirmation", command, memories: candidates };
    }

    if (command.kind === "forget") {
      await Promise.all(exactConfirmedIds.map((id) => this.delete(userId, id)));
      return { status: "deleted", command, deletedIds: exactConfirmedIds };
    }

    if (!command.replacement) {
      return {
        status: "needs-input",
        command,
        message: "Provide the corrected fact before updating this memory.",
      };
    }
    if (exactConfirmedIds.length !== 1) {
      return {
        status: "needs-confirmation",
        command,
        memories: candidates,
      };
    }
    try {
      const memory = await this.update(userId, exactConfirmedIds[0], {
        content: command.replacement,
        confidenceScore: 1,
      });
      return { status: "updated", command, memory };
    } catch (error) {
      if (error instanceof MemoryPolicyError) {
        return {
          status: "rejected",
          command,
          message: "For your safety, MRE does not store secrets, payment details, identifiers, or medical information.",
          blockedCategories: error.blockedCategories,
        };
      }
      throw error;
    }
  }
}
