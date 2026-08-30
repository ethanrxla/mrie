import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError, noStoreJson } from "@/lib/http";

export const runtime = "nodejs";

const createSchema = z.object({ title: z.string().trim().min(1).max(120).optional() });

export async function GET() {
  try {
    const user = await requireUser();
    const conversations = await (await getStore()).listConversations(user.id);
    return noStoreJson({ conversations });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const input = createSchema.parse(await request.json().catch(() => ({})));
    const conversation = await (await getStore()).createConversation(user.id, input.title);
    return noStoreJson({ conversation }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const deleted = await (await getStore()).deleteAllConversations(user.id);
    return noStoreJson({ deleted });
  } catch (error) {
    return jsonError(error);
  }
}
