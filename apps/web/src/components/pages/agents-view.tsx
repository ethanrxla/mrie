"use client";

import { Activity, Bot, CirclePause, CirclePlay, Radio, Rows3 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { MetricCard, PageScaffold } from "@/components/pages/page-scaffold";

type AgentStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "paused";

interface AgentSummary {
  name: string;
  status: AgentStatus;
  currentTask?: string;
  lastRun?: string;
  successRate: number | null;
  queueLength: number;
  completedRuns: number;
  successfulRuns: number;
}

const accents = ["cyan", "violet", "blue", "magenta"] as const;

export function AgentsView() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/agents", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Agent activity is unavailable.");
        const payload = (await response.json()) as { agents?: AgentSummary[] };
        setAgents(payload.agents ?? []);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setLoadError("Live agent activity could not be loaded. No placeholder agents are being shown.");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const metrics = useMemo(() => ({
    known: agents.length,
    running: agents.filter((agent) => agent.status === "running").length,
    queued: agents.reduce((total, agent) => total + agent.queueLength, 0),
    approvals: agents.filter((agent) => agent.status === "waiting_approval").length,
  }), [agents]);

  const toggle = async (agent: AgentSummary) => {
    const previous = agent.status;
    const paused = agent.status !== "paused";
    setAgents((current) => current.map((item) => (
      item.name === agent.name ? { ...item, status: paused ? "paused" : "queued" } : item
    )));
    const response = await fetch(`/api/agents/${encodeURIComponent(agent.name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused }),
    }).catch(() => null);
    if (!response?.ok) {
      setAgents((current) => current.map((item) => (
        item.name === agent.name ? { ...item, status: previous } : item
      )));
      setNotice(`${agent.name} could not be ${paused ? "paused" : "resumed"}. Try again.`);
      return;
    }
    const payload = (await response.json()) as { status?: AgentStatus };
    setAgents((current) => current.map((item) => (
      item.name === agent.name ? { ...item, status: payload.status ?? (paused ? "paused" : previous) } : item
    )));
    setNotice(`${agent.name} ${paused ? "paused" : "resumed"}.`);
  };

  return (
    <PageScaffold
      eyebrow="Agents"
      title="Agent operations"
      description="Monitor persisted agent runs and pause an agent policy at any time. Agents appear only after a real run exists."
      icon={Bot}
      actions={<Link className="button button--primary" href="/settings"><Bot size={16} /> Agent policy</Link>}
    >
      {notice && <div className="inline-notice" role="status"><Activity size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {loadError && <div className="inline-notice inline-notice--warning" role="alert"><span>{loadError}</span></div>}
      <div className="metric-grid">
        <MetricCard label="Known agents" value={String(metrics.known)} detail="with persisted run history" />
        <MetricCard label="Executing now" value={String(metrics.running)} detail="running agent tasks" />
        <MetricCard label="Queued runs" value={String(metrics.queued)} detail="awaiting processing" />
        <MetricCard label="Awaiting approval" value={String(metrics.approvals)} detail="blocked pending review" />
      </div>
      <div className="section-heading"><div><h2>Agent activity</h2><p>This view contains server-persisted run data only.</p></div><Link className="button button--secondary" href="/automations"><Rows3 size={15} /> Workflow control</Link></div>
      {loading && <div className="loading-line" role="status"><span /> Loading agent activity…</div>}
      <div className="agent-grid">
        {agents.map((agent, index) => (
          <article key={agent.name} className={`agent-card agent-card--${accents[index % accents.length]}`}>
            <header>
              <span className="agent-card__icon"><Bot size={20} /></span>
              <span className={`status-pill status-pill--${agent.status}`}><span /> {statusLabel(agent.status)}</span>
            </header>
            <h2>{agent.name}</h2>
            <div className="agent-card__task"><Radio size={13} /><span><small>Current task</small><strong>{agent.currentTask ?? "No task is active"}</strong></span></div>
            <dl>
              <div><dt>Last activity</dt><dd>{formatDate(agent.lastRun)}</dd></div>
              <div><dt>Success rate</dt><dd>{agent.successRate === null ? "—" : `${agent.successRate}%`}</dd></div>
              <div><dt>Queue</dt><dd>{agent.queueLength}</dd></div>
            </dl>
            <footer>
              <button className="button button--secondary" type="button" onClick={() => void toggle(agent)}>
                {agent.status === "paused" ? <CirclePlay size={15} /> : <CirclePause size={15} />}
                {agent.status === "paused" ? "Resume" : "Pause"}
              </button>
            </footer>
          </article>
        ))}
      </div>
      {!loading && !loadError && !agents.length && (
        <div className="empty-state"><Bot size={24} /><h2>No agent runs yet</h2><p>Agents will appear here after MRE creates a persisted run.</p></div>
      )}
      <div className="policy-banner"><Activity size={16} /><span><strong>Human control is active.</strong> Consequential external actions require explicit approval.</span></div>
    </PageScaffold>
  );
}

function formatDate(value?: string): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unavailable"
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function statusLabel(status: AgentStatus): string {
  if (status === "waiting_approval") return "awaiting approval";
  return status;
}
