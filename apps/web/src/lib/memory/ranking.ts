import type { MemoryItem, MemoryType } from "@/lib/data/types";

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "by", "did", "do", "for", "from",
  "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "that", "the", "this",
  "to", "was", "we", "what", "when", "where", "who", "with", "you",
]);

export interface MemoryRankComponents {
  relevance: number;
  importance: number;
  recency: number;
  pinned: number;
  confidence: number;
  frequency: number;
}

export interface RankedMemory {
  memory: MemoryItem;
  score: number;
  components: MemoryRankComponents;
}

export interface MemorySearchOptions {
  limit?: number;
  types?: MemoryType[];
  pinnedOnly?: boolean;
  minimumScore?: number;
  touch?: boolean;
  now?: Date;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function normalized(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: string): string[] {
  return normalized(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map(stem);
}

function coverage(queryTokens: string[], candidate: string): number {
  if (!queryTokens.length) return 0;
  const uniqueQueryTokens = [...new Set(queryTokens)];
  const candidateTokens = new Set(tokens(candidate));
  return uniqueQueryTokens.filter((token) => candidateTokens.has(token)).length / uniqueQueryTokens.length;
}

export function lexicalRelevance(query: string, memory: MemoryItem): number {
  const queryText = normalized(query);
  const queryTokens = tokens(query);
  if (!queryText || !queryTokens.length) return 0.5;

  const titleCoverage = coverage(queryTokens, memory.title);
  const bodyCoverage = coverage(queryTokens, memory.content);
  const candidateText = normalized(`${memory.title} ${memory.content}`);
  const phraseMatch = candidateText.includes(queryText) || queryText.includes(normalized(memory.title)) ? 1 : 0;
  return clamp(bodyCoverage * 0.62 + titleCoverage * 0.28 + phraseMatch * 0.1);
}

export function rankMemory(memory: MemoryItem, query: string, now = new Date()): RankedMemory {
  const anchor = Date.parse(memory.lastAccessedAt ?? memory.updatedAt ?? memory.createdAt);
  const ageDays = Number.isFinite(anchor) ? Math.max(0, (now.getTime() - anchor) / 86_400_000) : 365;
  const components: MemoryRankComponents = {
    relevance: lexicalRelevance(query, memory),
    importance: clamp(memory.importanceScore),
    recency: Math.exp(-ageDays / 120),
    pinned: memory.isPinned ? 1 : 0,
    confidence: clamp(memory.confidenceScore),
    frequency: 1 - Math.exp(-Math.max(0, memory.accessCount) / 6),
  };
  const score =
    components.relevance * 0.45 +
    components.pinned * 0.18 +
    components.importance * 0.14 +
    components.recency * 0.09 +
    components.confidence * 0.09 +
    components.frequency * 0.05;
  return { memory, score: Math.round(score * 10_000) / 10_000, components };
}

export function rankMemories(
  memories: MemoryItem[],
  query: string,
  options: MemorySearchOptions = {},
): RankedMemory[] {
  const now = options.now ?? new Date();
  const expirationBoundary = now.getTime();
  const normalizedQuery = normalized(query);
  return memories
    .filter((memory) => !memory.expiresAt || Date.parse(memory.expiresAt) > expirationBoundary)
    .filter((memory) => !options.types?.length || options.types.includes(memory.memoryType))
    .filter((memory) => !options.pinnedOnly || memory.isPinned)
    .map((memory) => rankMemory(memory, query, now))
    // Pinned status increases trustworthy matches; it never makes unrelated content relevant.
    .filter((ranked) => !normalizedQuery || ranked.components.relevance > 0)
    .filter((ranked) => ranked.score >= (options.minimumScore ?? 0))
    .sort((left, right) => right.score - left.score || Date.parse(right.memory.updatedAt) - Date.parse(left.memory.updatedAt))
    .slice(0, Math.max(1, Math.min(options.limit ?? 8, 50)));
}
