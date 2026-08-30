import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError, noStoreJson } from "@/lib/http";
import { MemoryPolicyError, MemoryService } from "@/lib/memory";

export const runtime = "nodejs";

const updateSchema = z.object({
  memoryType: z.enum(["profile", "semantic", "episodic"]).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  content: z.string().trim().min(1).max(10_000).optional(),
  importanceScore: z.number().min(0).max(1).optional(),
  confidenceScore: z.number().min(0).max(1).optional(),
  isPinned: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    const input = updateSchema.parse(await request.json());
    const changes = { ...input } as Omit<typeof input, "expiresAt"> & { expiresAt?: string };
    if (Object.prototype.hasOwnProperty.call(input, "expiresAt")) {
      changes.expiresAt = input.expiresAt ?? undefined;
    }
    const memory = await new MemoryService(await getStore()).update(user.id, id, changes);
    return noStoreJson({ memory });
  } catch (error) {
    if (error instanceof MemoryPolicyError) {
      return noStoreJson(
        {
          error: {
            code: "sensitive_memory_rejected",
            message: "MRE does not store secrets, payment details, identifiers, or medical information.",
            categories: error.blockedCategories,
          },
        },
        { status: 422 },
      );
    }
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    await (await getStore()).deleteMemory(user.id, id);
    return noStoreJson({ deleted: true });
  } catch (error) {
    return jsonError(error);
  }
}
