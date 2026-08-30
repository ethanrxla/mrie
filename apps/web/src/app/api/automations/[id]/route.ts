import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError, noStoreJson } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2_000).optional(),
  status: z.enum(["queued", "running", "waiting_approval", "completed", "failed", "paused"]).optional(),
  triggerConfig: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    const automation = await (await getStore()).updateAutomation(
      user.id,
      id,
      schema.parse(await request.json()),
    );
    return noStoreJson({ automation });
  } catch (error) {
    return jsonError(error);
  }
}
