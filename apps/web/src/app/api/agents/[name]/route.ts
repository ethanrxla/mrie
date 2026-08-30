import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { ApiError, jsonError, noStoreJson } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({ paused: z.boolean() });
type RouteContext = { params: Promise<{ name: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const { name: rawName } = await context.params;
    const name = decodeURIComponent(rawName);
    if (!name.trim() || name.length > 160) throw new ApiError(404, "Agent not found.", "not_found");
    const input = schema.parse(await request.json());
    const store = await getStore();
    const history = (await store.listAgentRuns(user.id))
      .filter((run) => run.agentName === name)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (!history.length) throw new ApiError(404, "Agent not found.", "not_found");
    await store.upsertPreference(user.id, `agent.paused.${name}`, input.paused);
    const current = history.find((run) => ["running", "queued", "waiting_approval"].includes(run.status));
    return noStoreJson({
      name,
      paused: input.paused,
      status: input.paused ? "paused" : (current?.status ?? history[0].status),
    });
  } catch (error) {
    return jsonError(error);
  }
}
