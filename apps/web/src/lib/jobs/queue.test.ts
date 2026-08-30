import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockStore } from "@/lib/data/mock-store";
import { DurableAgentJobQueue } from "@/lib/jobs/queue";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable agent queue", () => {
  it("enqueues, atomically claims, and completes background work", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mre-queue-test-"));
    cleanup.push(directory);
    const store = new MockStore(path.join(directory, "store.json"));
    const user = await store.findUserByEmail("operator@mre.local");
    const queue = new DurableAgentJobQueue(store);
    const queued = await queue.enqueue({
      userId: user!.id,
      agentName: "Research Agent",
      request: "Prepare a bounded research brief",
    });
    expect(queued.status).toBe("queued");
    const claimed = await queue.claim();
    expect(claimed).toMatchObject({ status: "running" });
    const completed = await queue.complete(claimed!, { summary: "Ready for review" });
    expect(completed).toMatchObject({ status: "completed", success: true });
  });
});
