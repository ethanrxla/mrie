import { randomUUID } from "node:crypto";

import type {
  AgentRun,
  Approval,
  AuditEvent,
  Automation,
  Conversation,
  MemoryItem,
  Message,
  ScheduledTask,
  Session,
  User,
  UserPreference,
} from "@/lib/data/types";

/** Durable single-workstation storage with no fabricated operational records. */
export interface LocalDatabase {
  users: User[];
  sessions: Session[];
  conversations: Conversation[];
  messages: Message[];
  memories: MemoryItem[];
  agentRuns: AgentRun[];
  automations: Automation[];
  approvals: Approval[];
  auditEvents: AuditEvent[];
  scheduledTasks: ScheduledTask[];
  preferences: UserPreference[];
}

export const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";

export function createLocalDatabase(email = "operator@mre.local"): LocalDatabase {
  const timestamp = new Date().toISOString();
  const user: User = {
    id: LOCAL_USER_ID,
    email,
    displayName: "Operator",
    preferredName: "Operator",
    timezone: "America/New_York",
    onboardingCompletedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return {
    users: [user],
    sessions: [],
    conversations: [],
    messages: [],
    memories: [],
    agentRuns: [],
    automations: [],
    approvals: [],
    auditEvents: [],
    scheduledTasks: [],
    preferences: [
      {
        id: randomUUID(),
        userId: user.id,
        key: "voice.spokenResponses",
        value: true,
        updatedAt: timestamp,
      },
      {
        id: randomUUID(),
        userId: user.id,
        key: "voice.speed",
        value: 1,
        updatedAt: timestamp,
      },
      {
        id: randomUUID(),
        userId: user.id,
        key: "sound.volume",
        value: 0.8,
        updatedAt: timestamp,
      },
    ],
  };
}
