import { describe, expect, it } from "vitest";

import { parseBriefingList, parseBriefingRun } from "@/lib/briefings";

const scheduler = {
  timezone: "America/New_York",
  crons: ["0 5 * * *", "0 13 * * *", "0 21 * * *"],
  loop_hours: 8,
  running: true,
  last_run: "2026-08-12T13:00:00+00:00",
  next_run: "2026-08-12T21:00:00-04:00",
  history_count: 1,
  active_run: null,
  delivery_queue: { queued: 0, running: 0, completed: 1, failed: 0 },
};

const briefing = {
  id: "briefing-1",
  timestamp: "2026-08-12T13:00:00+00:00",
  dryRun: false,
  successful: true,
  summary: "Current verified intelligence.",
  modelError: null,
  windowStart: "2026-08-12T05:00:00+00:00",
  windowEnd: "2026-08-12T13:00:00+00:00",
  scheduledSlot: "2026-08-12T09:00:00-04:00",
  delivery: {
    status: "played",
    utteranceId: "utterance-1",
    rendered: true,
    queued: false,
    played: true,
    reason: null,
    audio_path: "must-not-be-exposed.mp3",
  },
  nextRun: "2026-08-12T21:00:00-04:00",
  sources: {
    news: {
      success: true,
      count: 8,
      error: null,
      evidence: [
        {
          kind: "content",
          title: "Verified source",
          url: "https://example.test/report",
          published: "2026-08-12T12:00:00Z",
          source: "Example Wire",
        },
      ],
    },
    security_events: {
      success: true,
      count: 1,
      error: null,
      evidence: [
        {
          kind: "security",
          eventId: "evt-1",
          sourceEventId: "wazuh:source-1",
          timestamp: "2026-08-12T12:30:00Z",
          severity: 3,
          ruleId: "5710",
          source: "wazuh",
        },
      ],
    },
  },
  collected: { privateRawFeed: true },
};

describe("briefing RPC contract", () => {
  it("normalizes scheduler fields and strips unknown raw data", () => {
    const result = parseBriefingList({ briefings: [briefing], scheduler });

    expect(result.scheduler).toMatchObject({ loopHours: 8, historyCount: 1 });
    expect(result.scheduler.deliveryQueue.completed).toBe(1);
    expect(result.briefings[0]).not.toHaveProperty("collected");
    expect(result.briefings[0]?.sources.news.count).toBe(8);
    expect(result.briefings[0]?.sources.news.evidence[0]).toMatchObject({
      kind: "content",
      url: "https://example.test/report",
    });
    expect(result.briefings[0]?.windowStart).toBe("2026-08-12T05:00:00+00:00");
    expect(result.briefings[0]?.delivery).toEqual({
      status: "played",
      utteranceId: "utterance-1",
      rendered: true,
      queued: false,
      played: true,
      reason: null,
    });
  });

  it("parses a run-now response", () => {
    const result = parseBriefingRun({ briefing, scheduler, run_id: "ignored" });

    expect(result.briefing?.id).toBe("briefing-1");
    expect(result.scheduler.running).toBe(true);
    expect(result.busy).toBe(false);
  });

  it("preserves an explicit busy response", () => {
    const result = parseBriefingRun({ briefing: null, scheduler, busy: true });

    expect(result.busy).toBe(true);
    expect(result.briefing).toBeNull();
  });

  it("exposes a sanitized active-run snapshot", () => {
    const result = parseBriefingList({
      briefings: [briefing],
      scheduler: {
        ...scheduler,
        active_run: {
          kind: "scheduled",
          phase: "generating",
          started_at: "2026-08-12T17:00:02+00:00",
          scheduled_slot: "2026-08-12T13:00:00-04:00",
          prompt: "must not be exposed",
        },
      },
    });

    expect(result.scheduler.activeRun).toEqual({
      kind: "scheduled",
      phase: "generating",
      startedAt: "2026-08-12T17:00:02+00:00",
      scheduledSlot: "2026-08-12T13:00:00-04:00",
    });
    expect(result.scheduler.activeRun).not.toHaveProperty("prompt");
  });
});
