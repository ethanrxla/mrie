import { z } from "zod";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function cleanText(value: string, maximum: number): string {
  return value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function safeText(maximum: number) {
  return z.string().max(maximum * 4).transform((value) => cleanText(value, maximum));
}

function optionalText(maximum: number) {
  return safeText(maximum).nullable();
}

const securityEventSchema = z.object({
  event_id: safeText(128).pipe(z.string().min(1)),
  occurred_at: z.string().datetime({ offset: true }),
  observed_at: z.string().datetime({ offset: true }),
  source: safeText(100).pipe(z.string().min(1)),
  source_event_id: safeText(500).pipe(z.string().min(1)),
  category: safeText(100).pipe(z.string().min(1)),
  severity: z.number().int().min(0).max(4),
  title: safeText(500).pipe(z.string().min(1)),
  asset: optionalText(500),
  actor: optionalText(500),
  rule_id: optionalText(100),
  tags: z.array(safeText(100).pipe(z.string().min(1))).max(25),
});

const countsSchema = z.record(z.string(), z.number().int().nonnegative());
const capabilityErrorSchema = safeText(500).nullable();

const eventResultSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    data: z.object({
      events: z.array(securityEventSchema).max(500),
      counts_by_severity: countsSchema,
    }),
    error: z.null(),
  }),
  z.object({
    success: z.literal(false),
    data: z.unknown().nullable(),
    error: capabilityErrorSchema,
  }),
]);

const probeSchema = z.object({
  state: z.enum(["connected", "unconfigured", "error", "unavailable"]),
  error: capabilityErrorSchema,
});

const statusSchema = z.object({
  checked_at: z.string().datetime({ offset: true }),
  wazuh: z.object({
    state: z.enum(["connected", "partial", "unconfigured", "error", "unavailable"]),
    checked_at: z.string().datetime({ offset: true }),
    manager: probeSchema,
    indexer: probeSchema,
  }),
  honeypot: z.object({
    state: z.enum(["configured", "disabled", "unavailable", "error"]),
    enabled: z.boolean(),
    sensor_count: z.number().int().min(0).max(10_000),
    mode: z.literal("passive-observation-only"),
    error: capabilityErrorSchema,
  }),
});

export type SecurityEvent = {
  id: string;
  occurredAt: string;
  observedAt: string;
  source: string;
  sourceEventId: string;
  category: string;
  severity: number;
  title: string;
  asset: string | null;
  actor: string | null;
  ruleId: string | null;
  tags: string[];
};

export type WazuhStatus = {
  state: "connected" | "partial" | "unconfigured" | "error" | "unavailable";
  checkedAt: string;
  manager: z.infer<typeof probeSchema>;
  indexer: z.infer<typeof probeSchema>;
};

export type SecurityConsoleResponse = {
  events: SecurityEvent[];
  countsBySeverity: Record<string, number>;
  eventStore: { state: "available" | "error"; error: string | null };
  checkedAt: string;
  wazuh: WazuhStatus;
  honeypot: {
    state: "configured" | "disabled" | "unavailable" | "error";
    enabled: boolean;
    sensorCount: number;
    mode: "passive-observation-only";
    error: string | null;
  };
};

export function parseSecurityConsole(
  eventInput: unknown,
  statusInput: unknown,
): SecurityConsoleResponse {
  const eventResult = eventResultSchema.parse(eventInput);
  const status = statusSchema.parse(statusInput);
  const events = eventResult.success
    ? eventResult.data.events.map((event) => ({
        id: event.event_id,
        occurredAt: event.occurred_at,
        observedAt: event.observed_at,
        source: event.source,
        sourceEventId: event.source_event_id,
        category: event.category,
        severity: event.severity,
        title: event.title,
        asset: event.asset,
        actor: event.actor,
        ruleId: event.rule_id,
        tags: event.tags,
      }))
    : [];

  return {
    events,
    countsBySeverity: eventResult.success ? eventResult.data.counts_by_severity : {},
    eventStore: {
      state: eventResult.success ? "available" : "error",
      error: eventResult.success ? null : eventResult.error || "Security event store failed",
    },
    checkedAt: status.checked_at,
    wazuh: {
      state: status.wazuh.state,
      checkedAt: status.wazuh.checked_at,
      manager: status.wazuh.manager,
      indexer: status.wazuh.indexer,
    },
    honeypot: {
      state: status.honeypot.state,
      enabled: status.honeypot.enabled,
      sensorCount: status.honeypot.sensor_count,
      mode: status.honeypot.mode,
      error: status.honeypot.error,
    },
  };
}
