import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError, noStoreJson } from "@/lib/http";
import { MemoryPolicyError, MemoryService } from "@/lib/memory";

export const runtime = "nodejs";

const createSchema = z.object({
  memoryType: z.enum(["profile", "semantic", "episodic"]),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(10_000),
  importanceScore: z.number().min(0).max(1).optional(),
  confidenceScore: z.number().min(0).max(1).optional(),
  isPinned: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  sourceMessageId: z.string().uuid().optional(),
});

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim().toLocaleLowerCase() ?? "";
    const type = url.searchParams.get("type");
    const memories = (await (await getStore()).listMemories(user.id)).filter(
      (memory) =>
        (!query || `${memory.title} ${memory.content}`.toLocaleLowerCase().includes(query)) &&
        (!type || type === "all" || memory.memoryType === type),
    );
    return noStoreJson({ memories });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const input = createSchema.parse(await request.json());
    const memory = await new MemoryService(await getStore()).create(user.id, {
      ...input,
      expiresAt: input.expiresAt ?? undefined,
    });
    return noStoreJson({ memory }, { status: 201 });
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

export async function DELETE(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const deleted = await (await getStore()).deleteAllMemories(user.id);
    return noStoreJson({ deleted });
  } catch (error) {
    return jsonError(error);
  }
}
