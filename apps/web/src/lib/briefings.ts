import { z } from "zod";

const contentEvidenceSchema = z.object({
  kind: z.literal("content"),
  title: z.string().min(1).max(500),
  url: z.string().url().refine((url) => url.startsWith("https://"), "HTTPS URL required"),
  published: z.string().max(100).nullable(),
  source: z.string().max(300).nullable(),
});

const securityEvidenceSchema = z
  .object({
    kind: z.literal("security"),
    eventId: z.string().max(500).nullable(),
    sourceEventId: z.string().max(500).nullable(),
    timestamp: z.string().datetime({ offset: true }).nullable(),
    severity: z.number().int().min(0).max(100),
    ruleId: z.string().max(500).nullable(),
    source: z.string().max(300).nullable(),
  })
  .refine((item) => Boolean(item.eventId || item.sourceEventId), {
    message: "Security evidence requires a stable event identifier",
  });

export const briefingEvidenceSchema = z.union([
  contentEvidenceSchema,
  securityEvidenceSchema,
]);

const briefingDeliverySchema = z.object({
  status: z.enum([
    "pending",
    "not_requested",
    "unavailable",
    "render_failed",
    "queued",
    "played",
    "play_failed",
    "delivery_failed",
    "unknown",
  ]),
  utteranceId: z.string().max(500).nullable(),
  rendered: z.boolean(),
  queued: z.boolean(),
  played: z.boolean(),
  reason: z.string().max(500).nullable(),
});

const sourceStatusSchema = z.object({
  success: z.boolean(),
  count: z.number().int().nonnegative(),
  error: z.string().nullable(),
  evidence: z.array(briefingEvidenceSchema).max(20),
});

export const briefingRecordSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  dryRun: z.boolean(),
  successful: z.boolean(),
  summary: z.string(),
  modelError: z.string().nullable(),
  windowStart: z.string().datetime({ offset: true }).nullable(),
  windowEnd: z.string().datetime({ offset: true }).nullable(),
  scheduledSlot: z.string().datetime({ offset: true }).nullable(),
  delivery: briefingDeliverySchema,
  nextRun: z.string().datetime({ offset: true }).nullable(),
  sources: z.record(z.string(), sourceStatusSchema),
});

const activeRunSchema = z.object({
  kind: z.enum(["scheduled", "manual", "source_test"]),
  phase: z.enum([
    "starting",
    "collecting",
    "generating",
    "archiving",
    "queueing_voice",
  ]),
  started_at: z.string().datetime({ offset: true }),
  scheduled_slot: z.string().datetime({ offset: true }).nullable(),
});

const deliveryQueueSchema = z.object({
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

const rpcSchedulerSchema = z.object({
  timezone: z.string(),
  crons: z.array(z.string()),
  loop_hours: z.number().int().positive(),
  running: z.boolean(),
  last_run: z.string().datetime({ offset: true }).nullable(),
  next_run: z.string().datetime({ offset: true }).nullable(),
  history_count: z.number().int().nonnegative(),
  active_run: activeRunSchema.nullable(),
  delivery_queue: deliveryQueueSchema,
});

const rpcListSchema = z.object({
  briefings: z.array(briefingRecordSchema),
  scheduler: rpcSchedulerSchema,
});

const rpcRunSchema = z.object({
  briefing: briefingRecordSchema.nullable(),
  scheduler: rpcSchedulerSchema,
  busy: z.boolean().optional().default(false),
});

export type BriefingRecord = z.infer<typeof briefingRecordSchema>;

export interface ActiveBriefingRun {
  kind: "scheduled" | "manual" | "source_test";
  phase: "starting" | "collecting" | "generating" | "archiving" | "queueing_voice";
  startedAt: string;
  scheduledSlot: string | null;
}

export interface BriefingSchedulerStatus {
  timezone: string;
  crons: string[];
  loopHours: number;
  running: boolean;
  lastRun: string | null;
  nextRun: string | null;
  historyCount: number;
  activeRun: ActiveBriefingRun | null;
  deliveryQueue: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
  };
}

export interface BriefingListResponse {
  briefings: BriefingRecord[];
  scheduler: BriefingSchedulerStatus;
}

function schedulerResponse(scheduler: z.infer<typeof rpcSchedulerSchema>): BriefingSchedulerStatus {
  return {
    timezone: scheduler.timezone,
    crons: scheduler.crons,
    loopHours: scheduler.loop_hours,
    running: scheduler.running,
    lastRun: scheduler.last_run,
    nextRun: scheduler.next_run,
    historyCount: scheduler.history_count,
    activeRun: scheduler.active_run
      ? {
          kind: scheduler.active_run.kind,
          phase: scheduler.active_run.phase,
          startedAt: scheduler.active_run.started_at,
          scheduledSlot: scheduler.active_run.scheduled_slot,
      }
      : null,
    deliveryQueue: scheduler.delivery_queue,
  };
}

export function parseBriefingList(input: unknown): BriefingListResponse {
  const parsed = rpcListSchema.parse(input);
  return {
    briefings: parsed.briefings,
    scheduler: schedulerResponse(parsed.scheduler),
  };
}

export function parseBriefingRun(input: unknown): {
  briefing: BriefingRecord | null;
  scheduler: BriefingSchedulerStatus;
  busy: boolean;
} {
  const parsed = rpcRunSchema.parse(input);
  return {
    briefing: parsed.briefing,
    scheduler: schedulerResponse(parsed.scheduler),
    busy: parsed.busy,
  };
}
