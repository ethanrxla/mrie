import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { automationRunArgumentsHash } from "@/lib/approvals/arguments";
import { createLocalDatabase, type LocalDatabase } from "@/lib/data/local-data";
import type {
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
  Session,
  User,
  UserPreference,
} from "@/lib/data/types";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";

export class MockStore implements DataStore {
  private database?: LocalDatabase;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = getEnv().LOCAL_STORE_PATH
      ?? path.join(process.cwd(), ".xyn", "local-store.json"),
  ) {}

  private async db(): Promise<LocalDatabase> {
    if (this.database) return this.database;
    try {
      this.database = JSON.parse(await readFile(this.filePath, "utf8")) as LocalDatabase;
      this.database.preferences ??= [];
      this.database.approvals ??= [];
      this.database.auditEvents ??= [];
    } catch {
      this.database = createLocalDatabase(getEnv().LOCAL_USER_EMAIL);
      await this.persist();
    }
    this.removeExpired(this.database);
    return this.database;
  }

  private removeExpired(database: LocalDatabase): void {
    const now = Date.now();
    database.sessions = database.sessions.filter((item) => Date.parse(item.expiresAt) > now);
    database.memories = database.memories.filter(
      (item) => !item.expiresAt || Date.parse(item.expiresAt) > now,
    );
  }

  private async mutate<T>(operation: (database: LocalDatabase) => T): Promise<T> {
    const database = await this.db();
    let result!: T;
    this.writeQueue = this.writeQueue.then(async () => {
      result = operation(database);
      await this.persist();
    });
    await this.writeQueue;
    return result;
  }

  private async persist(): Promise<void> {
    if (!this.database) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.database, null, 2), "utf8");
    await rename(temporary, this.filePath);
  }

  private appendAuditEvent(
    database: LocalDatabase,
    userId: string,
    input: NewAuditEvent,
    createdAt = new Date().toISOString(),
  ): AuditEvent {
    const event: AuditEvent = {
      id: randomUUID(),
      userId,
      eventType: input.eventType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome: input.outcome,
      detail: structuredClone(input.detail),
      createdAt,
    };
    database.auditEvents.push(event);
    return structuredClone(event);
  }

  async findUserById(id: string): Promise<User | null> {
    return (await this.db()).users.find((item) => item.id === id) ?? null;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const normalized = email.toLowerCase();
    return (await this.db()).users.find((item) => item.email.toLowerCase() === normalized) ?? null;
  }

  async createUser(
    input: Pick<User, "email" | "displayName" | "timezone"> & { passwordHash?: string },
  ): Promise<User> {
    return this.mutate((database) => {
      if (database.users.some((item) => item.email.toLowerCase() === input.email.toLowerCase())) {
        throw new ApiError(409, "An account with this email already exists.", "email_exists");
      }
      const timestamp = new Date().toISOString();
      const user: User = {
        id: randomUUID(),
        email: input.email.toLowerCase(),
        displayName: input.displayName,
        timezone: input.timezone,
        passwordHash: input.passwordHash,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.users.push(user);
      return user;
    });
  }

  async updateUser(id: string, changes: Partial<User>): Promise<User> {
    return this.mutate((database) => {
      const user = database.users.find((item) => item.id === id);
      if (!user) throw new ApiError(404, "User not found.", "not_found");
      Object.assign(user, changes, { id, updatedAt: new Date().toISOString() });
      return { ...user };
    });
  }

  async completeOnboarding(
    userId: string,
    input: CompleteOnboardingInput,
  ): Promise<OnboardingCompletion> {
    return this.mutate((database) => {
      const user = database.users.find((item) => item.id === userId);
      if (!user) throw new ApiError(404, "User not found.", "not_found");
      const updatedAt = new Date().toISOString();
      const preferences = input.preferences.map(({ key, value }) => {
        const existing = database.preferences.find(
          (preference) => preference.userId === userId && preference.key === key,
        );
        if (existing) {
          existing.value = value;
          existing.updatedAt = updatedAt;
          return { ...existing };
        }
        const preference: UserPreference = {
          id: randomUUID(),
          userId,
          key,
          value,
          updatedAt,
        };
        database.preferences.push(preference);
        return { ...preference };
      });
      Object.assign(user, input.profile, {
        id: userId,
        updatedAt,
        onboardingCompletedAt: updatedAt,
      });
      return { user: { ...user }, preferences };
    });
  }

  async createSession(userId: string, tokenHash: string, expiresAt: string): Promise<Session> {
    return this.mutate((database) => {
      const timestamp = new Date().toISOString();
      const session: Session = {
        id: randomUUID(),
        userId,
        tokenHash,
        expiresAt,
        createdAt: timestamp,
        lastSeenAt: timestamp,
      };
      database.sessions.push(session);
      return session;
    });
  }

  async findSession(tokenHash: string): Promise<Session | null> {
    return (await this.db()).sessions.find((item) => item.tokenHash === tokenHash) ?? null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.mutate((database) => {
      database.sessions = database.sessions.filter((item) => item.tokenHash !== tokenHash);
    });
  }

  async listConversations(userId: string): Promise<Conversation[]> {
    return (await this.db()).conversations
      .filter((item) => item.userId === userId && !item.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async findConversation(userId: string, id: string): Promise<Conversation | null> {
    return (
      (await this.db()).conversations.find((item) => item.userId === userId && item.id === id) ??
      null
    );
  }

  async createConversation(userId: string, title = "New conversation"): Promise<Conversation> {
    return this.mutate((database) => {
      const timestamp = new Date().toISOString();
      const conversation: Conversation = {
        id: randomUUID(),
        userId,
        title,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.conversations.push(conversation);
      return conversation;
    });
  }

  async updateConversation(
    userId: string,
    id: string,
    changes: Partial<Conversation>,
  ): Promise<Conversation> {
    return this.mutate((database) => {
      const item = database.conversations.find(
        (conversation) => conversation.userId === userId && conversation.id === id,
      );
      if (!item) throw new ApiError(404, "Conversation not found.", "not_found");
      Object.assign(item, changes, { id, userId, updatedAt: new Date().toISOString() });
      return { ...item };
    });
  }

  async deleteAllConversations(userId: string): Promise<number> {
    return this.mutate((database) => {
      const conversationIds = new Set(
        database.conversations
          .filter((conversation) => conversation.userId === userId)
          .map((conversation) => conversation.id),
      );
      database.conversations = database.conversations.filter(
        (conversation) => !conversationIds.has(conversation.id),
      );
      database.messages = database.messages.filter(
        (message) => !conversationIds.has(message.conversationId),
      );
      return conversationIds.size;
    });
  }

  async listMessages(userId: string, conversationId: string): Promise<Message[]> {
    if (!(await this.findConversation(userId, conversationId))) {
      throw new ApiError(404, "Conversation not found.", "not_found");
    }
    return (await this.db()).messages
      .filter((item) => item.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createMessage(
    userId: string,
    input: Omit<Message, "id" | "createdAt">,
  ): Promise<Message> {
    if (!(await this.findConversation(userId, input.conversationId))) {
      throw new ApiError(404, "Conversation not found.", "not_found");
    }
    return this.mutate((database) => {
      const message: Message = {
        ...input,
        attachments: input.attachments ?? [],
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      database.messages.push(message);
      const conversation = database.conversations.find((item) => item.id === input.conversationId);
      if (conversation) conversation.updatedAt = message.createdAt;
      return message;
    });
  }

  async listMemories(userId: string): Promise<MemoryItem[]> {
    return (await this.db()).memories
      .filter((item) => item.userId === userId)
      .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt));
  }

  async createMemory(userId: string, item: NewMemoryItem): Promise<MemoryItem> {
    return this.mutate((database) => {
      const timestamp = new Date().toISOString();
      const memory: MemoryItem = {
        id: randomUUID(),
        userId,
        memoryType: item.memoryType,
        title: item.title,
        content: item.content,
        importanceScore: item.importanceScore ?? 0.6,
        confidenceScore: item.confidenceScore ?? 0.9,
        sourceMessageId: item.sourceMessageId,
        isPinned: item.isPinned ?? false,
        accessCount: 0,
        expiresAt: item.expiresAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.memories.push(memory);
      return memory;
    });
  }

  async updateMemory(
    userId: string,
    id: string,
    changes: Partial<MemoryItem>,
  ): Promise<MemoryItem> {
    return this.mutate((database) => {
      const item = database.memories.find((memory) => memory.userId === userId && memory.id === id);
      if (!item) throw new ApiError(404, "Memory not found.", "not_found");
      Object.assign(item, changes, { id, userId, updatedAt: new Date().toISOString() });
      return { ...item };
    });
  }

  async deleteMemory(userId: string, id: string): Promise<void> {
    await this.mutate((database) => {
      const before = database.memories.length;
      database.memories = database.memories.filter(
        (memory) => !(memory.userId === userId && memory.id === id),
      );
      if (before === database.memories.length) {
        throw new ApiError(404, "Memory not found.", "not_found");
      }
    });
  }

  async deleteAllMemories(userId: string): Promise<number> {
    return this.mutate((database) => {
      const originalLength = database.memories.length;
      database.memories = database.memories.filter((memory) => memory.userId !== userId);
      return originalLength - database.memories.length;
    });
  }

  async listAgentRuns(userId: string) {
    return (await this.db()).agentRuns.filter((item) => item.userId === userId);
  }

  async createAgentRun(userId: string, input: NewAgentRun) {
    return this.mutate((database) => {
      const run = {
        id: randomUUID(),
        userId,
        agentName: input.agentName,
        request: input.request,
        status: input.status ?? "queued",
        result: input.result,
        startedAt: input.startedAt,
        createdAt: new Date().toISOString(),
      } as const;
      database.agentRuns.unshift(run);
      return { ...run };
    });
  }

  async updateAgentRun(userId: string, id: string, changes: Partial<import("./types").AgentRun>) {
    return this.mutate((database) => {
      const run = database.agentRuns.find((item) => item.userId === userId && item.id === id);
      if (!run) throw new ApiError(404, "Agent run not found.", "not_found");
      Object.assign(run, changes, { id, userId });
      return { ...run };
    });
  }

  async claimNextAgentRun() {
    return this.mutate((database) => {
      const run = [...database.agentRuns]
        .filter((item) => item.status === "queued")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!run) return null;
      run.status = "running";
      run.startedAt = new Date().toISOString();
      return { ...run };
    });
  }

  async listAutomations(userId: string): Promise<Automation[]> {
    return (await this.db()).automations.filter((item) => item.userId === userId);
  }

  async createAutomation(userId: string, input: NewAutomation): Promise<Automation> {
    return this.mutate((database) => {
      const timestamp = new Date().toISOString();
      const automation: Automation = {
        id: randomUUID(),
        userId,
        name: input.name,
        description: input.description,
        triggerConfig: input.triggerConfig,
        steps: input.steps,
        status: input.status ?? "paused",
        nextRunAt: input.nextRunAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.automations.unshift(automation);
      return { ...automation };
    });
  }

  async updateAutomation(
    userId: string,
    id: string,
    changes: Partial<Automation>,
  ): Promise<Automation> {
    return this.mutate((database) => {
      const item = database.automations.find(
        (automation) => automation.userId === userId && automation.id === id,
      );
      if (!item) throw new ApiError(404, "Automation not found.", "not_found");
      Object.assign(item, changes, { id, userId, updatedAt: new Date().toISOString() });
      return { ...item };
    });
  }

  async createAutomationRunApproval(
    userId: string,
    input: NewAutomationRunApproval,
  ): Promise<Approval> {
    if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) {
      throw new ApiError(400, "Approval expiry must be in the future.", "invalid_approval");
    }
    return this.mutate((database) => {
      const automation = database.automations.find(
        (item) => item.userId === userId && item.id === input.automationId,
      );
      if (!automation) throw new ApiError(404, "Automation not found.", "not_found");
      const timestamp = new Date().toISOString();
      for (const approval of database.approvals) {
        if (
          approval.userId === userId &&
          approval.actionType === "automation.run" &&
          approval.status === "pending" &&
          Date.parse(approval.expiresAt) <= Date.parse(timestamp)
        ) {
          approval.status = "expired";
          approval.decidedAt = timestamp;
          this.appendAuditEvent(database, userId, {
            eventType: "automation.run.approval_expired",
            subjectType: "automation",
            subjectId: approval.subjectId,
            outcome: "expired",
            detail: { approvalId: approval.id },
          }, timestamp);
        }
      }
      const existing = database.approvals.find(
        (approval) =>
          approval.userId === userId &&
          approval.actionType === "automation.run" &&
          approval.subjectId === input.automationId &&
          approval.argumentsHash === input.argumentsHash &&
          approval.status === "pending",
      );
      if (existing) return structuredClone(existing);

      const approval: Approval = {
        id: randomUUID(),
        userId,
        actionType: "automation.run",
        subjectType: "automation",
        subjectId: input.automationId,
        title: input.title,
        detail: { description: input.detail, scope: [...input.scope] },
        argumentsHash: input.argumentsHash,
        status: "pending",
        expiresAt: input.expiresAt,
        createdAt: timestamp,
      };
      database.approvals.push(approval);
      this.appendAuditEvent(database, userId, {
        eventType: "automation.run.approval_requested",
        subjectType: "automation",
        subjectId: input.automationId,
        outcome: "pending",
        detail: {
          approvalId: approval.id,
          argumentsHash: input.argumentsHash,
          expiresAt: input.expiresAt,
        },
      }, timestamp);
      return structuredClone(approval);
    });
  }

  async consumeAutomationRunApproval(
    userId: string,
    input: ConsumeAutomationRunApprovalInput,
  ): Promise<ConsumeAutomationRunApprovalResult> {
    return this.mutate((database) => {
      const timestamp = new Date().toISOString();
      const reject = (
        status: Exclude<ConsumeAutomationRunApprovalResult["status"], "consumed">,
      ): ConsumeAutomationRunApprovalResult => ({
        status,
        auditEvent: this.appendAuditEvent(database, userId, {
          eventType: "automation.run.confirmation_rejected",
          subjectType: "automation",
          subjectId: input.automationId,
          outcome: status,
          detail: { approvalId: input.approvalId },
        }, timestamp),
      });
      const approval = database.approvals.find(
        (item) => item.userId === userId && item.id === input.approvalId,
      );
      if (
        !approval ||
        approval.actionType !== "automation.run" ||
        approval.subjectId !== input.automationId ||
        approval.argumentsHash !== input.argumentsHash
      ) {
        return reject("invalid");
      }
      if (approval.status === "consumed") return reject("replayed");
      if (approval.status === "expired" || Date.parse(approval.expiresAt) <= Date.now()) {
        approval.status = "expired";
        approval.decidedAt ??= timestamp;
        return reject("expired");
      }
      if (approval.status !== "pending") return reject("invalid");
      const automation = database.automations.find(
        (item) => item.userId === userId && item.id === input.automationId,
      );
      if (!automation) {
        approval.status = "denied";
        approval.decidedAt = timestamp;
        return reject("invalid");
      }
      if (automationRunArgumentsHash(automation) !== input.argumentsHash) {
        approval.status = "denied";
        approval.decidedAt = timestamp;
        return reject("stale");
      }
      if (["paused", "queued", "waiting_approval"].includes(automation.status)) {
        approval.status = "denied";
        approval.decidedAt = timestamp;
        return reject("not_runnable");
      }

      approval.status = "consumed";
      approval.decidedAt = timestamp;
      approval.consumedAt = timestamp;
      automation.status = "queued";
      automation.lastRunAt = timestamp;
      automation.updatedAt = timestamp;
      const run = {
        id: randomUUID(),
        userId,
        agentName: "Operations Agent",
        request: `Run automation: ${automation.name}`,
        status: "queued" as const,
        createdAt: timestamp,
      };
      database.agentRuns.unshift(run);
      const auditEvent = this.appendAuditEvent(database, userId, {
        eventType: "automation.run.approval_consumed",
        subjectType: "automation",
        subjectId: automation.id,
        outcome: "queued",
        detail: {
          approvalId: approval.id,
          argumentsHash: approval.argumentsHash,
          agentRunId: run.id,
        },
      }, timestamp);
      return {
        status: "consumed",
        approval: structuredClone(approval),
        automation: structuredClone(automation),
        run: structuredClone(run),
        auditEvent,
      };
    });
  }

  async createAuditEvent(userId: string, input: NewAuditEvent): Promise<AuditEvent> {
    return this.mutate((database) => this.appendAuditEvent(database, userId, input));
  }

  async listAuditEvents(userId: string, limit = 100): Promise<AuditEvent[]> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 500));
    return (await this.db()).auditEvents
      .filter((event) => event.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, bounded)
      .map((event) => structuredClone(event));
  }

  async listScheduledTasks(userId: string) {
    return (await this.db()).scheduledTasks.filter((item) => item.userId === userId);
  }

  async createScheduledTask(userId: string, input: NewScheduledTask) {
    return this.mutate((database) => {
      const timestamp = new Date().toISOString();
      const task = {
        id: randomUUID(),
        userId,
        title: input.title,
        description: input.description,
        scheduleExpression: input.scheduleExpression,
        timezone: input.timezone,
        status: input.status ?? "queued",
        nextRunAt: input.nextRunAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies import("./types").ScheduledTask;
      database.scheduledTasks.push(task);
      return task;
    });
  }

  async listPreferences(userId: string): Promise<UserPreference[]> {
    return (await this.db()).preferences.filter((item) => item.userId === userId);
  }

  async upsertPreference(userId: string, key: string, value: unknown): Promise<UserPreference> {
    return this.mutate((database) => {
      const existing = database.preferences.find(
        (preference) => preference.userId === userId && preference.key === key,
      );
      const updatedAt = new Date().toISOString();
      if (existing) {
        existing.value = value;
        existing.updatedAt = updatedAt;
        return { ...existing };
      }
      const preference: UserPreference = {
        id: randomUUID(),
        userId,
        key,
        value,
        updatedAt,
      };
      database.preferences.push(preference);
      return preference;
    });
  }
}
