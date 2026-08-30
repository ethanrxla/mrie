"use client";

import {
  CheckCircle2,
  CirclePause,
  CirclePlay,
  Clock3,
  FileClock,
  Play,
  Plus,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { MetricCard, PageScaffold } from "@/components/pages/page-scaffold";
import { ConfirmDialog, type ConfirmationRequest } from "@/components/ui/confirm-dialog";

type AutomationStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "paused";

interface ApiAutomation {
  id: string;
  name: string;
  description?: string;
  triggerConfig: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  status: AutomationStatus;
  lastRunAt?: string;
  nextRunAt?: string;
}

interface AutomationDraft {
  name: string;
  description: string;
  triggerType: "manual" | "schedule" | "event";
  triggerDetail: string;
  firstStep: string;
}

const emptyDraft: AutomationDraft = {
  name: "",
  description: "",
  triggerType: "manual",
  triggerDetail: "Manual operator launch",
  firstStep: "",
};

export function AutomationsView() {
  const [automations, setAutomations] = useState<ApiAutomation[]>([]);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAutomations(controller.signal)
      .then(setAutomations)
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(errorMessage(caught, "MRE could not load automations."));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const metrics = useMemo(
    () => ({
      configured: automations.length,
      enabled: automations.filter((item) => item.status !== "paused").length,
      queued: automations.filter((item) => item.status === "queued").length,
      approvals: automations.filter((item) => item.status === "waiting_approval").length,
    }),
    [automations],
  );

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggle = async (automation: ApiAutomation) => {
    const previous = automation;
    const nextStatus: AutomationStatus = automation.status === "paused" ? "running" : "paused";
    setError(null);
    setBusy(automation.id, true);
    setAutomations((current) =>
      current.map((item) => (item.id === automation.id ? { ...item, status: nextStatus } : item)),
    );
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(automation.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const payload = await readJson<{ automation?: ApiAutomation }>(response);
      if (!response.ok || !payload.automation) {
        throw new Error(apiError(payload, `MRE could not ${nextStatus === "paused" ? "pause" : "resume"} this automation.`));
      }
      setAutomations((current) =>
        current.map((item) => (item.id === automation.id ? payload.automation! : item)),
      );
      setNotice(`${automation.name} ${nextStatus === "paused" ? "paused" : "resumed"}.`);
    } catch (caught) {
      setAutomations((current) =>
        current.map((item) => (item.id === automation.id ? previous : item)),
      );
      setError(errorMessage(caught, "The automation was not changed."));
    } finally {
      setBusy(automation.id, false);
    }
  };

  const requestRun = async (automation: ApiAutomation) => {
    setError(null);
    setBusy(automation.id, true);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(automation.id)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await readJson<{
        requiresConfirmation?: boolean;
        confirmation?: { token?: string; title?: string; detail?: string; scope?: string[] };
      }>(response);
      const token = payload.confirmation?.token;
      if (response.status !== 202 || !payload.requiresConfirmation || !token) {
        throw new Error(apiError(payload, "MRE could not prepare this workflow run."));
      }
      const scope = payload.confirmation?.scope?.filter(Boolean).join(", ");
      setConfirmation({
        title: payload.confirmation?.title ?? `Run “${automation.name}” now?`,
        description: `${payload.confirmation?.detail ?? "This workflow may use connected business tools."}${scope ? ` Steps: ${scope}.` : ""} Any consequential external action still requires its own approval.`,
        confirmLabel: "Confirm run",
        onConfirm: () => executeRun(automation, token),
      });
    } catch (caught) {
      setError(errorMessage(caught, "MRE could not prepare this workflow run."));
    } finally {
      setBusy(automation.id, false);
    }
  };

  const executeRun = async (automation: ApiAutomation, confirmationToken: string) => {
    setError(null);
    setBusy(automation.id, true);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(automation.id)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, confirmationToken }),
      });
      const payload = await readJson<{ accepted?: boolean; automation?: ApiAutomation }>(response);
      if (response.status !== 202 || !payload.accepted || !payload.automation) {
        throw new Error(apiError(payload, "The workflow run was not accepted."));
      }
      setAutomations((current) =>
        current.map((item) => (item.id === automation.id ? payload.automation! : item)),
      );
      setNotice(`${automation.name} was queued. Its activity will appear when processing begins.`);
    } catch (caught) {
      setError(errorMessage(caught, "No workflow action was started."));
    } finally {
      setBusy(automation.id, false);
    }
  };

  const createAutomation = async (draft: AutomationDraft) => {
    setError(null);
    const response = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draft.name,
        description: draft.description || undefined,
        triggerConfig: {
          type: draft.triggerType,
          label: draft.triggerDetail || triggerDefault(draft.triggerType),
        },
        steps: [{ type: "instruction", instruction: draft.firstStep }],
      }),
    });
    const payload = await readJson<{ automation?: ApiAutomation }>(response);
    if (!response.ok || !payload.automation) {
      throw new Error(apiError(payload, "MRE could not create this automation."));
    }
    setAutomations((current) => [payload.automation!, ...current]);
    setCreateOpen(false);
    setNotice(`${payload.automation.name} was created in a paused state. Review it before resuming.`);
  };

  return (
    <PageScaffold
      eyebrow="Automations"
      title="Workflow control"
      description="Create, observe, and safely run the systems that move routine business work forward."
      icon={Workflow}
      actions={
        <button className="button button--primary" type="button" onClick={() => setCreateOpen(true)}>
          <Plus size={16} /> New automation
        </button>
      }
    >
      {notice && (
        <div className="inline-notice" role="status">
          <CheckCircle2 size={15} />
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {error && (
        <div className="inline-notice inline-notice--warning" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      <div className="metric-grid">
        <MetricCard label="Configured workflows" value={String(metrics.configured)} detail="in this workspace" />
        <MetricCard label="Enabled" value={String(metrics.enabled)} detail="not paused" />
        <MetricCard label="Queued runs" value={String(metrics.queued)} detail="awaiting processing" />
        <MetricCard label="Awaiting approval" value={String(metrics.approvals)} detail="no action executed" />
      </div>
      <section className="data-panel">
        <header className="data-panel__header">
          <div>
            <h2>Business automations</h2>
            <p>Every manual run uses a durable, expiring, single-use confirmation.</p>
          </div>
          <button
            className="button button--secondary"
            type="button"
            disabled
            title="Dedicated run-log browsing is not available yet"
          >
            <FileClock size={15} /> Run logs unavailable
          </button>
        </header>
        <div className="automation-table-wrap">
          <table className="automation-table">
            <thead>
              <tr><th>Workflow</th><th>Trigger</th><th>Last run</th><th>Next run</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {automations.map((automation) => {
                const busy = busyIds.has(automation.id);
                const runUnavailable = ["paused", "queued", "waiting_approval"].includes(automation.status);
                return (
                  <tr key={automation.id}>
                    <td>
                      <span className="table-primary">
                        <span className="table-icon"><Workflow size={15} /></span>
                        <span><strong>{automation.name}</strong><small>{automation.description || `${automation.steps.length} configured step${automation.steps.length === 1 ? "" : "s"}`}</small></span>
                      </span>
                    </td>
                    <td>{triggerLabel(automation.triggerConfig)}</td>
                    <td><span className="time-value"><Clock3 size={12} /> {formatDate(automation.lastRunAt, "Never")}</span></td>
                    <td>{formatDate(automation.nextRunAt, "Waiting for signal")}</td>
                    <td><span className={`status-pill status-pill--${automation.status}`}><span /> {statusLabel(automation.status)}</span></td>
                    <td>
                      <div className="table-actions">
                        <button
                          type="button"
                          onClick={() => void requestRun(automation)}
                          aria-label={`Run ${automation.name} now`}
                          disabled={busy || runUnavailable}
                          title={runUnavailable ? "Resume the workflow and wait for any queued run to finish" : undefined}
                        >
                          <Play size={14} /> Run now
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggle(automation)}
                          aria-label={`${automation.status === "paused" ? "Resume" : "Pause"} ${automation.name}`}
                          disabled={busy}
                        >
                          {automation.status === "paused" ? <CirclePlay size={15} /> : <CirclePause size={15} />}
                          <span className="sr-only">{automation.status === "paused" ? "Resume" : "Pause"}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && !automations.length && (
            <div className="empty-state">
              <Workflow size={24} />
              <h2>No automations configured</h2>
              <p>Create a paused workflow, review its steps, then resume it when ready.</p>
            </div>
          )}
          {loading && <div className="loading-line" role="status"><span /> Loading automations…</div>}
        </div>
      </section>
      <div className="policy-banner">
        <ShieldCheck size={16} />
        <span><strong>Approval-gated by design.</strong> Running a workflow does not pre-authorize messages, meetings, publishing, deletion, lead contact, or paid services.</span>
      </div>
      {createOpen && (
        <AutomationEditor onClose={() => setCreateOpen(false)} onCreate={createAutomation} />
      )}
      <ConfirmDialog request={confirmation} onClose={() => setConfirmation(null)} />
    </PageScaffold>
  );
}

function AutomationEditor({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (draft: AutomationDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, submitting]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(draft);
    } catch (caught) {
      setError(errorMessage(caught, "MRE could not create this automation."));
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose()}>
      <form className="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-editor-title" onSubmit={(event) => void submit(event)}>
        <header>
          <div><span className="eyebrow"><Workflow size={12} /> Paused by default</span><h2 id="automation-editor-title">Create automation</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} aria-label="Close automation editor"><X size={17} /></button>
        </header>
        <label>
          Name
          <input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={160} required />
        </label>
        <label>
          Description <small>Optional</small>
          <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={3} maxLength={2000} />
        </label>
        <div className="form-row">
          <label>
            Trigger type
            <select value={draft.triggerType} onChange={(event) => {
              const triggerType = event.target.value as AutomationDraft["triggerType"];
              setDraft({ ...draft, triggerType, triggerDetail: triggerDefault(triggerType) });
            }}>
              <option value="manual">Manual</option>
              <option value="schedule">Schedule signal</option>
              <option value="event">Business event</option>
            </select>
          </label>
          <label>
            Trigger detail
            <input value={draft.triggerDetail} onChange={(event) => setDraft({ ...draft, triggerDetail: event.target.value })} maxLength={200} required />
          </label>
        </div>
        <label>
          First step instruction
          <textarea value={draft.firstStep} onChange={(event) => setDraft({ ...draft, firstStep: event.target.value })} rows={3} maxLength={1000} required placeholder="Describe the first bounded action MRE should prepare." />
        </label>
        {error && <div className="inline-notice inline-notice--warning" role="alert"><span>{error}</span></div>}
        <div className="policy-banner"><ShieldCheck size={15} /><span>The workflow is saved paused. External actions still require separate approval.</span></div>
        <footer>
          <button className="button button--secondary" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={submitting || !draft.name.trim() || !draft.triggerDetail.trim() || !draft.firstStep.trim()}>
            {submitting ? "Creating…" : "Create paused workflow"}
          </button>
        </footer>
      </form>
    </div>
  );
}

async function fetchAutomations(signal: AbortSignal): Promise<ApiAutomation[]> {
  const response = await fetch("/api/automations", { signal });
  const payload = await readJson<{ automations?: ApiAutomation[] }>(response);
  if (!response.ok || !payload.automations) {
    throw new Error(apiError(payload, "MRE could not load automations."));
  }
  return payload.automations;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function apiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
  }
  return fallback;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? fallback : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function triggerLabel(trigger: Record<string, unknown>): string {
  const label = trigger.label ?? trigger.expression ?? trigger.type;
  return typeof label === "string" && label.trim() ? label : "Configured trigger";
}

function triggerDefault(type: AutomationDraft["triggerType"]): string {
  if (type === "schedule") return "On a configured schedule";
  if (type === "event") return "When a connected business event occurs";
  return "Manual operator launch";
}

function statusLabel(status: AutomationStatus): string {
  if (status === "waiting_approval") return "awaiting approval";
  return status;
}
