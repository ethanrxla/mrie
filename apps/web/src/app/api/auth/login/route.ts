import { z } from "zod";

import { assertSameOrigin, createSession } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { getStore } from "@/lib/data";
import { ApiError, jsonError, noStoreJson } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";

const schema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
});

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
    enforceRateLimit(`login:${ip}`, { limit: 10, windowMs: 15 * 60_000 });
    const input = schema.parse(await request.json());
    const user = await (await getStore()).findUserByEmail(input.email);
    if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new ApiError(401, "Email or password is incorrect.", "invalid_credentials");
    }
    await createSession(user.id);
    return noStoreJson({ ok: true, user: { id: user.id, displayName: user.displayName } });
  } catch (error) {
    return jsonError(error);
  }
}
