import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/lib/data/types";
import { MockStore } from "@/lib/data/mock-store";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  requireUser: vi.fn(),
  getStore: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  requireUser: mocks.requireUser,
}));
vi.mock("@/lib/data", () => ({ getStore: mocks.getStore }));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocks.enforceRateLimit }));

import { POST } from "@/app/api/automations/[id]/run/route";

const cleanup: string[] = [];
let store: MockStore;
let user: User;

beforeEach(async () => {
  vi.clearAllMocks();
  const directory = await mkdtemp(path.join(tmpdir(), "mre-run-route-test-"));
  cleanup.push(directory);
  store = new MockStore(path.join(directory, "store.json"));
  user = (await store.findUserByEmail("operator@mre.local"))!;
  mocks.requireUser.mockResolvedValue(user);
  mocks.getStore.mockResolvedValue(store);
});

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("automation run approval API", () => {
  it("requires durable confirmation and rejects replay without a duplicate job", async () => {
    const automation = await store.createAutomation(user.id, {
      name: "Manual operations workflow",
      triggerConfig: { type: "manual" },
      steps: [{ type: "research" }],
      status: "running",
    });
    const context = { params: Promise.resolve({ id: automation.id }) };

    const preparedResponse = await POST(jsonRequest({}), context);
    const prepared = await preparedResponse.json();
    expect(preparedResponse.status).toBe(202);
    expect(prepared).toMatchObject({
      requiresConfirmation: true,
      confirmation: { expiresInSeconds: expect.any(Number) },
    });

    const confirmedResponse = await POST(
      jsonRequest({ confirmed: true, confirmationToken: prepared.confirmation.token }),
      context,
    );
    const confirmed = await confirmedResponse.json();
    expect(confirmedResponse.status).toBe(202);
    expect(confirmed).toMatchObject({
      accepted: true,
      automation: { status: "queued" },
      run: { status: "queued" },
      approvalId: expect.any(String),
      auditEventId: expect.any(String),
    });

    const replayResponse = await POST(
      jsonRequest({ confirmed: true, confirmationToken: prepared.confirmation.token }),
      context,
    );
    expect(replayResponse.status).toBe(409);
    await expect(replayResponse.json()).resolves.toMatchObject({
      error: { code: "confirmation_replayed" },
    });
    expect(await store.listAgentRuns(user.id)).toHaveLength(1);
    expect((await store.listAuditEvents(user.id)).map((event) => event.outcome)).toEqual(
      expect.arrayContaining(["pending", "queued", "replayed"]),
    );
  });
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost:3001/api/automations/id/run", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3001" },
    body: JSON.stringify(body),
  });
}
