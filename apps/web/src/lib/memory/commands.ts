export type MemoryCommand =
  | { kind: "none" }
  | { kind: "remember"; content?: string }
  | { kind: "suppress" }
  | { kind: "inspect"; query?: string }
  | { kind: "forget"; query?: string; scope: "single" | "matching" | "all" }
  | { kind: "correct"; query?: string; replacement?: string };

function clean(value: string | undefined): string | undefined {
  const result = value?.trim().replace(/^[\s:;,.-]+|[\s]+$/g, "");
  return result || undefined;
}

function withoutCourtesyPrefix(input: string): string {
  return input
    .trim()
    // Accept MRE first; the retired names remain input aliases for old transcripts.
    .replace(/^(?:(?:please|(?:hey\s+)?(?:m\.?r\.?e\.?|m\.?r\.?i\.?e\.?|xyn))[,\s]+)+/i, "")
    .trim();
}

/**
 * Interpret only explicit memory imperatives. Ordinary conversation intentionally
 * returns `none` so application code cannot mistake a casual statement for consent.
 */
export function interpretMemoryCommand(input: string): MemoryCommand {
  const text = withoutCourtesyPrefix(input);

  if (/^(?:do not|don't|never) (?:save|store|remember)\b/i.test(text)) {
    return { kind: "suppress" };
  }

  let match = text.match(/^(?:remember|save (?:this|that)(?: as (?:a )?memory)?)(?: that| this)?\s*[:,-]?\s*(.*)$/i);
  if (match) return { kind: "remember", content: clean(match[1]) };

  match = text.match(/^(?:what do you remember(?: about (.+?))?|show (?:me )?(?:what you remember|my memor(?:y|ies))(?: about (.+?))?)[?!.]?$/i);
  if (match) return { kind: "inspect", query: clean(match[1] ?? match[2]) };

  if (/^(?:forget|delete|clear|remove) (?:all|everything)(?: you (?:know|remember))?[.!]?$/i.test(text)) {
    return { kind: "forget", scope: "all" };
  }

  match = text.match(/^(?:forget|delete|remove)(?: (?:the )?memor(?:y|ies))?(?: about| for)?\s*(.*)$/i);
  if (match) {
    const query = clean(match[1]);
    const contextual = query?.toLowerCase();
    return {
      kind: "forget",
      query: contextual === "that" || contextual === "this" || contextual === "it" ? undefined : query,
      scope: /^(?:all|everything)\b/i.test(query ?? "") ? "matching" : "single",
    };
  }

  match = text.match(/^(?:correct|update|change)(?: (?:the )?memor(?:y|ies))?(?: about| for)?\s*(.*)$/i);
  if (match) {
    const instruction = clean(match[1]);
    if (!instruction) return { kind: "correct" };
    const split = instruction.match(/^(.+?)\s+(?:to|with)\s+(.+)$/i);
    return {
      kind: "correct",
      query: clean(split?.[1] ?? instruction),
      replacement: clean(split?.[2]),
    };
  }

  return { kind: "none" };
}
