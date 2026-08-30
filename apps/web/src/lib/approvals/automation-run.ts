import "server-only";

import {
  issueConfirmationToken,
  verifyConfirmationToken,
} from "@/lib/auth/confirmation";
import type { ConfirmationClaims } from "@/lib/auth/confirmation";
import { automationRunArgumentsHash } from "@/lib/approvals/arguments";
import type {
  Automation,
  ConsumeAutomationRunApprovalResult,
  DataStore,
} from "@/lib/data/types";
import { ApiError } from "@/lib/http";

const ACTION = "automation.run" as const;
const APPROVAL_TTL_SECONDS = 300;
const DURABLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARGUMENTS_HASH = /^[A-Za-z0-9_-]{43}$/;

export class AutomationRunApprovalService {
  constructor(private readonly store: DataStore) {}

  async prepare(userId: string, automation: Automation) {
    this.assertOwned(userId, automation);
    this.assertRunnable(automation);
    const argumentsHash = automationRunArgumentsHash(automation);
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_SECONDS * 1_000).toISOString();
    const detail = automation.description ?? "This workflow may use connected business tools.";
    const scope = automation.steps
      .slice(0, 100)
      .map((step) => String(step.type ?? "workflow step").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200));
    const approval = await this.store.createAutomationRunApproval(userId, {
      automationId: automation.id,
      title: `Run ${automation.name}?`,
      detail,
      scope,
      argumentsHash,
      expiresAt,
    });
    const remainingSeconds = Math.max(
      1,
      Math.floor((Date.parse(approval.expiresAt) - Date.now()) / 1_000),
    );
    const token = issueConfirmationToken(
      {
        userId,
        action: ACTION,
        subjectId: automation.id,
        approvalId: approval.id,
        argumentsHash,
      },
      remainingSeconds,
    );
    return {
      approval,
      token,
      title: approval.title,
      detail: String(approval.detail.description ?? detail),
      scope: Array.isArray(approval.detail.scope)
        ? approval.detail.scope.map(String).slice(0, 100)
        : scope,
      expiresInSeconds: remainingSeconds,
    };
  }

  async consume(
    userId: string,
    automation: Automation,
    token: string,
  ): Promise<Extract<ConsumeAutomationRunApprovalResult, { status: "consumed" }>> {
    this.assertOwned(userId, automation);
    let claims: ConfirmationClaims;
    try {
      claims = verifyConfirmationToken(token, {
        userId,
        action: ACTION,
        subjectId: automation.id,
      });
    } catch (error) {
      await this.auditInvalidToken(userId, automation.id);
      throw error;
    }
    if (
      !claims.approvalId ||
      !DURABLE_ID.test(claims.approvalId) ||
      !claims.argumentsHash ||
      !ARGUMENTS_HASH.test(claims.argumentsHash)
    ) {
      await this.auditInvalidToken(userId, automation.id);
      throw confirmationError("invalid");
    }

    const result = await this.store.consumeAutomationRunApproval(userId, {
      approvalId: claims.approvalId,
      automationId: automation.id,
      argumentsHash: claims.argumentsHash,
    });
    if (result.status !== "consumed") throw confirmationError(result.status);
    return result;
  }

  private assertOwned(userId: string, automation: Automation): void {
    if (automation.userId !== userId) {
      throw new ApiError(404, "Automation not found.", "not_found");
    }
  }

  private assertRunnable(automation: Automation): void {
    if (["paused", "queued", "waiting_approval"].includes(automation.status)) {
      throw confirmationError("not_runnable");
    }
  }

  private async auditInvalidToken(userId: string, automationId: string): Promise<void> {
    await this.store
      .createAuditEvent(userId, {
        eventType: "automation.run.confirmation_rejected",
        subjectType: "automation",
        subjectId: automationId,
        outcome: "invalid",
        detail: { reason: "invalid_or_unverifiable_token" },
      })
      .catch(() => undefined);
  }
}

function confirmationError(
  reason: Exclude<ConsumeAutomationRunApprovalResult["status"], "consumed">,
): ApiError {
  const errors = {
    invalid: ["This confirmation is invalid. Review the action again.", "confirmation_invalid"],
    expired: ["This confirmation expired. Review the action again.", "confirmation_expired"],
    replayed: ["This confirmation was already used. No duplicate run was queued.", "confirmation_replayed"],
    stale: ["This automation changed after review. Review its current configuration again.", "confirmation_stale"],
    not_runnable: ["This automation cannot be queued in its current state.", "automation_not_runnable"],
  } as const;
  const [message, code] = errors[reason];
  return new ApiError(409, message, code);
}
