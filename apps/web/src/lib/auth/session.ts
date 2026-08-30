import { createHash, randomBytes } from "node:crypto";

import { cookies } from "next/headers";

import { getStore } from "@/lib/data";
import type { User } from "@/lib/data/types";
import { getEnv, isLocalMode } from "@/lib/env";
import { ApiError } from "@/lib/http";

export const SESSION_COOKIE = "xyn_session";
const SESSION_DAYS = 30;

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  const store = await getStore();
  await store.createSession(userId, hashSessionToken(token), expiresAt.toISOString());
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: getEnv().NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await (await getStore()).deleteSession(hashSessionToken(token));
  jar.delete(SESSION_COOKIE);
}

export async function getCurrentUser(): Promise<User | null> {
  const env = getEnv();
  const store = await getStore();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    const session = await store.findSession(hashSessionToken(token));
    if (session) return store.findUserById(session.userId);
  }
  if (isLocalMode(env)) {
    const existing = await store.findUserByEmail(env.LOCAL_USER_EMAIL);
    return (
      existing ??
      store.createUser({
        email: env.LOCAL_USER_EMAIL,
        displayName: "Operator",
        timezone: "America/New_York",
      })
    );
  }
  return null;
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, "Authentication is required.", "unauthenticated");
  return user;
}

export async function assertSameOrigin(request: Request): Promise<void> {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const configured = new URL(getEnv().NEXT_PUBLIC_APP_URL).origin;
  const requestOrigin = new URL(request.url).origin;
  if (origin !== configured && origin !== requestOrigin) {
    throw new ApiError(403, "The request origin is not allowed.", "invalid_origin");
  }
}
