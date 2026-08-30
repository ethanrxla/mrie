import { z } from "zod";

import { assertSameOrigin } from "@/lib/auth/session";
import { requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError, noStoreJson } from "@/lib/http";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).optional(),
  triggerConfig: z.record(z.string(), z.unknown()),
  steps: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
});

export async function GET() {
  try {
    const user = await requireUser();
    return noStoreJson({ automations: await (await getStore()).listAutomations(user.id) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const input = createSchema.parse(await request.json());
    const automation = await (await getStore()).createAutomation(user.id, {
      ...input,
      status: "paused",
    });
    return noStoreJson({ automation }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
