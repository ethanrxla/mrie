"use client";

import {
  Activity,
  ArrowUpRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  DatabaseZap,
  Newspaper,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { BriefingRecord } from "@/lib/briefings";

interface AgentSummary {
  name: string;
  status: string;
  currentTask?: string;
}

interface AutomationSummary {
  id: string;
  name: string;
  status: string;
}

interface AppointmentSummary {
  id: string;
  title: string;
  status: string;
  nextRunAt?: string;
}

interface IntelligenceData {
  status: string;
  timestamp?: string;
  services: Record<string, string>;
  agents: AgentSummary[];
  automations: AutomationSummary[];
  appointments: AppointmentSummary[];
}

const emptyIntelligence: IntelligenceData = {
  status: "loading",
  services: {},
  agents: [],
  automations: [],
  appointments: [],
};

export function IntelligencePanel({
  onCollapse,
  memoryUsed = [],
}: {
  onCollapse: () => void;
  memoryUsed?: Array<{ id: string; title: string }>;
}) {
  const [data, setData] = useState<IntelligenceData>(emptyIntelligence);
  const [latestBriefing, setLatestBriefing] = useState<BriefingRecord | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.all([
      fetch("/api/status", options).then((response) => response.ok ? response.json() : Promise.reject(new Error("status"))),
      fetch("/api/agents", options).then((response) => response.ok ? response.json() : Promise.reject(new Error("agents"))),
      fetch("/api/automations", options).then((response) => response.ok ? response.json() : Promise.reject(new Error("automations"))),
      fetch("/api/scheduling", options).then((response) => response.ok ? response.json() : Promise.reject(new Error("scheduling"))),
    ]).then(([status, agents, automations, scheduling]) => {
      setData({
        status: typeof status.status === "string" ? status.status : "unknown",
        timestamp: typeof status.timestamp === "string" ? status.timestamp : undefined,
        services: status.services ?? {},
        agents: agents.agents ?? [],
        automations: automations.automations ?? [],
        appointments: scheduling.appointments ?? [],
      });
      setLoadError(false);
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setLoadError(true);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/briefings?limit=1", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { briefings?: BriefingRecord[] };
        setLatestBriefing(payload.briefings?.[0] ?? null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const runningAgents = data.agents.filter((agent) => agent.status === "running");
  const pending = [
    ...data.agents
      .filter((agent) => agent.status === "waiting_approval")
      .map((agent) => ({ id: `agent:${agent.name}`, title: agent.name, detail: agent.currentTask ?? "Agent run awaiting approval", href: "/agents", kind: "agent" as const })),
    ...data.automations
      .filter((automation) => automation.status === "waiting_approval")
      .map((automation) => ({ id: `automation:${automation.id}`, title: automation.name, detail: "Workflow awaiting approval", href: "/automations", kind: "workflow" as const })),
  ];
  const upcoming = useMemo(() => {
    const observedAt = data.timestamp ? Date.parse(data.timestamp) : 0;
    return data.appointments
      .filter((appointment) => (
        appointment.nextRunAt
        && !["completed", "failed"].includes(appointment.status)
        && Date.parse(appointment.nextRunAt) >= observedAt
      ))
      .sort((left, right) => Date.parse(left.nextRunAt ?? "") - Date.parse(right.nextRunAt ?? ""))
      .slice(0, 2);
  }, [data.appointments, data.timestamp]);

  return (
    <aside className="intelligence-panel" aria-label="Current intelligence">
      <div className="intelligence-panel__header">
        <div>
          <span className="eyebrow"><Activity size={12} /> Persisted live data</span>
          <h2>Operational context</h2>
        </div>
        <button className="icon-button" type="button" onClick={onCollapse} aria-label="Collapse intelligence panel">
          <ChevronLeft size={17} />
        </button>
      </div>

      <div className="intel-scroll">
        {loadError && <div className="inline-notice inline-notice--warning" role="status">Operational data is unavailable. No placeholder activity is being shown.</div>}

        <IntelCard title="Pending approvals" icon={CircleAlert} count={pending.length}>
          {pending.slice(0, 3).map((approval) => (
            <div className="approval-item" key={approval.id}>
              <span className={`approval-item__icon ${approval.kind === "workflow" ? "approval-item__icon--violet" : ""}`}>
                {approval.kind === "workflow" ? <Workflow size={15} /> : <Bot size={15} />}
              </span>
              <span><strong>{approval.title}</strong><small>{approval.detail}</small></span>
              <Link href={approval.href} aria-label={`Review ${approval.title}`}><ArrowUpRight size={14} /></Link>
            </div>
          ))}
          {!pending.length && <p className="intel-empty"><CheckCircle2 size={13} /> No persisted approvals are waiting.</p>}
        </IntelCard>

        <IntelCard title="Agents executing" icon={Bot} count={runningAgents.length} action="View runs" actionHref="/agents">
          <div className="agent-stack">
            {runningAgents.slice(0, 3).map((agent, index) => (
              <div key={agent.name} className="agent-row">
                <span className={`agent-row__icon agent-row__icon--${["cyan", "violet", "blue"][index % 3]}`}><Bot size={14} /></span>
                <span><strong>{agent.name}</strong><small>{agent.currentTask ?? "Task details unavailable"}</small></span>
                <span className="agent-status agent-status--active" aria-label="running" />
              </div>
            ))}
            {!runningAgents.length && <p className="intel-empty">No persisted agent run is executing.</p>}
          </div>
        </IntelCard>

        <IntelCard title="Upcoming schedule" icon={CalendarClock} action="Calendar" actionHref="/scheduling">
          {upcoming.map((appointment) => {
            const date = new Date(appointment.nextRunAt ?? "");
            return (
              <div className="appointment" key={appointment.id}>
                <time><strong>{date.getDate()}</strong><small>{date.toLocaleDateString(undefined, { month: "short" }).toUpperCase()}</small></time>
                <span><strong>{appointment.title}</strong><small>{formatDate(appointment.nextRunAt ?? "")} · {appointment.status}</small></span>
              </div>
            );
          })}
          {!upcoming.length && <p className="intel-empty">No upcoming persisted appointments.</p>}
        </IntelCard>

        <IntelCard title="Latest briefing" icon={Newspaper} action="Archive" actionHref="/briefings">
          {latestBriefing ? (
            <div className="latest-briefing">
              <strong>{latestBriefing.dryRun ? "Source test" : "Intelligence report"}</strong>
              <small>{formatDate(latestBriefing.timestamp)}</small>
              <p>{latestBriefing.summary || "Collection completed without model narration."}</p>
            </div>
          ) : (
            <p className="intel-empty">No archived briefing is available.</p>
          )}
        </IntelCard>

        <IntelCard title="Memory in context" icon={DatabaseZap} count={memoryUsed.length} action="Inspect" actionHref="/memory">
          <div className="memory-context">
            {memoryUsed.slice(0, 4).map((memory) => <span key={memory.id}><CheckCircle2 size={13} /> {memory.title}</span>)}
            {!memoryUsed.length && <p className="intel-empty">No stored memory influenced the latest answer.</p>}
          </div>
        </IntelCard>

        <IntelCard title="System health" icon={Activity}>
          <div className="health-grid">
            <HealthMetric label="Core" value={data.status === "operational" ? "Online" : data.status} state={data.status === "operational" ? "success" : "warning"} />
            <HealthMetric label="Storage" value={data.services.database ?? "Unavailable"} state={serviceState(data.services.database)} />
            <HealthMetric label="Model" value={data.services.llm ?? "Unavailable"} state={serviceState(data.services.llm)} />
            <HealthMetric label="Voice" value={data.services.textToSpeech ?? "Unavailable"} state={serviceState(data.services.textToSpeech)} />
          </div>
          <div className="security-note"><ShieldCheck size={14} /> Consequential actions require approval</div>
        </IntelCard>
      </div>
    </aside>
  );
}

function IntelCard({
  title,
  icon: Icon,
  count,
  action,
  actionHref,
  children,
}: {
  title: string;
  icon: typeof Activity;
  count?: number;
  action?: string;
  actionHref?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="intel-card">
      <header>
        <span><Icon size={14} /> {title} {count !== undefined && <em>{count}</em>}</span>
        {action && actionHref ? <Link href={actionHref}>{action}</Link> : null}
      </header>
      {children}
    </section>
  );
}

function HealthMetric({ label, value, state }: { label: string; value: string; state: "success" | "warning" }) {
  return (
    <div>
      <span><span className={`health-dot health-dot--${state}`} /> {label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function serviceState(value?: string): "success" | "warning" {
  if (!value || /(?:unavailable|standby|disabled|not configured|none)/i.test(value)) return "warning";
  return "success";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Scheduled";
  return date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function IntelligencePanelRail({ onExpand }: { onExpand: () => void }) {
  return (
    <aside className="intel-rail" aria-label="Collapsed intelligence panel">
      <button className="icon-button" type="button" onClick={onExpand} aria-label="Expand intelligence panel"><ChevronLeft size={17} /></button>
      <span className="intel-rail__line" />
      <span title="Pending approvals"><CircleAlert size={16} /></span>
      <span title="Running agents"><Bot size={16} /></span>
      <span title="System status"><Activity size={16} /></span>
      <button className="icon-button intel-rail__close" type="button" onClick={onExpand} aria-label="Open intelligence panel"><X size={15} /></button>
    </aside>
  );
}
