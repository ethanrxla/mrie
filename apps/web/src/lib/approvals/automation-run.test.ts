import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { automationRunArgumentsHash } from "@/lib/approvals/arguments";
import { AutomationRunApprovalService } from "@/lib/approvals/automation-run";
import type { Automation } from "@/lib/data/types";
import { MockStore } from "@/lib/data/mock-store";
import { ApiError } from "@/lib/http";

const cleanup: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function harness(): Promise<{
  filePath: string;
  store: MockStore;
  userId: string;
  automation: Automation;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "mre-approval-test-"));
  cleanup.push(directory);
  const filePath = path.join(directory, "store.json");
  const store = new MockStore(filePath);
  const user = await store.findUserByEmail("operator@mre.local");
  const automation = await store.createAutomation(user!.id, {
    name: "Review current outreach queue",
    description: "Prepare the configured workflow for processing.",
    triggerConfig: { type: "manual" },
    steps: [{ type: "research" }, { type: "draft" }],
    status: "running",
  });
  return { filePath, store, userId: user!.id, automation };
}

describe("durable automation run approvals", () => {
  it("issues idempotently, consumes once, rejects replay, and survives restart", async () => {
    const { filePath, store, userId, automation } = await harness();
    const service = new AutomationRunApprovalService(store);

    const first = await service.prepare(userId, automation);
    const repeated = await service.prepare(userId, automation);
    expect(repeated.approval.id).toBe(first.approval.id);
    expect(
      (await store.listAuditEvents(userId)).filter(
        (event) => event.eventType === "automation.run.approval_requested",
      ),
    ).toHaveLength(1);

    const attempts = await Promise.allSettled([
      service.consume(userId, automation, first.token),
      service.consume(userId, automation, repeated.token),
    ]);
    const accepted = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof service.consume>>> =>
        attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].value).toMatchObject({
      status: "consumed",
      automation: { status: "queued" },
      run: { status: "queued" },
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      status: 409,
      code: "confirmation_replayed",
    } satisfies Partial<ApiError>);
    expect(await store.listAgentRuns(userId)).toHaveLength(1);

    const reopened = new MockStore(filePath);
    expect(await reopened.listAgentRuns(userId)).toHaveLength(1);
    const audit = await reopened.listAuditEvents(userId);
    expect(audit.map((event) => event.outcome)).toEqual(
      expect.arrayContaining(["pending", "queued", "replayed"]),
    );
  });

  it("does not disclose or consume another tenant's approval", async () => {
    const { store, userId, automation } = await harness();
    const service = new AutomationRunApprovalService(store);
    const prepared = await service.prepare(userId, automation);
    const other = await store.createUser({
      email: "other-operator@example.com",
      displayName: "Other Operator",
      timezone: "UTC",
    });

    const crossTenant = await store.consumeAutomationRunApproval(other.id, {
      approvalId: prepared.approval.id,
      automationId: automation.id,
      argumentsHash: automationRunArgumentsHash(automation),
    });

    expect(crossTenant.status).toBe("invalid");
    expect(await store.listAgentRuns(other.id)).toHaveLength(0);
    expect(await store.listAuditEvents(other.id)).toEqual([
      expect.objectContaining({ outcome: "invalid", userId: other.id }),
    ]);
    expect(await store.listAuditEvents(userId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "pending" })]),
    );
    await expect(service.consume(userId, automation, prepared.token)).resolves.toMatchObject({
      status: "consumed",
    });
  });

  it("expires approvals and refuses a changed automation snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
    const { store, userId, automation } = await harness();
    const service = new AutomationRunApprovalService(store);
    const expiring = await service.prepare(userId, automation);

    vi.advanceTimersByTime(301_000);
    const expired = await store.consumeAutomationRunApproval(userId, {
      approvalId: expiring.approval.id,
      automationId: automation.id,
      argumentsHash: automationRunArgumentsHash(automation),
    });
    expect(expired.status).toBe("expired");

    const current = (await store.listAutomations(userId)).find(
      (item) => item.id === automation.id,
    )!;
    const fresh = await service.prepare(userId, current);
    const changed = await store.updateAutomation(userId, automation.id, {
      description: "The operator changed this after reviewing it.",
    });
    await expect(service.consume(userId, changed, fresh.token)).rejects.toMatchObject({
      status: 409,
      code: "confirmation_stale",
    } satisfies Partial<ApiError>);
    expect(await store.listAgentRuns(userId)).toHaveLength(0);
  });

  it("returns detached audit records so callers cannot rewrite history", async () => {
    const { store, userId, automation } = await harness();
    await new AutomationRunApprovalService(store).prepare(userId, automation);

    const firstRead = await store.listAuditEvents(userId);
    firstRead[0].outcome = "tampered";
    firstRead[0].detail.approvalId = "tampered";
    const secondRead = await store.listAuditEvents(userId);

    expect(secondRead[0].outcome).toBe("pending");
    expect(secondRead[0].detail.approvalId).not.toBe("tampered");
  });
});
