import { createHash } from "node:crypto";
import { z } from "zod";

import { issueConfirmationToken, verifyConfirmationToken } from "@/lib/auth/confirmation";
import { assertSameOrigin } from "@/lib/auth/session";
import { requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { ApiError, jsonError, noStoreJson } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const schema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).optional(),
  scheduleExpression: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(80),
  nextRunAt: z.string().datetime().optional(),
  confirmed: z.boolean().default(false),
  confirmationToken: z.string().min(40).max(2_000).optional(),
});

export async function GET() {
  try {
    const user = await requireUser();
    return noStoreJson({ appointments: await (await getStore()).listScheduledTasks(user.id) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    enforceRateLimit(`schedule-create:${user.id}`, { limit: 20, windowMs: 60_000 });
    const input = schema.parse(await request.json());
    if (input.nextRunAt && Date.parse(input.nextRunAt) <= Date.now()) {
      throw new ApiError(400, "Choose a future appointment time.", "appointment_in_past");
    }
    const normalized = JSON.stringify({
      title: input.title,
      description: input.description,
      scheduleExpression: input.scheduleExpression,
      timezone: input.timezone,
      nextRunAt: input.nextRunAt,
    });
    const subjectId = createHash("sha256").update(normalized).digest("hex");
    if (!input.confirmed || !input.confirmationToken) {
      return noStoreJson(
        {
          requiresConfirmation: true,
          confirmation: {
            token: issueConfirmationToken({ userId: user.id, action: "schedule.create", subjectId }),
            title: `Schedule ${input.title}?`,
            detail: `${input.scheduleExpression} (${input.timezone})`,
            expiresInSeconds: 300,
          },
        },
        { status: 202 },
      );
    }
    verifyConfirmationToken(input.confirmationToken, {
      userId: user.id,
      action: "schedule.create",
      subjectId,
    });
    const appointment = await (await getStore()).createScheduledTask(user.id, {
      title: input.title,
      description: input.description,
      scheduleExpression: input.scheduleExpression,
      timezone: input.timezone,
      nextRunAt: input.nextRunAt,
    });
    return noStoreJson({ appointment }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
