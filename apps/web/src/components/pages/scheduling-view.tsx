"use client";

import {
  CalendarDays,
  CheckCircle2,
  Globe2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { MetricCard, PageScaffold } from "@/components/pages/page-scaffold";
import { ConfirmDialog, type ConfirmationRequest } from "@/components/ui/confirm-dialog";

interface ScheduledTask {
  id: string;
  title: string;
  description?: string;
  scheduleExpression: string;
  timezone: string;
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "paused";
  nextRunAt?: string;
  lastRunAt?: string;
}

interface AppointmentRequest {
  title: string;
  description?: string;
  scheduleExpression: string;
  timezone: string;
  nextRunAt: string;
}

interface AppointmentDraft {
  title: string;
  description: string;
  localDateTime: string;
  timezone: string;
}

export function SchedulingView() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSchedule(controller.signal)
      .then(setTasks)
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(errorMessage(caught, "MRE could not load the schedule."));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const metrics = useMemo(() => {
    const future = tasks.filter(
      (task) => task.nextRunAt && !["completed", "failed"].includes(task.status),
    );
    return {
      configured: tasks.length,
      upcoming: future.length,
      paused: tasks.filter((task) => task.status === "paused").length,
      zones: new Set(tasks.map((task) => task.timezone)).size,
    };
  }, [tasks]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await fetchSchedule());
      setNotice("Schedule refreshed from MRE’s server-side store.");
    } catch (caught) {
      setError(errorMessage(caught, "The schedule could not be refreshed."));
    } finally {
      setLoading(false);
    }
  };

  const prepareAppointment = async (request: AppointmentRequest) => {
    setFormError(null);
    const response = await fetch("/api/scheduling", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const payload = await readJson<{
      requiresConfirmation?: boolean;
      confirmation?: { token?: string; title?: string; detail?: string };
    }>(response);
    const token = payload.confirmation?.token;
    if (response.status !== 202 || !payload.requiresConfirmation || !token) {
      throw new Error(apiError(payload, "MRE could not prepare this appointment."));
    }
    setConfirmation({
      title: payload.confirmation?.title ?? `Schedule “${request.title}”?`,
      description: `${payload.confirmation?.detail ?? formatDate(request.nextRunAt, request.scheduleExpression)}. Confirming creates the server-side appointment; connected-calendar invitations remain separately approval-gated.`,
      confirmLabel: "Confirm appointment",
      onConfirm: () => createAppointment(request, token),
    });
  };

  const createAppointment = async (request: AppointmentRequest, confirmationToken: string) => {
    setFormError(null);
    try {
      const response = await fetch("/api/scheduling", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, confirmed: true, confirmationToken }),
      });
      const payload = await readJson<{ appointment?: ScheduledTask }>(response);
      if (response.status !== 201 || !payload.appointment) {
        throw new Error(apiError(payload, "The appointment was not created."));
      }
      setTasks((current) => sortTasks([payload.appointment!, ...current]));
      setCreateOpen(false);
      setNotice(`${payload.appointment.title} was scheduled for ${formatDate(payload.appointment.nextRunAt, payload.appointment.scheduleExpression)}.`);
    } catch (caught) {
      setFormError(errorMessage(caught, "No appointment was created."));
      setCreateOpen(true);
    }
  };

  return (
    <PageScaffold
      eyebrow="Scheduling"
      title="Time intelligence"
      description="Coordinate protected schedules and approval-gated appointments across working time zones."
      icon={CalendarDays}
      actions={
        <>
          <button className="button button--secondary" type="button" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={15} /> {loading ? "Refreshing…" : "Refresh schedule"}
          </button>
          <button className="button button--primary" type="button" onClick={() => { setFormError(null); setCreateOpen(true); }}>
            <Plus size={16} /> New appointment
          </button>
        </>
      }
    >
      {notice && (
        <div className="inline-notice" role="status">
          <CheckCircle2 size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {error && (
        <div className="inline-notice inline-notice--warning" role="alert">
          <span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      <div className="metric-grid">
        <MetricCard label="Scheduled items" value={String(metrics.configured)} detail="stored appointments and tasks" />
        <MetricCard label="Upcoming" value={String(metrics.upcoming)} detail="with a future run time" />
        <MetricCard label="Paused" value={String(metrics.paused)} detail="not currently active" />
        <MetricCard label="Time zones" value={String(metrics.zones)} detail="across scheduled work" />
      </div>

      <div className="schedule-layout">
        <section className="calendar-panel" aria-label="Persisted schedule">
          <header>
            <div><CalendarDays size={15} /><h2>Persisted schedule</h2></div>
            <span className="status-pill"><span /> {tasks.length} {tasks.length === 1 ? "item" : "items"}</span>
          </header>
          <div className="schedule-live-list">
            {tasks.map((task) => (
              <article className="schedule-live-item" key={task.id}>
                <span className={`status-orb status-orb--${task.status === "paused" || task.status === "failed" ? "warning" : "online"}`} />
                <span>
                  <strong>{task.title}</strong>
                  <small>{formatDate(task.nextRunAt, task.scheduleExpression)} · {task.timezone}</small>
                  {task.description && <p>{task.description}</p>}
                </span>
                <em>{statusLabel(task.status)}</em>
              </article>
            ))}
            {!loading && !tasks.length && (
              <div className="empty-state"><CalendarDays size={22} /><h2>No scheduled items</h2><p>Create an appointment to begin.</p></div>
            )}
            {loading && <div className="loading-line" role="status"><span /> Loading schedule…</div>}
          </div>
        </section>

        <aside className="schedule-side">
          <section className="schedule-card schedule-card--approval">
            <header><Sparkles size={15} /> Protected scheduling</header>
            <h3>Appointments require confirmation</h3>
            <p>MRE first prepares the exact title, time, and time zone, then issues a short-lived confirmation before saving it.</p>
            <span><ShieldCheck size={12} /> Invitations are not sent by this action</span>
            <div><button className="button button--primary" type="button" onClick={() => { setFormError(null); setCreateOpen(true); }}>Create appointment</button></div>
          </section>
        </aside>
      </div>
      {createOpen && (
        <AppointmentEditor
          externalError={formError}
          onClose={() => { setCreateOpen(false); setFormError(null); }}
          onPrepare={prepareAppointment}
        />
      )}
      <ConfirmDialog request={confirmation} onClose={() => setConfirmation(null)} />
    </PageScaffold>
  );
}

function AppointmentEditor({
  externalError,
  onClose,
  onPrepare,
}: {
  externalError: string | null;
  onClose: () => void;
  onPrepare: (request: AppointmentRequest) => Promise<void>;
}) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [draft, setDraft] = useState<AppointmentDraft>(() => defaultAppointmentDraft(timezone));
  const [minimumDateTime] = useState(() => minimumAppointmentDateTime());
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
      const nextRunAt = new Date(draft.localDateTime).toISOString();
      await onPrepare({
        title: draft.title.trim(),
        description: draft.description.trim() || undefined,
        scheduleExpression: `once:${nextRunAt}`,
        timezone: draft.timezone,
        nextRunAt,
      });
    } catch (caught) {
      setError(errorMessage(caught, "MRE could not prepare this appointment."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose()}>
      <form className="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="appointment-editor-title" onSubmit={(event) => void submit(event)}>
        <header>
          <div><span className="eyebrow"><CalendarDays size={12} /> Approval required</span><h2 id="appointment-editor-title">New appointment</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} aria-label="Close appointment editor"><X size={17} /></button>
        </header>
        <label>
          Appointment title
          <input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={160} required />
        </label>
        <label>
          Description <small>Optional</small>
          <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={3} maxLength={2000} />
        </label>
        <div className="form-row">
          <label className="field-label">
            <span>Date and time on this device</span>
            <input type="datetime-local" value={draft.localDateTime} min={minimumDateTime} onChange={(event) => setDraft({ ...draft, localDateTime: event.target.value })} required />
          </label>
          <label className="field-label">
            <span>Time zone</span>
            <div className="select-wrap"><Globe2 size={14} /><input value={draft.timezone} readOnly aria-readonly="true" /></div>
          </label>
        </div>
        {(error || externalError) && <div className="inline-notice inline-notice--warning" role="alert"><span>{error ?? externalError}</span></div>}
        <div className="policy-banner"><ShieldCheck size={15} /><span>The next screen shows the server-verified time before anything is created.</span></div>
        <footer>
          <button className="button button--secondary" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={submitting || !draft.title.trim() || !draft.localDateTime}>
            {submitting ? "Preparing…" : "Review appointment"}
          </button>
        </footer>
      </form>
    </div>
  );
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

async function fetchSchedule(signal?: AbortSignal): Promise<ScheduledTask[]> {
  const response = await fetch("/api/scheduling", { signal });
  const payload = await readJson<{ appointments?: ScheduledTask[] }>(response);
  if (!response.ok || !payload.appointments) {
    throw new Error(apiError(payload, "MRE could not load the schedule."));
  }
  return sortTasks(payload.appointments);
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

function sortTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  return [...tasks].sort((left, right) => {
    const leftTime = left.nextRunAt ? Date.parse(left.nextRunAt) : Number.POSITIVE_INFINITY;
    const rightTime = right.nextRunAt ? Date.parse(right.nextRunAt) : Number.POSITIVE_INFINITY;
    return leftTime - rightTime;
  });
}

function formatDate(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? fallback : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function statusLabel(status: ScheduledTask["status"]): string {
  if (status === "waiting_approval") return "awaiting approval";
  return status;
}

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function defaultAppointmentDraft(timezone: string): AppointmentDraft {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return {
    title: "",
    description: "",
    localDateTime: localDateTimeValue(date),
    timezone,
  };
}

function minimumAppointmentDateTime(): string {
  const date = new Date();
  date.setMinutes(date.getMinutes() + 5);
  return localDateTimeValue(date);
}
