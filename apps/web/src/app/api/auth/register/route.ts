import { z } from "zod";

import { hashPassword } from "@/lib/auth/password";
import { assertSameOrigin, createSession } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { getEnv } from "@/lib/env";
import { ApiError, jsonError, noStoreJson } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";

const schema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().trim().min(2).max(100),
  timezone: z.string().trim().min(1).max(80).default("America/New_York"),
  password: z
    .string()
    .min(12)
    .max(200)
    .regex(/[a-z]/, "Include a lowercase letter")
    .regex(/[A-Z]/, "Include an uppercase letter")
    .regex(/[0-9]/, "Include a number"),
});

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    if (!getEnv().ALLOW_REGISTRATION) {
      throw new ApiError(403, "Self-service registration is disabled.", "registration_disabled");
    }
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
    enforceRateLimit(`register:${ip}`, { limit: 5, windowMs: 60 * 60_000 });
    const input = schema.parse(await request.json());
    const user = await (await getStore()).createUser({
      email: input.email,
      displayName: input.displayName,
      timezone: input.timezone,
      passwordHash: await hashPassword(input.password),
    });
    await createSession(user.id);
    return noStoreJson({ ok: true, user: { id: user.id, displayName: user.displayName } }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
