import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError, noStoreJson } from "@/lib/http";
import { MemoryService } from "@/lib/memory";

export const runtime = "nodejs";

const schema = z.object({
  command: z.string().trim().min(1).max(10_000),
  confirmedIds: z.array(z.string().uuid()).max(100),
});

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const input = schema.parse(await request.json());
    const result = await new MemoryService(await getStore()).executeCommand(user.id, input.command, {
      confirmedIds: input.confirmedIds,
    });
    return noStoreJson({ result });
  } catch (error) {
    return jsonError(error);
  }
}
