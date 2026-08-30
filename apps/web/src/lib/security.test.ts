import { describe, expect, it } from "vitest";

import { parseSecurityConsole } from "@/lib/security";

const status = {
  checked_at: "2026-08-12T18:00:00+00:00",
  wazuh: {
    state: "connected",
    checked_at: "2026-08-12T18:00:00+00:00",
    manager: { state: "connected", error: null },
    indexer: { state: "connected", error: null },
    raw_manager_response: { secret: true },
  },
  honeypot: {
    state: "disabled",
    enabled: false,
    sensor_count: 0,
    mode: "passive-observation-only",
    error: null,
    sensors: [{ credentials: "never expose" }],
  },
};

describe("security console RPC contract", () => {
  it("sanitizes normalized events and strips raw evidence", () => {
    const result = parseSecurityConsole(
      {
        success: true,
        error: null,
        data: {
          events: [
            {
              event_id: "event-1",
              occurred_at: "2026-08-12T17:59:00+00:00",
              observed_at: "2026-08-12T18:00:00+00:00",
              source: "wazuh",
              source_event_id: "wazuh-alerts:alert-1",
              category: "authentication",
              severity: 3,
              title: "Failed\u0007 login",
              asset: "edge-01",
              actor: "198.51.100.8",
              rule_id: "5710",
              tags: ["authentication_failed"],
              evidence: { hostile: "raw input" },
              raw_sha256: "abc",
            },
          ],
          counts_by_severity: { "3": 1 },
        },
      },
      status,
    );

    expect(result.events[0]).toMatchObject({
      id: "event-1",
      title: "Failed login",
      sourceEventId: "wazuh-alerts:alert-1",
    });
    expect(result.events[0]).not.toHaveProperty("evidence");
    expect(result.wazuh.state).toBe("connected");
    expect(result.wazuh).not.toHaveProperty("raw_manager_response");
    expect(result.honeypot).not.toHaveProperty("sensors");
  });

  it("preserves source errors without inventing events", () => {
    const result = parseSecurityConsole(
      { success: false, data: null, error: "Local event cache unavailable" },
      {
        ...status,
        wazuh: {
          ...status.wazuh,
          state: "unconfigured",
          manager: { state: "unconfigured", error: "Manager is not configured" },
          indexer: { state: "unconfigured", error: "Indexer is not configured" },
        },
      },
    );

    expect(result.events).toEqual([]);
    expect(result.eventStore).toEqual({
      state: "error",
      error: "Local event cache unavailable",
    });
    expect(result.wazuh.state).toBe("unconfigured");
  });

  it("rejects out-of-contract severity values", () => {
    expect(() =>
      parseSecurityConsole(
        {
          success: true,
          error: null,
          data: {
            events: [
              {
                event_id: "event-1",
                occurred_at: "2026-08-12T17:59:00+00:00",
                observed_at: "2026-08-12T18:00:00+00:00",
                source: "wazuh",
                source_event_id: "alert-1",
                category: "network",
                severity: 9,
                title: "Invalid severity",
                asset: null,
                actor: null,
                rule_id: null,
                tags: [],
              },
            ],
            counts_by_severity: {},
          },
        },
        status,
      ),
    ).toThrow();
  });
});
