import { z } from "zod";

import { AutomationRunApprovalService } from "@/lib/approvals/automation-run";
import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { ApiError, jsonError, noStoreJson } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const schema = z.object({
  confirmed: z.boolean().default(false),
  confirmationToken: z.string().min(40).max(2_000).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    enforceRateLimit(`automation-run:${user.id}`, { limit: 20, windowMs: 60_000 });
    const { id } = await context.params;
    const input = schema.parse(await request.json().catch(() => ({})));
    const store = await getStore();
    const automation = (await store.listAutomations(user.id)).find((item) => item.id === id);
    if (!automation) throw new ApiError(404, "Automation not found.", "not_found");
    const approvals = new AutomationRunApprovalService(store);

    if (!input.confirmed || !input.confirmationToken) {
      const prepared = await approvals.prepare(user.id, automation);
      return noStoreJson(
        {
          requiresConfirmation: true,
          confirmation: {
            token: prepared.token,
            title: prepared.title,
            detail: prepared.detail,
            scope: prepared.scope,
            expiresInSeconds: prepared.expiresInSeconds,
          },
        },
        { status: 202 },
      );
    }

    const consumed = await approvals.consume(user.id, automation, input.confirmationToken);
    return noStoreJson(
      {
        accepted: true,
        automation: consumed.automation,
        run: consumed.run,
        approvalId: consumed.approval.id,
        auditEventId: consumed.auditEvent.id,
      },
      { status: 202 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
