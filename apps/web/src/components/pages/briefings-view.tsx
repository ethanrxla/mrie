"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FlaskConical,
  Newspaper,
  Play,
  RefreshCw,
  Square,
  ShieldAlert,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useSpeechOutput } from "@/components/hooks/use-speech-output";
import { MetricCard, PageScaffold } from "@/components/pages/page-scaffold";
import type {
  BriefingListResponse,
  BriefingRecord,
  BriefingSchedulerStatus,
} from "@/lib/briefings";

interface BriefingRunResponse {
  briefing: BriefingRecord | null;
  scheduler: BriefingSchedulerStatus;
  busy: boolean;
}

export function BriefingsView() {
  const [briefings, setBriefings] = useState<BriefingRecord[]>([]);
  const [scheduler, setScheduler] = useState<BriefingSchedulerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<"dry" | "live" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const speech = useSpeechOutput();
  const activeRun = scheduler?.activeRun ?? null;
  const pendingVoiceDeliveries = scheduler
    ? scheduler.deliveryQueue.queued + scheduler.deliveryQueue.running
    : 0;
  const runBusy = running !== null || activeRun !== null;
  const shouldPoll = runBusy || pendingVoiceDeliveries > 0;

  const load = useCallback(async (signal?: AbortSignal): Promise<BriefingListResponse> => {
    const response = await fetch("/api/briefings?limit=50", { signal });
    const payload = await readJson<Partial<BriefingListResponse> & ApiErrorPayload>(response);
    if (!response.ok || !payload.briefings || !payload.scheduler) {
      throw new Error(apiErrorMessage(payload, "MRE could not load the briefing archive."));
    }
    return { briefings: payload.briefings, scheduler: payload.scheduler };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .then((payload) => {
        setBriefings(payload.briefings);
        setScheduler(payload.scheduler);
      })
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(errorMessage(caught, "MRE could not load the briefing archive."));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!shouldPoll) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const payload = await load();
        if (cancelled) return;
        setBriefings(payload.briefings);
        setScheduler(payload.scheduler);
      } catch {
        // The foreground request reports errors. A transient status-poll failure
        // must not erase the last truthful active-run snapshot.
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 2_000);
      }
    };

    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, shouldPoll]);

  const runBriefing = async (dryRun: boolean) => {
    if (activeRun) {
      setNotice("A briefing is already in progress. MRE will refresh this page when it completes.");
      return;
    }
    setRunning(dryRun ? "dry" : "live");
    setError(null);
    setNotice(null);
    speech.stop();
    try {
      const response = await fetch("/api/briefings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const payload = await readJson<Partial<BriefingRunResponse> & ApiErrorPayload>(response);
      if (response.status === 409 && payload.scheduler) {
        setScheduler(payload.scheduler);
        setNotice("A briefing is already in progress. MRE will refresh this page when it completes.");
        return;
      }
      if (!response.ok || !payload.scheduler) {
        throw new Error(apiErrorMessage(payload, "MRE could not run the briefing."));
      }
      setScheduler(payload.scheduler);
      if (payload.briefing) {
        setBriefings((current) => [
          payload.briefing!,
          ...current.filter((item) => item.id !== payload.briefing!.id),
        ]);
      }
      setNotice(
        dryRun
          ? "Source collection completed and was archived without model narration."
          : "The briefing was generated, archived, and submitted to MRE's speech-rendering path.",
      );
    } catch (caught) {
      setError(errorMessage(caught, "MRE could not run the briefing."));
      try {
        const payload = await load();
        setBriefings(payload.briefings);
        setScheduler(payload.scheduler);
      } catch {
        // Keep the foreground error and the last known scheduler snapshot.
      }
    } finally {
      setRunning(null);
    }
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await load();
      setBriefings(payload.briefings);
      setScheduler(payload.scheduler);
      setNotice("Briefing status refreshed from the MRE runtime.");
    } catch (caught) {
      setError(errorMessage(caught, "MRE could not refresh the briefing archive."));
    } finally {
      setLoading(false);
    }
  };

  const healthySources = useMemo(() => {
    const latest = briefings[0];
    if (!latest) return 0;
    return Object.values(latest.sources).filter((source) => source.success).length;
  }, [briefings]);

  return (
    <PageScaffold
      eyebrow="Intelligence"
      title="Briefing archive"
      description="Inspect real source collection, run MRE's intelligence cycle, and hear archived reports. No sample events are shown."
      icon={Newspaper}
      actions={
        <>
          <button className="button button--secondary" type="button" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? "spin" : undefined} size={15} /> Refresh
          </button>
          <button className="button button--secondary" type="button" onClick={() => void runBriefing(true)} disabled={loading || runBusy}>
            <FlaskConical size={15} /> {running === "dry" ? "Testing sources..." : activeRun ? "Run in progress" : "Test sources"}
          </button>
          <button className="button button--primary" type="button" onClick={() => void runBriefing(false)} disabled={loading || runBusy}>
            <Play size={15} /> {running === "live" ? "Running..." : activeRun ? "Run in progress" : "Run briefing"}
          </button>
        </>
      }
    >
      {notice && (
        <div className="inline-notice" role="status">
          <CheckCircle2 size={15} aria-hidden="true" />
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {activeRun && (
        <div className="inline-notice inline-notice--active" role="status" aria-live="polite">
          <RefreshCw className="spin" size={15} aria-hidden="true" />
          <span>
            <strong>{activeRunKindLabel(activeRun.kind)}</strong>
            {` · ${activeRunPhaseLabel(activeRun.phase)} · started ${formatFullDate(activeRun.startedAt)}`}
            {activeRun.scheduledSlot ? ` · scheduled for ${formatFullDate(activeRun.scheduledSlot)}` : ""}
          </span>
        </div>
      )}
      {!activeRun && pendingVoiceDeliveries > 0 && (
        <div className="inline-notice inline-notice--active" role="status" aria-live="polite">
          <Volume2 size={15} aria-hidden="true" />
          <span>
            <strong>Spoken delivery in progress</strong>
            {` · ${scheduler?.deliveryQueue.running ?? 0} playing · ${scheduler?.deliveryQueue.queued ?? 0} queued`}
          </span>
        </div>
      )}
      {error && (
        <div className="inline-notice inline-notice--warning" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {speech.error && (
        <div className="inline-notice inline-notice--warning" role="status">
          <Volume2 size={15} aria-hidden="true" /><span>{speech.error}</span>
        </div>
      )}

      <div className="metric-grid">
        <MetricCard
          label="Scheduler"
          value={activeRun ? "Running now" : scheduler?.running ? "Active" : "Offline"}
          detail={activeRun ? activeRunPhaseLabel(activeRun.phase) : scheduler ? `${scheduler.timezone} · every ${scheduler.loopHours} hours` : "waiting for runtime status"}
        />
        <MetricCard
          label="Next report"
          value={activeRun?.kind === "scheduled" ? "Catch-up underway" : scheduler?.nextRun ? formatShortDate(scheduler.nextRun) : "Not scheduled"}
          detail={activeRun?.scheduledSlot ? `Current slot ${formatShortDate(activeRun.scheduledSlot)}` : scheduler?.crons.length ? scheduler.crons.join(" · ") : "no schedule returned"}
        />
        <MetricCard
          label="Archived"
          value={String(scheduler?.historyCount ?? briefings.length)}
          detail={pendingVoiceDeliveries ? `${pendingVoiceDeliveries} spoken delivery pending` : "completed briefing records"}
        />
        <MetricCard
          label="Latest sources"
          value={briefings[0] ? `${healthySources}/${Object.keys(briefings[0].sources).length}` : "—"}
          detail="reported successful by collectors"
        />
      </div>

      {loading && !briefings.length ? (
        <div className="loading-line" role="status"><span />{"Loading MRE's briefing archive..."}</div>
      ) : !briefings.length ? (
        <section className="empty-state">
          <Newspaper size={28} aria-hidden="true" />
          <h2>No briefings have been archived</h2>
          <p>Test the configured sources or run a briefing. MRE will show only results returned by the live runtime.</p>
        </section>
      ) : (
        <section className="briefing-list" aria-label="Archived briefings">
          <div className="section-heading">
            <div><h2>Completed intelligence cycles</h2><p>Newest first. Source errors remain visible instead of being replaced with sample data.</p></div>
          </div>
          {briefings.map((briefing) => (
            <BriefingCard
              key={briefing.id}
              briefing={briefing}
              speaking={speech.speaking}
              onPlay={() => void speech.speak(briefing.summary)}
              onStop={speech.stop}
            />
          ))}
        </section>
      )}
    </PageScaffold>
  );
}

function BriefingCard({
  briefing,
  speaking,
  onPlay,
  onStop,
}: {
  briefing: BriefingRecord;
  speaking: boolean;
  onPlay: () => void;
  onStop: () => void;
}) {
  const sources = Object.entries(briefing.sources);
  const evidence = sources.flatMap(([sourceName, status]) =>
    status.evidence.map((item) => ({ sourceName, item })),
  );
  const unavailableSources = sources
    .filter(([, status]) => !status.success)
    .map(([sourceName]) => sourceLabel(sourceName));
  const securityCoverageIncomplete = unavailableSources.some((source) =>
    source === "Wazuh Sync" || source === "Security Events" || source === "Honeypot",
  );
  return (
    <article className="briefing-card">
      <header>
        <div>
          <span className={`status-pill ${briefing.modelError ? "status-pill--waiting" : "status-pill--completed"}`}>
            <span />{briefing.dryRun ? "Source test" : briefing.modelError ? "Fallback report" : "Briefing complete"}
          </span>
          <span
            className={`status-pill ${deliveryStatusClass(briefing.delivery.status)}`}
            title={briefing.delivery.reason || undefined}
          >
            <span />{deliveryStatusLabel(briefing.delivery.status)}
          </span>
          <time dateTime={briefing.timestamp}><Clock3 size={12} aria-hidden="true" />{formatFullDate(briefing.timestamp)}</time>
          {briefing.windowStart && briefing.windowEnd && (
            <span className="briefing-window">Evidence window {formatFullDate(briefing.windowStart)} – {formatFullDate(briefing.windowEnd)}</span>
          )}
        </div>
        {briefing.summary && (
          <button className="button button--ghost" type="button" onClick={speaking ? onStop : onPlay}>
            {speaking ? <Square size={13} fill="currentColor" /> : <Volume2 size={15} />}
            {speaking ? "Stop voice" : "Play with MRE voice"}
          </button>
        )}
      </header>
      {unavailableSources.length > 0 && (
        <p className="briefing-card__warning" role="note">
          <AlertTriangle size={13} aria-hidden="true" />
          Coverage incomplete: {unavailableSources.join(", ")} unavailable.
          {securityCoverageIncomplete
            ? " Empty cached security results do not prove that no incident occurred."
            : " Conclusions are limited to the sources that completed successfully."}
        </p>
      )}
      {briefing.modelError && <p className="briefing-card__warning"><AlertTriangle size={13} />Model error: {briefing.modelError}</p>}
      <p className="briefing-card__summary">{briefing.summary || "Source collection completed without a narrated summary."}</p>
      <div className="briefing-sources" aria-label="Source collection status">
        {sources.map(([name, source]) => (
          <div className={source.success ? "is-success" : "is-error"} key={name}>
            {source.success ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            <span><strong>{sourceLabel(name)}</strong><small>{source.success ? `${source.count} item${source.count === 1 ? "" : "s"}` : source.error || "Collector failed"}</small></span>
          </div>
        ))}
      </div>
      {evidence.length > 0 && (
        <section className="briefing-evidence" aria-label="Archived source evidence">
          <header><h3>Evidence references</h3><span>{evidence.length} archived</span></header>
          <div>
            {evidence.map(({ sourceName, item }, index) => item.kind === "content" ? (
              <a href={item.url} key={`${sourceName}:${item.url}`} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={13} aria-hidden="true" />
                <span><strong>{item.title}</strong><small>{item.source || sourceLabel(sourceName)}{item.published ? ` · ${item.published}` : ""}</small></span>
              </a>
            ) : (
              <div key={`${sourceName}:${item.eventId || item.sourceEventId || index}`}>
                <ShieldAlert size={13} aria-hidden="true" />
                <span><strong>{sourceLabel(sourceName)} · severity {item.severity}</strong><small>Event {item.eventId || item.sourceEventId}{item.ruleId ? ` · rule ${item.ruleId}` : ""}</small></span>
              </div>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { return {} as T; }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface ApiErrorPayload {
  error?: string | { message?: string };
}

function apiErrorMessage(payload: ApiErrorPayload, fallback: string): string {
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message || fallback;
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatFullDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function sourceLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activeRunKindLabel(kind: NonNullable<BriefingSchedulerStatus["activeRun"]>["kind"]): string {
  if (kind === "scheduled") return "Scheduled briefing in progress";
  if (kind === "source_test") return "Source test in progress";
  return "Manual briefing in progress";
}

function activeRunPhaseLabel(phase: NonNullable<BriefingSchedulerStatus["activeRun"]>["phase"]): string {
  const labels: Record<NonNullable<BriefingSchedulerStatus["activeRun"]>["phase"], string> = {
    starting: "Starting",
    collecting: "Collecting live sources",
    generating: "Generating the report",
    archiving: "Archiving the report",
    queueing_voice: "Queueing spoken delivery",
  };
  return labels[phase];
}

function deliveryStatusLabel(status: BriefingRecord["delivery"]["status"]): string {
  const labels: Record<BriefingRecord["delivery"]["status"], string> = {
    pending: "Voice pending",
    not_requested: "Voice not requested",
    unavailable: "Voice unavailable",
    render_failed: "Voice render failed",
    queued: "Voice queued",
    played: "Voice played",
    play_failed: "Voice playback failed",
    delivery_failed: "Voice delivery failed",
    unknown: "Voice status unknown",
  };
  return labels[status];
}

function deliveryStatusClass(status: BriefingRecord["delivery"]["status"]): string {
  if (status === "played") return "status-pill--completed";
  if (status === "queued" || status === "pending") return "status-pill--queued";
  if (status === "not_requested") return "status-pill--paused";
  return "status-pill--waiting";
}
