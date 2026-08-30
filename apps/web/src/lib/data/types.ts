export type MemoryType = "profile" | "semantic" | "episodic";
export type MessageRole = "user" | "assistant" | "system" | "tool";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "paused";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export interface MessageAttachment {
  name: string;
  mediaType: string;
  size: number;
  content: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  preferredName?: string;
  company?: string;
  roleTitle?: string;
  timezone: string;
  passwordHash?: string;
  onboardingCompletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  transcript?: string;
  audioReference?: string;
  attachments?: MessageAttachment[];
  sources: Array<{ title: string; url?: string; eventId?: string }>;
  memoryIds: string[];
  toolActivity: Array<{ label: string; status: string }>;
  createdAt: string;
}

export interface MemoryItem {
  id: string;
  userId: string;
  memoryType: MemoryType;
  title: string;
  content: string;
  importanceScore: number;
  confidenceScore: number;
  sourceMessageId?: string;
  isPinned: boolean;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  expiresAt?: string;
}

export interface AgentRun {
  id: string;
  userId: string;
  agentName: string;
  request: string;
  status: RunStatus;
  result?: unknown;
  success?: boolean;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export type NewAgentRun = Pick<AgentRun, "agentName" | "request"> &
  Partial<Pick<AgentRun, "status" | "result" | "startedAt">>;

export interface Automation {
  id: string;
  userId: string;
  name: string;
  description?: string;
  triggerConfig: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  status: RunStatus;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  userId: string;
  actionType: "automation.run";
  subjectType: "automation";
  subjectId: string;
  title: string;
  detail: Record<string, unknown>;
  argumentsHash: string;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt?: string;
  consumedAt?: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  userId: string;
  eventType: string;
  subjectType?: string;
  subjectId?: string;
  outcome: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface NewAutomationRunApproval {
  automationId: string;
  title: string;
  detail: string;
  scope: string[];
  argumentsHash: string;
  expiresAt: string;
}

export interface ConsumeAutomationRunApprovalInput {
  approvalId: string;
  automationId: string;
  argumentsHash: string;
}

export type AutomationRunApprovalRejection =
  | "invalid"
  | "expired"
  | "replayed"
  | "stale"
  | "not_runnable";

export type ConsumeAutomationRunApprovalResult =
  | {
      status: "consumed";
      approval: Approval;
      automation: Automation;
      run: AgentRun;
      auditEvent: AuditEvent;
    }
  | {
      status: AutomationRunApprovalRejection;
      auditEvent: AuditEvent;
    };

export type NewAuditEvent = Pick<AuditEvent, "eventType" | "outcome" | "detail"> &
  Partial<Pick<AuditEvent, "subjectType" | "subjectId">>;

export type NewAutomation = Pick<Automation, "name" | "triggerConfig" | "steps"> &
  Partial<Pick<Automation, "description" | "status" | "nextRunAt">>;

export interface ScheduledTask {
  id: string;
  userId: string;
  title: string;
  description?: string;
  scheduleExpression: string;
  timezone: string;
  status: RunStatus;
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type NewScheduledTask = Pick<
  ScheduledTask,
  "title" | "scheduleExpression" | "timezone"
> &
  Partial<Pick<ScheduledTask, "description" | "nextRunAt" | "status">>;

export interface UserPreference {
  id: string;
  userId: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface CompleteOnboardingInput {
  profile: Pick<User, "displayName" | "timezone"> & { preferredName: string };
  preferences: ReadonlyArray<Pick<UserPreference, "key" | "value">>;
}

export interface OnboardingCompletion {
  user: User;
  preferences: UserPreference[];
}

export type NewMemoryItem = Pick<MemoryItem, "memoryType" | "title" | "content"> &
  Partial<
    Pick<
      MemoryItem,
      "importanceScore" | "confidenceScore" | "sourceMessageId" | "isPinned" | "expiresAt"
    >
  >;

export interface DataStore {
  findUserById(id: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  createUser(input: Pick<User, "email" | "displayName" | "timezone"> & { passwordHash?: string }): Promise<User>;
  updateUser(id: string, changes: Partial<User>): Promise<User>;
  createSession(userId: string, tokenHash: string, expiresAt: string): Promise<Session>;
  completeOnboarding(userId: string, input: CompleteOnboardingInput): Promise<OnboardingCompletion>;
  findSession(tokenHash: string): Promise<Session | null>;
  deleteSession(tokenHash: string): Promise<void>;
  listConversations(userId: string): Promise<Conversation[]>;
  findConversation(userId: string, id: string): Promise<Conversation | null>;
  createConversation(userId: string, title?: string): Promise<Conversation>;
  updateConversation(userId: string, id: string, changes: Partial<Conversation>): Promise<Conversation>;
  deleteAllConversations(userId: string): Promise<number>;
  listMessages(userId: string, conversationId: string): Promise<Message[]>;
  createMessage(userId: string, input: Omit<Message, "id" | "createdAt">): Promise<Message>;
  listMemories(userId: string): Promise<MemoryItem[]>;
  createMemory(userId: string, item: NewMemoryItem): Promise<MemoryItem>;
  updateMemory(userId: string, id: string, changes: Partial<MemoryItem>): Promise<MemoryItem>;
  deleteMemory(userId: string, id: string): Promise<void>;
  deleteAllMemories(userId: string): Promise<number>;
  listAgentRuns(userId: string): Promise<AgentRun[]>;
  createAgentRun(userId: string, input: NewAgentRun): Promise<AgentRun>;
  updateAgentRun(userId: string, id: string, changes: Partial<AgentRun>): Promise<AgentRun>;
  claimNextAgentRun(): Promise<AgentRun | null>;
  listAutomations(userId: string): Promise<Automation[]>;
  createAutomation(userId: string, input: NewAutomation): Promise<Automation>;
  updateAutomation(userId: string, id: string, changes: Partial<Automation>): Promise<Automation>;
  createAutomationRunApproval(
    userId: string,
    input: NewAutomationRunApproval,
  ): Promise<Approval>;
  consumeAutomationRunApproval(
    userId: string,
    input: ConsumeAutomationRunApprovalInput,
  ): Promise<ConsumeAutomationRunApprovalResult>;
  createAuditEvent(userId: string, input: NewAuditEvent): Promise<AuditEvent>;
  listAuditEvents(userId: string, limit?: number): Promise<AuditEvent[]>;
  listScheduledTasks(userId: string): Promise<ScheduledTask[]>;
  createScheduledTask(userId: string, input: NewScheduledTask): Promise<ScheduledTask>;
  listPreferences(userId: string): Promise<UserPreference[]>;
  upsertPreference(userId: string, key: string, value: unknown): Promise<UserPreference>;
}
