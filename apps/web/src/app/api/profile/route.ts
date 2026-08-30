import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError, noStoreJson } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
  displayName: z.string().trim().min(2).max(100).optional(),
  preferredName: z.string().trim().min(1).max(100).optional(),
  company: z.string().trim().max(160).optional(),
  roleTitle: z.string().trim().max(160).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  onboardingComplete: z.boolean().optional(),
});

export async function GET() {
  try {
    return noStoreJson({ user: await requireUser() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const { onboardingComplete, ...changes } = schema.parse(await request.json());
    const updated = await (await getStore()).updateUser(user.id, {
      ...changes,
      onboardingCompletedAt: onboardingComplete ? new Date().toISOString() : user.onboardingCompletedAt,
    });
    return noStoreJson({ user: updated });
  } catch (error) {
    return jsonError(error);
  }
}
