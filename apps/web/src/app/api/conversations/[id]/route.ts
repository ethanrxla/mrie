import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { ApiError, jsonError, noStoreJson } from "@/lib/http";

export const runtime = "nodejs";

const updateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().max(4_000).nullable().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const store = await getStore();
    const conversation = await store.findConversation(user.id, id);
    if (!conversation) throw new ApiError(404, "Conversation not found.", "not_found");
    const messages = await store.listMessages(user.id, id);
    return noStoreJson({ conversation, messages });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    const input = updateSchema.parse(await request.json());
    const changes = { ...input } as Omit<typeof input, "summary"> & { summary?: string };
    if (Object.prototype.hasOwnProperty.call(input, "summary")) {
      changes.summary = input.summary ?? undefined;
    }
    const conversation = await (await getStore()).updateConversation(user.id, id, changes);
    return noStoreJson({ conversation });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    const conversation = await (await getStore()).updateConversation(user.id, id, {
      archivedAt: new Date().toISOString(),
    });
    return noStoreJson({ archived: true, conversation });
  } catch (error) {
    return jsonError(error);
  }
}
