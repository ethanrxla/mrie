"use client";

import {
  ArchiveX,
  BrainCircuit,
  CalendarClock,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  FileText,
  Filter,
  History,
  MemoryStick,
  Pencil,
  Pin,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { MetricCard, PageScaffold } from "@/components/pages/page-scaffold";
import { ConfirmDialog, type ConfirmationRequest } from "@/components/ui/confirm-dialog";
import { cn } from "@/components/ui/cn";

type MemoryType = "profile" | "semantic" | "episodic";

interface MemorySummary {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  source: string;
  updatedAt: string;
  importance: number;
  confidence: number;
  pinned: boolean;
  expiresAt?: string;
}

interface ApiMemory {
  id: string;
  memoryType: MemorySummary["type"];
  title: string;
  content: string;
  importanceScore: number;
  confidenceScore: number;
  sourceMessageId?: string;
  isPinned: boolean;
  updatedAt: string;
  expiresAt?: string;
}

const typeLabels: Record<MemorySummary["type"], string> = {
  profile: "Profile",
  semantic: "Business knowledge",
  episodic: "Events & decisions",
};

export function MemoryView() {
  const [memories, setMemories] = useState<MemorySummary[]>([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | MemorySummary["type"]>("all");
  const [selected, setSelected] = useState<MemorySummary | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [autoMemory, setAutoMemory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/memory", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("Memory unavailable");
        const payload = (await response.json()) as { memories: ApiMemory[] };
        setMemories(payload.memories.map(fromApiMemory));
      }),
      fetch("/api/preferences", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { preferences?: Record<string, unknown> };
        if (typeof payload.preferences?.["memory.autoSave"] === "boolean") {
          setAutoMemory(payload.preferences["memory.autoSave"] as boolean);
        }
      }),
    ])
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setNotice("Authenticated memory is unavailable. No placeholder memories are being shown.");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const filtered = useMemo(
    () => memories.filter((memory) =>
      (type === "all" || memory.type === type) &&
      `${memory.title} ${memory.content} ${memory.source}`.toLowerCase().includes(query.toLowerCase()),
    ),
    [memories, query, type],
  );

  const updateMemory = async (memory: MemorySummary, changes: Partial<MemorySummary>) => {
    const previous = memories;
    setMemories((current) => current.map((item) => item.id === memory.id ? { ...item, ...changes } : item));
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(memory.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toApiChanges(changes)),
      });
      if (!response.ok) throw new Error("Update rejected");
    } catch {
      setMemories(previous);
      setNotice("Memory was not changed. Review the value or reconnect and retry.");
    }
  };

  const deleteMemory = (memory: MemorySummary) => {
    setConfirmation({
      title: "Delete this memory?",
      description: `“${memory.title}” will no longer influence future answers. Its source conversation will remain unless you clear conversation history separately.`,
      confirmLabel: "Delete memory",
      tone: "danger",
      onConfirm: async () => {
        const previous = memories;
        setMemories((current) => current.filter((item) => item.id !== memory.id));
        try {
          const response = await fetch(`/api/memory/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
          if (!response.ok) throw new Error("Delete rejected");
        } catch {
          setMemories(previous);
          setNotice("That memory could not be deleted. No stored data changed.");
        }
      },
    });
  };

  const clearAllMemory = () => {
    setConfirmation({
      title: "Clear all remembered information?",
      description: "This permanently removes profile, business, and event memory. Conversation transcripts are separate and will remain available.",
      confirmLabel: "Clear all memory",
      tone: "danger",
      onConfirm: async () => {
        const response = await fetch("/api/memory", { method: "DELETE" });
        if (response.ok) setMemories([]);
        else setNotice("Memory was not cleared. The server did not approve the request.");
      },
    });
  };

  const clearConversations = () => {
    setConfirmation({
      title: "Clear conversation history?",
      description: "This removes conversation transcripts while preserving long-term memories. This action cannot be undone.",
      confirmLabel: "Clear conversations",
      tone: "danger",
      onConfirm: async () => {
        const response = await fetch("/api/conversations", { method: "DELETE" });
        setNotice(response.ok ? "Conversation history cleared. Long-term memory was preserved." : "Conversation history was not cleared.");
      },
    });
  };

  const exportMemory = async () => {
    try {
      const response = await fetch("/api/memory/export");
      if (!response.ok) throw new Error("Export unavailable");
      const blob = await response.blob();
      downloadBlob(blob, "mre-memory-export.json");
    } catch {
      downloadBlob(new Blob([JSON.stringify(memories, null, 2)], { type: "application/json" }), "mre-memory-export.json");
      setNotice("The server export was unavailable, so the currently loaded persisted memories were exported instead.");
    }
  };

  const toggleAutomaticMemory = async (enabled: boolean) => {
    const previous = autoMemory;
    setAutoMemory(enabled);
    try {
      const response = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "memory.autoSave", value: enabled }),
      });
      if (!response.ok) throw new Error("Preference update rejected");
    } catch {
      setAutoMemory(previous);
      setNotice("Automatic memory could not be changed. Your prior setting was restored.");
    }
  };

  return (
    <PageScaffold
      eyebrow="Memory"
      title="Memory control center"
      description="See exactly what MRE can recall, correct it, and decide what remains available in future sessions."
      icon={MemoryStick}
      actions={<><button className="button button--secondary" type="button" onClick={() => void exportMemory()}><Download size={15} /> Export</button><button className="button button--primary" type="button" onClick={() => setSelected(newMemoryDraft())}><Plus size={16} /> Add memory</button></>}
    >
      {notice && <div className="inline-notice" role="status"><CircleHelp size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}
      <div className="memory-overview">
        <div className="metric-grid metric-grid--three">
          <MetricCard label="Stored memories" value={String(memories.length)} detail="under your control" />
          <MetricCard label="Pinned context" value={String(memories.filter((memory) => memory.pinned).length)} detail="always prioritized" />
          <MetricCard label="Average confidence" value={`${Math.round((memories.reduce((sum, memory) => sum + memory.confidence, 0) / Math.max(1, memories.length)) * 100)}%`} detail="review uncertain items" />
        </div>
        <aside className="memory-policy-card">
          <div><span><Sparkles size={15} /></span><div><strong>Automatic memory</strong><p>MRE saves only useful long-term context after filtering sensitive data.</p></div></div>
          <label className="switch-control"><input type="checkbox" checked={autoMemory} onChange={(event) => void toggleAutomaticMemory(event.target.checked)} /><span aria-hidden="true" /><em>{autoMemory ? "Enabled" : "Disabled"}</em></label>
        </aside>
      </div>

      <div className="filter-bar">
        <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search remembered facts, people, projects…" aria-label="Search memories" /></label>
        <label className="filter-select"><Filter size={15} /><select value={type} onChange={(event) => setType(event.target.value as typeof type)} aria-label="Filter memory type"><option value="all">All memory types</option><option value="profile">Profile</option><option value="semantic">Business knowledge</option><option value="episodic">Events & decisions</option></select><ChevronDown size={14} /></label>
      </div>
      {loading && <div className="loading-line" role="status"><span /> Retrieving authenticated memory…</div>}

      <div className="memory-layout">
        <section className="memory-list" aria-label="Stored memories">
          {filtered.map((memory) => (
            <article key={memory.id} className={cn("memory-card", memory.pinned && "memory-card--pinned")}>
              <div className="memory-card__type"><span className={`memory-type memory-type--${memory.type}`}>{typeIcon(memory.type)} {typeLabels[memory.type]}</span>{memory.pinned && <span className="pinned-label"><Pin size={11} fill="currentColor" /> Pinned</span>}</div>
              <h2>{memory.title}</h2>
              <p>{memory.content}</p>
              <div className="memory-card__source"><FileText size={12} /><span>{memory.source}</span><time>{memory.updatedAt}</time></div>
              <div className="memory-card__scores"><span>Importance <strong>{Math.round(memory.importance * 100)}%</strong></span><span>Confidence <strong>{Math.round(memory.confidence * 100)}%</strong></span>{memory.expiresAt && <span><CalendarClock size={11} /> Expires {memory.expiresAt}</span>}</div>
              <div className="memory-card__actions">
                <button type="button" onClick={() => void updateMemory(memory, { pinned: !memory.pinned })}>{memory.pinned ? <><X size={13} /> Unpin</> : <><Pin size={13} /> Pin</>}</button>
                <button type="button" onClick={() => setSelected(memory)}><Pencil size={13} /> Edit</button>
                <button className="danger-action" type="button" onClick={() => deleteMemory(memory)}><Trash2 size={13} /> Delete</button>
              </div>
            </article>
          ))}
          {!loading && !filtered.length && <div className="empty-state"><MemoryStick size={24} /><h2>{memories.length ? "No memories match" : "No memories stored"}</h2><p>{memories.length ? "Adjust your filters." : "Add a memory or explicitly ask MRE to remember useful long-term context."}</p></div>}
        </section>

        <aside className="memory-guide">
          <section><header><BrainCircuit size={15} /> Memory commands</header>{["Remember this.", "Do not remember this.", "What do you remember about me?", "Forget everything about this client.", "Correct the memory about our pricing."].map((command) => <Link key={command} href={`/?prompt=${encodeURIComponent(command)}`}>{command}</Link>)}</section>
          <section className="sensitive-card"><header><ShieldCheck size={15} /> Protected by default</header><p>MRE does not automatically store passwords, payment details, private keys, authentication tokens, medical information, or highly sensitive personal data.</p></section>
          <section><header><History size={15} /> Data controls</header><button type="button" onClick={clearConversations}><ArchiveX size={13} /> Clear conversations only</button><button className="danger-action" type="button" onClick={clearAllMemory}><Trash2 size={13} /> Clear all memory</button></section>
        </aside>
      </div>

      {selected && <MemoryEditor memory={selected} onClose={() => setSelected(null)} onSave={async (memory, isNew) => {
        if (isNew) {
          try {
            const response = await fetch("/api/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toApiCreate(memory)) });
            const payload = (await response.json()) as { memory?: ApiMemory; error?: { message?: string } };
            if (!response.ok || !payload.memory) throw new Error(payload.error?.message ?? "Memory rejected");
            setMemories((current) => [...current, fromApiMemory(payload.memory!)]);
          } catch { setNotice("Memory was not saved. Sensitive or invalid information may be blocked."); }
        } else await updateMemory(memory, memory);
        setSelected(null);
      }} />}
      <ConfirmDialog request={confirmation} onClose={() => setConfirmation(null)} />
    </PageScaffold>
  );
}

function MemoryEditor({ memory, onClose, onSave }: { memory: MemorySummary; onClose: () => void; onSave: (memory: MemorySummary, isNew: boolean) => Promise<void> }) {
  const isNew = memory.id.startsWith("draft-");
  const [draft, setDraft] = useState(memory);
  return (
    <div className="dialog-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-editor-title">
        <header><div><span className="eyebrow"><MemoryStick size={12} /> User-controlled context</span><h2 id="memory-editor-title">{isNew ? "Add a memory" : "Edit memory"}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close memory editor"><X size={17} /></button></header>
        <label>Memory type<select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as MemorySummary["type"] })}><option value="profile">Profile</option><option value="semantic">Business knowledge</option><option value="episodic">Event or decision</option></select></label>
        <label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={160} /></label>
        <label>What MRE should remember<textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} rows={5} maxLength={10000} /></label>
        <div className="form-row"><label>Importance <span>{Math.round(draft.importance * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={draft.importance} onChange={(event) => setDraft({ ...draft, importance: Number(event.target.value) })} /></label><label>Expiration date <small>Optional</small><input type="date" value={draft.expiresAt ?? ""} onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value || undefined })} /></label></div>
        <label className="check-control"><input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} /><span><strong>Pin this memory</strong><small>Prioritize it when relevant to an answer.</small></span></label>
        <footer><button className="button button--secondary" type="button" onClick={onClose}>Cancel</button><button className="button button--primary" type="button" disabled={!draft.title.trim() || !draft.content.trim()} onClick={() => void onSave(draft, isNew)}><Check size={15} /> Save memory</button></footer>
      </section>
    </div>
  );
}

function fromApiMemory(memory: ApiMemory): MemorySummary {
  return {
    id: memory.id,
    type: memory.memoryType,
    title: memory.title,
    content: memory.content,
    source: memory.sourceMessageId ? "Conversation message" : "Added by user",
    updatedAt: new Date(memory.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    importance: memory.importanceScore,
    confidence: memory.confidenceScore,
    pinned: memory.isPinned,
    expiresAt: memory.expiresAt ? memory.expiresAt.slice(0, 10) : undefined,
  };
}

function toApiChanges(changes: Partial<MemorySummary>) {
  return {
    ...(changes.type !== undefined && { memoryType: changes.type }),
    ...(changes.title !== undefined && { title: changes.title }),
    ...(changes.content !== undefined && { content: changes.content }),
    ...(changes.importance !== undefined && { importanceScore: changes.importance }),
    ...(changes.confidence !== undefined && { confidenceScore: changes.confidence }),
    ...(changes.pinned !== undefined && { isPinned: changes.pinned }),
    ...(Object.prototype.hasOwnProperty.call(changes, "expiresAt") && { expiresAt: changes.expiresAt ? new Date(`${changes.expiresAt}T00:00:00Z`).toISOString() : null }),
  };
}

function toApiCreate(memory: MemorySummary) {
  return toApiChanges(memory);
}

function newMemoryDraft(): MemorySummary {
  return { id: `draft-${crypto.randomUUID()}`, type: "semantic", title: "", content: "", source: "Added by user", updatedAt: "Now", importance: 0.7, confidence: 1, pinned: false };
}

function typeIcon(type: MemorySummary["type"]) {
  if (type === "profile") return <ShieldCheck size={12} />;
  if (type === "semantic") return <BrainCircuit size={12} />;
  return <History size={12} />;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
