import { ApiError } from "@/lib/http";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function enforceRateLimit(
  key: string,
  options: { limit: number; windowMs: number },
): void {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return;
  }
  if (existing.count >= options.limit) {
    throw new ApiError(429, "Too many requests. Please wait a moment and retry.", "rate_limited");
  }
  existing.count += 1;
}

export function clearRateLimitsForTests(): void {
  buckets.clear();
}
