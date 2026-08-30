import "server-only";

import type { AgentRun, DataStore } from "@/lib/data/types";

export interface QueueJobInput {
  userId: string;
  agentName: string;
  request: string;
}

export interface BackgroundJobQueue {
  enqueue(input: QueueJobInput): Promise<AgentRun>;
  claim(): Promise<AgentRun | null>;
  complete(run: AgentRun, result: unknown): Promise<AgentRun>;
  fail(run: AgentRun, errorCode: string): Promise<AgentRun>;
}

export class DurableAgentJobQueue implements BackgroundJobQueue {
  constructor(private readonly store: DataStore) {}

  enqueue(input: QueueJobInput): Promise<AgentRun> {
    return this.store.createAgentRun(input.userId, {
      agentName: input.agentName,
      request: input.request,
      status: "queued",
    });
  }

  claim(): Promise<AgentRun | null> {
    return this.store.claimNextAgentRun();
  }

  complete(run: AgentRun, result: unknown): Promise<AgentRun> {
    return this.store.updateAgentRun(run.userId, run.id, {
      status: "completed",
      result,
      success: true,
      completedAt: new Date().toISOString(),
    });
  }

  fail(run: AgentRun, errorCode: string): Promise<AgentRun> {
    return this.store.updateAgentRun(run.userId, run.id, {
      status: "failed",
      result: { errorCode },
      success: false,
      completedAt: new Date().toISOString(),
    });
  }
}
