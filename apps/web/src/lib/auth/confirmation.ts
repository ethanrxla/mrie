import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";

const ephemeralSecret = randomBytes(32).toString("base64url");

export interface ConfirmationClaims {
  userId: string;
  action: string;
  subjectId: string;
  approvalId?: string;
  argumentsHash?: string;
  expiresAt: number;
  nonce: string;
}

function secret(): string {
  return getEnv().AUTH_SECRET ?? ephemeralSecret;
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function issueConfirmationToken(
  claims: Omit<ConfirmationClaims, "expiresAt" | "nonce">,
  ttlSeconds = 300,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...claims,
      expiresAt: Date.now() + ttlSeconds * 1_000,
      nonce: randomBytes(16).toString("base64url"),
    } satisfies ConfirmationClaims),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyConfirmationToken(
  token: string,
  expected: Pick<ConfirmationClaims, "userId" | "action" | "subjectId"> &
    Partial<Pick<ConfirmationClaims, "approvalId" | "argumentsHash">>,
): ConfirmationClaims {
  const parts = token.split(".");
  if (parts.length !== 2) throw invalidConfirmation();
  const [payload, signature] = parts;
  if (!payload || !signature) throw invalidConfirmation();
  const actual = Buffer.from(signature);
  const calculated = Buffer.from(sign(payload));
  if (actual.length !== calculated.length || !timingSafeEqual(actual, calculated)) {
    throw invalidConfirmation();
  }
  let claims: ConfirmationClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ConfirmationClaims;
  } catch {
    throw invalidConfirmation();
  }
  if (
    !Number.isFinite(claims.expiresAt) ||
    typeof claims.nonce !== "string" ||
    !claims.nonce ||
    claims.expiresAt <= Date.now() ||
    claims.userId !== expected.userId ||
    claims.action !== expected.action ||
    claims.subjectId !== expected.subjectId ||
    (expected.approvalId !== undefined && claims.approvalId !== expected.approvalId) ||
    (expected.argumentsHash !== undefined && claims.argumentsHash !== expected.argumentsHash)
  ) {
    throw invalidConfirmation();
  }
  return claims;
}

export function hashConfirmationArguments(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Confirmation arguments must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Confirmation arguments must be JSON-compatible");
}

function invalidConfirmation(): ApiError {
  return new ApiError(
    409,
    "This confirmation is invalid or expired. Review the action again.",
    "confirmation_invalid",
  );
}
