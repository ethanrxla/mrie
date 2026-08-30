import postgres, { type Sql } from "postgres";

import { automationRunArgumentsHash } from "@/lib/approvals/arguments";
import type {
  AgentRun,
  Automation,
  Approval,
  AuditEvent,
  CompleteOnboardingInput,
  ConsumeAutomationRunApprovalInput,
  ConsumeAutomationRunApprovalResult,
  Conversation,
  DataStore,
  MemoryItem,
  Message,
  NewAgentRun,
  NewAuditEvent,
  NewAutomation,
  NewAutomationRunApproval,
  NewMemoryItem,
  NewScheduledTask,
  OnboardingCompletion,
  ScheduledTask,
  Session,
  User,
  UserPreference,
} from "@/lib/data/types";
import { ApiError } from "@/lib/http";

type Row = Record<string, unknown>;
const dateValue = (value: unknown): string | undefined =>
  value instanceof Date ? value.toISOString() : value ? String(value) : undefined;

function userFrom(row: Row): User {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    preferredName: row.preferred_name ? String(row.preferred_name) : undefined,
    company: row.company ? String(row.company) : undefined,
    roleTitle: row.role_title ? String(row.role_title) : undefined,
    timezone: String(row.timezone),
    passwordHash: row.password_hash ? String(row.password_hash) : undefined,
    onboardingCompletedAt: dateValue(row.onboarding_completed_at),
    createdAt: dateValue(row.created_at) ?? "",
    updatedAt: dateValue(row.updated_at) ?? "",
  };
}

function conversationFrom(row: Row): Conversation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    summary: row.summary ? String(row.summary) : undefined,
    createdAt: dateValue(row.created_at) ?? "",
    updatedAt: dateValue(row.updated_at) ?? "",
    archivedAt: dateValue(row.archived_at),
  };
}

function messageFrom(row: Row): Message {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: row.role as Message["role"],
    content: String(row.content),
    transcript: row.transcript ? String(row.transcript) : undefined,
    audioReference: row.audio_reference ? String(row.audio_reference) : undefined,
    attachments: (row.attachments as Message["attachments"]) ?? [],
    sources: (row.sources as Message["sources"]) ?? [],
    memoryIds: (row.memory_ids as string[]) ?? [],
    toolActivity: (row.tool_activity as Message["toolActivity"]) ?? [],
    createdAt: dateValue(row.created_at) ?? "",
  };
}

function memoryFrom(row: Row): MemoryItem {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    memoryType: row.memory_type as MemoryItem["memoryType"],
    title: String(row.title),
    content: String(row.content),
    importanceScore: Number(row.importance_score),
    confidenceScore: Number(row.confidence_score),
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : undefined,
    isPinned: Boolean(row.is_pinned),
    accessCount: Number(row.access_count ?? 0),
    createdAt: dateValue(row.created_at) ?? "",
    updatedAt: dateValue(row.updated_at) ?? "",
    lastAccessedAt: dateValue(row.last_accessed_at),
    expiresAt: dateValue(row.expires_at),
  };
}

function automationFrom(row: Row): Automation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    triggerConfig: (row.trigger_config as Record<string, unknown>) ?? {},
    steps: (row.steps as Array<Record<string, unknown>>) ?? [],
    status: row.status as Automation["status"],
    lastRunAt: dateValue(row.last_run_at),
    nextRunAt: dateValue(row.next_run_at),
    createdAt: dateValue(row.created_at) ?? "",
    updatedAt: dateValue(row.updated_at) ?? "",
  };
}

function approvalFrom(row: Row): Approval {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    actionType: "automation.run",
    subjectType: "automation",
    subjectId: String(row.subject_id),
    title: String(row.title),
    detail: (row.detail as Record<string, unknown>) ?? {},
    argumentsHash: String(row.arguments_hash),
    status: row.status as Approval["status"],
    expiresAt: dateValue(row.expires_at) ?? "",
    decidedAt: dateValue(row.decided_at),
    consumedAt: dateValue(row.consumed_at),
    createdAt: dateValue(row.created_at) ?? "",
  };
}

function auditEventFrom(row: Row): AuditEvent {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    eventType: String(row.event_type),
    subjectType: row.subject_type ? String(row.subject_type) : undefined,
    subjectId: row.subject_id ? String(row.subject_id) : undefined,
    outcome: String(row.outcome),
    detail: (row.detail as Record<string, unknown>) ?? {},
    createdAt: dateValue(row.created_at) ?? "",
  };
}

function agentRunFrom(row: Row): AgentRun {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    agentName: String(row.agent_name),
    request: String(row.request),
    status: row.status as AgentRun["status"],
    result: row.result,
    success: row.success === null ? undefined : Boolean(row.success),
    startedAt: dateValue(row.started_at),
    completedAt: dateValue(row.completed_at),
    createdAt: dateValue(row.created_at) ?? "",
  };
}

export class PostgresStore implements DataStore {
  private readonly sql: Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: true,
      transform: { undefined: null },
    });
  }

  async findUserById(id: string): Promise<User | null> {
    const [row] = await this.sql`SELECT * FROM users WHERE id = ${id}::uuid LIMIT 1`;
    return row ? userFrom(row) : null;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const [row] = await this.sql`
      SELECT * FROM users WHERE lower(email) = lower(${email}) LIMIT 1
    `;
    return row ? userFrom(row) : null;
  }

  async createUser(
    input: Pick<User, "email" | "displayName" | "timezone"> & { passwordHash?: string },
  ): Promise<User> {
    const [row] = await this.sql`
      INSERT INTO users (email, display_name, timezone, password_hash)
      VALUES (lower(${input.email}), ${input.displayName}, ${input.timezone}, ${input.passwordHash ?? null})
      RETURNING *
    `;
    return userFrom(row);
  }

  async updateUser(id: string, changes: Partial<User>): Promise<User> {
    const current = await this.findUserById(id);
    if (!current) throw new ApiError(404, "User not found.", "not_found");
    const next = { ...current, ...changes };
    const [row] = await this.sql`
      UPDATE users SET
        email = lower(${next.email}), display_name = ${next.displayName},
        preferred_name = ${next.preferredName ?? null}, company = ${next.company ?? null},
        role_title = ${next.roleTitle ?? null}, timezone = ${next.timezone},
        password_hash = ${next.passwordHash ?? null},
        onboarding_completed_at = ${next.onboardingCompletedAt ?? null}, updated_at = now()
      WHERE id = ${id}::uuid RETURNING *
    `;
    return userFrom(row);
  }

  async completeOnboarding(
    userId: string,
    input: CompleteOnboardingInput,
  ): Promise<OnboardingCompletion> {
    return this.sql.begin(async (transaction) => {
      const preferences: UserPreference[] = [];
      for (const { key, value } of input.preferences) {
        const [preferenceRow] = await transaction`
          INSERT INTO user_preferences (user_id, preference_key, preference_value)
          VALUES (${userId}::uuid, ${key}, ${transaction.json(value as never)})
          ON CONFLICT (user_id, preference_key) DO UPDATE
          SET preference_value = excluded.preference_value, updated_at = now()
          RETURNING *
        `;
        preferences.push({
          id: String(preferenceRow.id),
          userId: String(preferenceRow.user_id),
          key: String(preferenceRow.preference_key),
          value: preferenceRow.preference_value,
          updatedAt: dateValue(preferenceRow.updated_at) ?? "",
        });
      }
      const [userRow] = await transaction`
        UPDATE users SET
          display_name = ${input.profile.displayName},
          preferred_name = ${input.profile.preferredName},
          timezone = ${input.profile.timezone},
          onboarding_completed_at = now(),
          updated_at = now()
        WHERE id = ${userId}::uuid
        RETURNING *
      `;
      if (!userRow) throw new ApiError(404, "User not found.", "not_found");
      return { user: userFrom(userRow), preferences };
    });
  }

  async createSession(userId: string, tokenHash: string, expiresAt: string): Promise<Session> {
    const [row] = await this.sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${userId}::uuid, ${tokenHash}, ${expiresAt}) RETURNING *
    `;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      tokenHash: String(row.token_hash),
      expiresAt: dateValue(row.expires_at) ?? "",
      createdAt: dateValue(row.created_at) ?? "",
      lastSeenAt: dateValue(row.last_seen_at) ?? "",
    };
  }

  async findSession(tokenHash: string): Promise<Session | null> {
    const [row] = await this.sql`
      SELECT * FROM sessions WHERE token_hash = ${tokenHash} AND expires_at > now() LIMIT 1
    `;
    if (!row) return null;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      tokenHash: String(row.token_hash),
      expiresAt: dateValue(row.expires_at) ?? "",
      createdAt: dateValue(row.created_at) ?? "",
      lastSeenAt: dateValue(row.last_seen_at) ?? "",
    };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
  }

  async listConversations(userId: string): Promise<Conversation[]> {
    const rows = await this.sql`
      SELECT * FROM conversations
      WHERE user_id = ${userId}::uuid AND archived_at IS NULL
      ORDER BY updated_at DESC LIMIT 200
    `;
    return rows.map(conversationFrom);
  }

  async findConversation(userId: string, id: string): Promise<Conversation | null> {
    const [row] = await this.sql`
      SELECT * FROM conversations WHERE id = ${id}::uuid AND user_id = ${userId}::uuid LIMIT 1
    `;
    return row ? conversationFrom(row) : null;
  }

  async createConversation(userId: string, title = "New conversation"): Promise<Conversation> {
    const [row] = await this.sql`
      INSERT INTO conversations (user_id, title) VALUES (${userId}::uuid, ${title}) RETURNING *
    `;
    return conversationFrom(row);
  }

  async updateConversation(
    userId: string,
    id: string,
    changes: Partial<Conversation>,
  ): Promise<Conversation> {
    const current = await this.findConversation(userId, id);
    if (!current) throw new ApiError(404, "Conversation not found.", "not_found");
    const next = { ...current, ...changes };
    const [row] = await this.sql`
      UPDATE conversations SET title = ${next.title}, summary = ${next.summary ?? null},
        archived_at = ${next.archivedAt ?? null}, updated_at = now()
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid RETURNING *
    `;
    return conversationFrom(row);
  }

  async deleteAllConversations(userId: string): Promise<number> {
    const rows = await this.sql`
      DELETE FROM conversations WHERE user_id = ${userId}::uuid RETURNING id
    `;
    return rows.length;
  }

  async listMessages(userId: string, conversationId: string): Promise<Message[]> {
    const rows = await this.sql`
      SELECT m.* FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.user_id = ${userId}::uuid AND c.id = ${conversationId}::uuid
      ORDER BY m.created_at ASC LIMIT 500
    `;
    return rows.map(messageFrom);
  }

  async createMessage(
    userId: string,
    input: Omit<Message, "id" | "createdAt">,
  ): Promise<Message> {
    const conversation = await this.findConversation(userId, input.conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found.", "not_found");
    const [row] = await this.sql.begin(async (transaction) => {
      const inserted = await transaction`
        INSERT INTO messages (
          conversation_id, role, content, transcript, audio_reference,
          attachments, sources, memory_ids, tool_activity
        ) VALUES (
          ${input.conversationId}::uuid, ${input.role}::message_role, ${input.content},
          ${input.transcript ?? null}, ${input.audioReference ?? null},
          ${transaction.json((input.attachments ?? []).map((attachment) => ({ ...attachment })))},
          ${transaction.json(input.sources)},
          ${input.memoryIds}::uuid[], ${transaction.json(input.toolActivity)}
        ) RETURNING *
      `;
      await transaction`
        UPDATE conversations SET updated_at = now() WHERE id = ${input.conversationId}::uuid
      `;
      return inserted;
    });
    return messageFrom(row);
  }

  async listMemories(userId: string): Promise<MemoryItem[]> {
    const rows = await this.sql`
      SELECT * FROM memory_items
      WHERE user_id = ${userId}::uuid AND (expires_at IS NULL OR expires_at > now())
      ORDER BY is_pinned DESC, updated_at DESC LIMIT 1000
    `;
    return rows.map(memoryFrom);
  }

  async createMemory(userId: string, item: NewMemoryItem): Promise<MemoryItem> {
    const [row] = await this.sql`
      INSERT INTO memory_items (
        user_id, memory_type, title, content, importance_score, confidence_score,
        source_message_id, is_pinned, expires_at
      ) VALUES (
        ${userId}::uuid, ${item.memoryType}::memory_type, ${item.title}, ${item.content},
        ${item.importanceScore ?? 0.6}, ${item.confidenceScore ?? 0.9},
        ${item.sourceMessageId ?? null}::uuid, ${item.isPinned ?? false}, ${item.expiresAt ?? null}
      ) RETURNING *
    `;
    return memoryFrom(row);
  }

  async updateMemory(
    userId: string,
    id: string,
    changes: Partial<MemoryItem>,
  ): Promise<MemoryItem> {
    const current = (await this.listMemories(userId)).find((item) => item.id === id);
    if (!current) throw new ApiError(404, "Memory not found.", "not_found");
    const next = { ...current, ...changes };
    const [row] = await this.sql`
      UPDATE memory_items SET
        memory_type = ${next.memoryType}::memory_type, title = ${next.title},
        content = ${next.content}, importance_score = ${next.importanceScore},
        confidence_score = ${next.confidenceScore}, is_pinned = ${next.isPinned},
        expires_at = ${next.expiresAt ?? null}, updated_at = now()
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid RETURNING *
    `;
    return memoryFrom(row);
  }

  async deleteMemory(userId: string, id: string): Promise<void> {
    const result = await this.sql`
      DELETE FROM memory_items WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
    `;
    if (!result.count) throw new ApiError(404, "Memory not found.", "not_found");
  }

  async deleteAllMemories(userId: string): Promise<number> {
    const rows = await this.sql`
      DELETE FROM memory_items WHERE user_id = ${userId}::uuid RETURNING id
    `;
    return rows.length;
  }

  async listAgentRuns(userId: string): Promise<AgentRun[]> {
    const rows = await this.sql`
      SELECT * FROM agent_runs WHERE user_id = ${userId}::uuid ORDER BY created_at DESC LIMIT 200
    `;
    return rows.map(agentRunFrom);
  }

  async createAgentRun(userId: string, input: NewAgentRun): Promise<AgentRun> {
    const [row] = await this.sql`
      INSERT INTO agent_runs (user_id, agent_name, request, status, result, started_at)
      VALUES (
        ${userId}::uuid, ${input.agentName}, ${input.request},
        ${input.status ?? "queued"}::run_status,
        ${input.result === undefined ? null : this.sql.json(input.result as never)},
        ${input.startedAt ?? null}
      ) RETURNING *
    `;
    return agentRunFrom(row);
  }

  async updateAgentRun(
    userId: string,
    id: string,
    changes: Partial<AgentRun>,
  ): Promise<AgentRun> {
    const current = (await this.listAgentRuns(userId)).find((item) => item.id === id);
    if (!current) throw new ApiError(404, "Agent run not found.", "not_found");
    const next = { ...current, ...changes };
    const [row] = await this.sql`
      UPDATE agent_runs SET
        agent_name = ${next.agentName}, request = ${next.request},
        status = ${next.status}::run_status,
        result = ${next.result === undefined ? null : this.sql.json(next.result as never)},
        success = ${next.success ?? null}, started_at = ${next.startedAt ?? null},
        completed_at = ${next.completedAt ?? null}
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid RETURNING *
    `;
    return agentRunFrom(row);
  }

  async claimNextAgentRun(): Promise<AgentRun | null> {
    const [row] = await this.sql`
      WITH next_run AS (
        SELECT id FROM agent_runs WHERE status = 'queued'
        ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE agent_runs AS run
      SET status = 'running', started_at = now()
      FROM next_run WHERE run.id = next_run.id
      RETURNING run.*
    `;
    return row ? agentRunFrom(row) : null;
  }

  async listAutomations(userId: string): Promise<Automation[]> {
    const rows = await this.sql`
      SELECT * FROM automations WHERE user_id = ${userId}::uuid ORDER BY updated_at DESC
    `;
    return rows.map(automationFrom);
  }

  async createAutomation(userId: string, input: NewAutomation): Promise<Automation> {
    const [row] = await this.sql`
      INSERT INTO automations (
        user_id, name, description, trigger_config, steps, status, next_run_at
      ) VALUES (
        ${userId}::uuid, ${input.name}, ${input.description ?? null},
        ${this.sql.json(input.triggerConfig as never)}, ${this.sql.json(input.steps as never)},
        ${input.status ?? "paused"}::run_status, ${input.nextRunAt ?? null}
      ) RETURNING *
    `;
    return automationFrom(row);
  }

  async updateAutomation(
    userId: string,
    id: string,
    changes: Partial<Automation>,
  ): Promise<Automation> {
    const current = (await this.listAutomations(userId)).find((item) => item.id === id);
    if (!current) throw new ApiError(404, "Automation not found.", "not_found");
    const next = { ...current, ...changes };
    const [row] = await this.sql`
      UPDATE automations SET name = ${next.name}, description = ${next.description ?? null},
        trigger_config = ${this.sql.json(next.triggerConfig as never)}, steps = ${this.sql.json(next.steps as never)},
        status = ${next.status}::run_status, last_run_at = ${next.lastRunAt ?? null},
        next_run_at = ${next.nextRunAt ?? null}, updated_at = now()
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid RETURNING *
    `;
    return automationFrom(row);
  }

  async createAutomationRunApproval(
    userId: string,
    input: NewAutomationRunApproval,
  ): Promise<Approval> {
    if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) {
      throw new ApiError(400, "Approval expiry must be in the future.", "invalid_approval");
    }
    return this.sql.begin(async (transaction) => {
      const [automation] = await transaction`
        SELECT id FROM automations
        WHERE id = ${input.automationId}::uuid AND user_id = ${userId}::uuid
        LIMIT 1
      `;
      if (!automation) throw new ApiError(404, "Automation not found.", "not_found");

      const expired = await transaction`
        UPDATE approvals SET status = 'expired', decided_at = now()
        WHERE user_id = ${userId}::uuid
          AND action_type = 'automation.run'
          AND status = 'pending'
          AND expires_at <= now()
        RETURNING id, subject_id
      `;
      for (const approval of expired) {
        await transaction`
          INSERT INTO audit_events (
            user_id, event_type, subject_type, subject_id, outcome, detail
          ) VALUES (
            ${userId}::uuid, 'automation.run.approval_expired', 'automation',
            ${String(approval.subject_id)}, 'expired',
            ${transaction.json({ approvalId: String(approval.id) })}
          )
        `;
      }

      const [row] = await transaction`
        INSERT INTO approvals (
          user_id, action_type, subject_id, title, detail, arguments_hash,
          status, expires_at
        ) VALUES (
          ${userId}::uuid, 'automation.run', ${input.automationId}, ${input.title},
          ${transaction.json({ description: input.detail, scope: input.scope })},
          ${input.argumentsHash}, 'pending', ${input.expiresAt}
        )
        ON CONFLICT (user_id, action_type, subject_id, arguments_hash)
          WHERE status = 'pending'
        DO UPDATE SET title = approvals.title
        RETURNING *
      `;
      const approval = approvalFrom(row);
      const [priorAudit] = await transaction`
        SELECT id FROM audit_events
        WHERE user_id = ${userId}::uuid
          AND event_type = 'automation.run.approval_requested'
          AND detail->>'approvalId' = ${approval.id}
        LIMIT 1
      `;
      if (!priorAudit) {
        await transaction`
          INSERT INTO audit_events (
            user_id, event_type, subject_type, subject_id, outcome, detail
          ) VALUES (
            ${userId}::uuid, 'automation.run.approval_requested', 'automation',
            ${input.automationId}, 'pending',
            ${transaction.json({
              approvalId: approval.id,
              argumentsHash: input.argumentsHash,
              expiresAt: approval.expiresAt,
            })}
          )
        `;
      }
      return approval;
    });
  }

  async consumeAutomationRunApproval(
    userId: string,
    input: ConsumeAutomationRunApprovalInput,
  ): Promise<ConsumeAutomationRunApprovalResult> {
    return this.sql.begin(async (transaction) => {
      const reject = async (
        status: Exclude<ConsumeAutomationRunApprovalResult["status"], "consumed">,
      ): Promise<ConsumeAutomationRunApprovalResult> => {
        const [auditRow] = await transaction`
          INSERT INTO audit_events (
            user_id, event_type, subject_type, subject_id, outcome, detail
          ) VALUES (
            ${userId}::uuid, 'automation.run.confirmation_rejected', 'automation',
            ${input.automationId}, ${status},
            ${transaction.json({ approvalId: input.approvalId })}
          ) RETURNING *
        `;
        return { status, auditEvent: auditEventFrom(auditRow) };
      };

      const [approvalRow] = await transaction`
        SELECT * FROM approvals
        WHERE id = ${input.approvalId}::uuid AND user_id = ${userId}::uuid
        FOR UPDATE
      `;
      if (
        !approvalRow ||
        approvalRow.action_type !== "automation.run" ||
        String(approvalRow.subject_id) !== input.automationId ||
        String(approvalRow.arguments_hash) !== input.argumentsHash
      ) {
        return reject("invalid");
      }
      const approval = approvalFrom(approvalRow);
      if (approval.status === "consumed") return reject("replayed");
      if (approval.status === "expired" || Date.parse(approval.expiresAt) <= Date.now()) {
        await transaction`
          UPDATE approvals SET status = 'expired', decided_at = COALESCE(decided_at, now())
          WHERE id = ${approval.id}::uuid AND user_id = ${userId}::uuid
        `;
        return reject("expired");
      }
      if (approval.status !== "pending") return reject("invalid");
      const [automationRow] = await transaction`
        SELECT * FROM automations
        WHERE id = ${input.automationId}::uuid AND user_id = ${userId}::uuid
        FOR UPDATE
      `;
      if (!automationRow) {
        await transaction`
          UPDATE approvals SET status = 'denied', decided_at = now()
          WHERE id = ${approval.id}::uuid AND user_id = ${userId}::uuid
        `;
        return reject("invalid");
      }
      const automation = automationFrom(automationRow);
      if (automationRunArgumentsHash(automation) !== input.argumentsHash) {
        await transaction`
          UPDATE approvals SET status = 'denied', decided_at = now()
          WHERE id = ${approval.id}::uuid AND user_id = ${userId}::uuid
        `;
        return reject("stale");
      }
      if (["paused", "queued", "waiting_approval"].includes(automation.status)) {
        await transaction`
          UPDATE approvals SET status = 'denied', decided_at = now()
          WHERE id = ${approval.id}::uuid AND user_id = ${userId}::uuid
        `;
        return reject("not_runnable");
      }

      const [consumedApprovalRow] = await transaction`
        UPDATE approvals SET status = 'consumed', decided_at = now(), consumed_at = now()
        WHERE id = ${approval.id}::uuid AND user_id = ${userId}::uuid AND status = 'pending'
        RETURNING *
      `;
      if (!consumedApprovalRow) return reject("replayed");
      const [updatedAutomationRow] = await transaction`
        UPDATE automations SET status = 'queued', last_run_at = now(), updated_at = now()
        WHERE id = ${automation.id}::uuid AND user_id = ${userId}::uuid
        RETURNING *
      `;
      const [runRow] = await transaction`
        INSERT INTO agent_runs (user_id, agent_name, request, status)
        VALUES (
          ${userId}::uuid, 'Operations Agent', ${`Run automation: ${automation.name}`},
          'queued'::run_status
        ) RETURNING *
      `;
      const [auditRow] = await transaction`
        INSERT INTO audit_events (
          user_id, event_type, subject_type, subject_id, outcome, detail
        ) VALUES (
          ${userId}::uuid, 'automation.run.approval_consumed', 'automation',
          ${automation.id}, 'queued',
          ${transaction.json({
            approvalId: approval.id,
            argumentsHash: approval.argumentsHash,
            agentRunId: String(runRow.id),
          })}
        ) RETURNING *
      `;
      return {
        status: "consumed",
        approval: approvalFrom(consumedApprovalRow),
        automation: automationFrom(updatedAutomationRow),
        run: agentRunFrom(runRow),
        auditEvent: auditEventFrom(auditRow),
      };
    });
  }

  async createAuditEvent(userId: string, input: NewAuditEvent): Promise<AuditEvent> {
    const [row] = await this.sql`
      INSERT INTO audit_events (
        user_id, event_type, subject_type, subject_id, outcome, detail
      ) VALUES (
        ${userId}::uuid, ${input.eventType}, ${input.subjectType ?? null},
        ${input.subjectId ?? null}, ${input.outcome},
        ${this.sql.json(input.detail as never)}
      ) RETURNING *
    `;
    return auditEventFrom(row);
  }

  async listAuditEvents(userId: string, limit = 100): Promise<AuditEvent[]> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 500));
    const rows = await this.sql`
      SELECT * FROM audit_events
      WHERE user_id = ${userId}::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT ${bounded}
    `;
    return rows.map(auditEventFrom);
  }

  async listScheduledTasks(userId: string): Promise<ScheduledTask[]> {
    const rows = await this.sql`
      SELECT * FROM scheduled_tasks WHERE user_id = ${userId}::uuid ORDER BY next_run_at ASC
    `;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      title: String(row.title),
      description: row.description ? String(row.description) : undefined,
      scheduleExpression: String(row.schedule_expression),
      timezone: String(row.timezone),
      status: row.status as ScheduledTask["status"],
      nextRunAt: dateValue(row.next_run_at),
      lastRunAt: dateValue(row.last_run_at),
      createdAt: dateValue(row.created_at) ?? "",
      updatedAt: dateValue(row.updated_at) ?? "",
    }));
  }

  async createScheduledTask(userId: string, input: NewScheduledTask): Promise<ScheduledTask> {
    const [row] = await this.sql`
      INSERT INTO scheduled_tasks (
        user_id, title, description, schedule_expression, timezone, status, next_run_at
      ) VALUES (
        ${userId}::uuid, ${input.title}, ${input.description ?? null},
        ${input.scheduleExpression}, ${input.timezone}, ${input.status ?? "queued"}::run_status,
        ${input.nextRunAt ?? null}
      ) RETURNING *
    `;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      title: String(row.title),
      description: row.description ? String(row.description) : undefined,
      scheduleExpression: String(row.schedule_expression),
      timezone: String(row.timezone),
      status: row.status as ScheduledTask["status"],
      nextRunAt: dateValue(row.next_run_at),
      lastRunAt: dateValue(row.last_run_at),
      createdAt: dateValue(row.created_at) ?? "",
      updatedAt: dateValue(row.updated_at) ?? "",
    };
  }

  async listPreferences(userId: string): Promise<UserPreference[]> {
    const rows = await this.sql`
      SELECT * FROM user_preferences WHERE user_id = ${userId}::uuid ORDER BY preference_key
    `;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      key: String(row.preference_key),
      value: row.preference_value,
      updatedAt: dateValue(row.updated_at) ?? "",
    }));
  }

  async upsertPreference(userId: string, key: string, value: unknown): Promise<UserPreference> {
    const [row] = await this.sql`
      INSERT INTO user_preferences (user_id, preference_key, preference_value)
      VALUES (${userId}::uuid, ${key}, ${this.sql.json(value as never)})
      ON CONFLICT (user_id, preference_key) DO UPDATE
      SET preference_value = excluded.preference_value, updated_at = now()
      RETURNING *
    `;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      key: String(row.preference_key),
      value: row.preference_value,
      updatedAt: dateValue(row.updated_at) ?? "",
    };
  }
}
