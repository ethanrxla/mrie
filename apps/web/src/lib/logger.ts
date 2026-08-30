import { getEnv } from "@/lib/env";

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const levelOrder: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const secretKeyPattern = /authorization|cookie|password|secret|token|api[-_]?key/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth-limited]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Fields).map(([key, item]) => [
        key,
        secretKeyPattern.test(key) ? "[redacted]" : sanitize(item, depth + 1),
      ]),
    );
  }
  if (typeof value === "string") return value.slice(0, 4_000);
  return value;
}

function write(level: Level, message: string, fields: Fields = {}): void {
  const configured = getEnv().LOG_LEVEL;
  if (levelOrder[level] < levelOrder[configured]) return;
  const safeFields = sanitize(fields) as Fields;
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...safeFields,
  });
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.log(record);
}

export const logger = {
  debug: (message: string, fields?: Fields) => write("debug", message, fields),
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};
