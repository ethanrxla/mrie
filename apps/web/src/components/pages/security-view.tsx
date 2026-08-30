"use client";

import {
  AlertTriangle,
  Database,
  Eye,
  Filter,
  Radar,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { MetricCard, PageScaffold } from "@/components/pages/page-scaffold";
import type { SecurityConsoleResponse, SecurityEvent } from "@/lib/security";

const SEVERITIES = [
  { value: 4, label: "Critical" },
  { value: 3, label: "High" },
  { value: 2, label: "Medium" },
  { value: 1, label: "Low" },
  { value: 0, label: "Informational" },
] as const;

export function SecurityView() {
  const [data, setData] = useState<SecurityConsoleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("all");
  const [source, setSource] = useState("all");
  const [category, setCategory] = useState("all");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setData(await requestSecurityConsole(signal));
    } catch (loadError) {
      if (signal?.aborted) return;
      setError(errorMessage(loadError, "MRE security data could not be loaded."));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const refreshFromSubscription = async () => {
      try {
        const response = await requestSecurityConsole(controller.signal);
        if (!controller.signal.aborted) {
          setData(response);
          setError(null);
        }
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(errorMessage(loadError, "MRE security data could not be loaded."));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void refreshFromSubscription();
    const interval = window.setInterval(() => void refreshFromSubscription(), 60_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const sources = useMemo(
    () => uniqueSorted(data?.events.map((event) => event.source) ?? []),
    [data],
  );
  const categories = useMemo(
    () => uniqueSorted(data?.events.map((event) => event.category) ?? []),
    [data],
  );
  const filteredEvents = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (data?.events ?? []).filter((event) => {
      if (severity !== "all" && event.severity !== Number(severity)) return false;
      if (source !== "all" && event.source !== source) return false;
      if (category !== "all" && event.category !== category) return false;
      if (!needle) return true;
      return [
        event.title,
        event.asset,
        event.actor,
        event.ruleId,
        event.source,
        event.sourceEventId,
        ...event.tags,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [category, data, query, severity, source]);

  const totalStored = Object.values(data?.countsBySeverity ?? {}).reduce(
    (total, count) => total + count,
    0,
  );
  const checkedAt = data ? formatDate(data.checkedAt) : "Not checked";

  return (
    <PageScaffold
      eyebrow="Sentinel"
      title="Security console"
      description="Read-only normalized Wazuh and honeypot evidence from MRE's durable local event store."
      icon={ShieldCheck}
      actions={
        <>
          <span className="security-readonly"><Eye size={13} />Read-only</span>
          <button
            className="button button--secondary"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            <RefreshCw className={loading ? "spin" : undefined} size={14} />
            Refresh
          </button>
        </>
      }
    >
      <div className="security-metrics" aria-label="Security event summary">
        <MetricCard label="Stored events" value={String(totalStored)} detail="normalized durable records" />
        <MetricCard label="Critical" value={countFor(data, 4)} detail="severity 4" />
        <MetricCard label="High" value={countFor(data, 3)} detail="severity 3" />
        <MetricCard label="Last probe" value={checkedAt} detail="manager and indexer" />
      </div>

      {error && !data && (
        <section className="security-offline" role="alert">
          <AlertTriangle size={22} />
          <div><h2>Security runtime unavailable</h2><p>{error}</p></div>
          <button className="button button--secondary" onClick={() => void load()} type="button">Retry</button>
        </section>
      )}

      {data && (
        <>
          {error && <div className="security-inline-error" role="status"><AlertTriangle size={14} />Refresh failed; showing the last verified response. {error}</div>}
          <section className="security-source-grid" aria-label="Security source status">
            <SourceStatusCard
              icon={Server}
              title="Wazuh"
              state={data.wazuh.state}
              detail={`Manager: ${stateLabel(data.wazuh.manager.state)} · Indexer: ${stateLabel(data.wazuh.indexer.state)}`}
              error={[data.wazuh.manager.error, data.wazuh.indexer.error].filter(Boolean).join(" · ") || null}
            />
            <SourceStatusCard
              icon={Radar}
              title="Honeypot telemetry"
              state={data.honeypot.state}
              detail={
                data.honeypot.enabled
                  ? `${data.honeypot.sensorCount} sensor configuration${data.honeypot.sensorCount === 1 ? "" : "s"}; connectivity is not claimed`
                  : "Disabled in MRE configuration"
              }
              error={data.honeypot.error}
            />
            <SourceStatusCard
              icon={Database}
              title="Normalized event store"
              state={data.eventStore.state}
              detail={data.eventStore.state === "available" ? `${data.events.length} recent records loaded` : "Local cache read failed"}
              error={data.eventStore.error}
            />
          </section>

          <section className="security-events" aria-labelledby="security-events-heading">
            <header className="security-events__header">
              <div>
                <h2 id="security-events-heading">Normalized security events</h2>
                <p>Showing {filteredEvents.length} of {data.events.length} loaded records · checked {checkedAt}</p>
              </div>
              <span><ShieldCheck size={13} />No active response controls</span>
            </header>

            <div className="security-filters" aria-label="Event filters">
              <label className="security-search">
                <span className="sr-only">Search security events</span>
                <Search size={14} aria-hidden="true" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, asset, actor, rule, or source ID" />
              </label>
              <label><Filter size={13} aria-hidden="true" /><span className="sr-only">Severity</span><select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">All severities</option>{SEVERITIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              <label><span className="sr-only">Source</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{sources.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <label><span className="sr-only">Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></label>
            </div>

            {data.eventStore.state === "error" ? (
              <SecurityEmpty icon={Database} title="Event store unavailable" detail={data.eventStore.error || "MRE could not read its normalized security event store."} />
            ) : data.events.length === 0 ? (
              <SecurityEmpty
                icon={ShieldCheck}
                title="No normalized events stored"
                detail={data.wazuh.state === "unconfigured" ? "Wazuh manager and indexer are not configured. MRE is not claiming a live security connection." : "The live MRE store returned no events for this window."}
              />
            ) : filteredEvents.length === 0 ? (
              <SecurityEmpty icon={Search} title="No events match these filters" detail="Clear or adjust the filters to inspect the loaded records." />
            ) : (
              <div className="security-event-list">
                {filteredEvents.map((event) => <SecurityEventCard event={event} key={event.id} />)}
              </div>
            )}
          </section>
        </>
      )}

      {loading && !data && <SecurityEmpty icon={Radar} title="Checking the sentinel plane" detail="MRE is reading its local event store and probing configured Wazuh endpoints." />}
    </PageScaffold>
  );
}

function SourceStatusCard({
  icon: Icon,
  title,
  state,
  detail,
  error,
}: {
  icon: typeof Server;
  title: string;
  state: string;
  detail: string;
  error: string | null;
}) {
  return (
    <article className={`security-source-card security-source-card--${state}`}>
      <span><Icon size={18} /></span>
      <div><small>{title}</small><strong>{stateLabel(state)}</strong><p>{detail}</p>{error && <em>{error}</em>}</div>
    </article>
  );
}

function SecurityEventCard({ event }: { event: SecurityEvent }) {
  const severity = severityFor(event.severity);
  return (
    <article className={`security-event security-event--${severity.label.toLocaleLowerCase()}`}>
      <div className="security-event__severity"><span>{event.severity}</span><strong>{severity.label}</strong></div>
      <div className="security-event__body">
        <header><div><span>{humanize(event.category)}</span><time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time></div><h3>{event.title}</h3></header>
        <dl>
          <div><dt>Source</dt><dd>{event.source}</dd></div>
          <div><dt>Asset</dt><dd>{event.asset || "Not reported"}</dd></div>
          <div><dt>Actor / origin</dt><dd>{event.actor || "Not reported"}</dd></div>
          <div><dt>Rule</dt><dd>{event.ruleId || "Not reported"}</dd></div>
        </dl>
        {event.tags.length > 0 && <div className="security-event__tags">{event.tags.map((tag) => <span key={tag}>{humanize(tag)}</span>)}</div>}
        <footer><span>Source event ID <code title={event.sourceEventId}>{event.sourceEventId}</code></span><span>MRE event ID <code title={event.id}>{event.id}</code></span></footer>
      </div>
    </article>
  );
}

function SecurityEmpty({ icon: Icon, title, detail }: { icon: typeof Server; title: string; detail: string }) {
  return <section className="security-empty"><Icon size={24} aria-hidden="true" /><h2>{title}</h2><p>{detail}</p></section>;
}

type ErrorPayload = { error?: { message?: string } };

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { return {} as T; }
}

async function requestSecurityConsole(signal?: AbortSignal): Promise<SecurityConsoleResponse> {
  const response = await fetch("/api/security?limit=500&minimumSeverity=0", {
    cache: "no-store",
    signal,
  });
  const payload = await readJson<SecurityConsoleResponse & ErrorPayload>(response);
  if (!response.ok) {
    throw new Error(payload.error?.message || "MRE security data could not be loaded.");
  }
  if (!Array.isArray(payload.events) || !payload.wazuh || !payload.honeypot) {
    throw new Error("MRE returned an invalid security response.");
  }
  return payload;
}

function countFor(data: SecurityConsoleResponse | null, severity: number): string {
  return String(data?.countsBySeverity[String(severity)] ?? 0);
}

function severityFor(value: number) {
  return SEVERITIES.find((item) => item.value === value) ?? SEVERITIES.at(-1)!;
}

function stateLabel(value: string): string {
  return humanize(value);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
