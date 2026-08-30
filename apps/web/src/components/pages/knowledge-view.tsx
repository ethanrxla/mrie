"use client";

import {
  BookOpenCheck,
  BrainCircuit,
  CheckCircle2,
  FileText,
  Link2,
  MemoryStick,
  Plus,
  Search,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { MetricCard, PageScaffold } from "@/components/pages/page-scaffold";

interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
  confidenceScore: number;
  createdAt: string;
  updatedAt: string;
}

interface KnowledgeDraft {
  title: string;
  content: string;
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_CONTENT_CHARS = 10_000;
const acceptedExtensions = new Set(["txt", "md", "csv", "json", "yaml", "yml", "html", "xml"]);

export function KnowledgeView() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderedAt] = useState(() => new Date().valueOf());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadKnowledge(controller.signal)
      .then(setItems)
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(errorMessage(caught, "Trusted knowledge could not be loaded."));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const filtered = useMemo(
    () => items.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(query.trim().toLowerCase())),
    [items, query],
  );
  const latestUpdate = useMemo(() => items
    .map((item) => Date.parse(item.updatedAt))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0], [items]);

  const createKnowledge = async (draft: KnowledgeDraft) => {
    const response = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memoryType: "semantic",
        title: draft.title.trim(),
        content: draft.content.trim().slice(0, MAX_CONTENT_CHARS),
        importanceScore: 0.72,
        confidenceScore: 1,
        isPinned: false,
      }),
    });
    const payload = await readJson<{ memory?: KnowledgeItem }>(response);
    if (!response.ok || !payload.memory) throw new Error(apiError(payload, "The knowledge source could not be saved."));
    setItems((current) => [payload.memory!, ...current.filter((item) => item.id !== payload.memory!.id)]);
    return payload.memory;
  };

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    setError(null);
    let created = 0;
    const rejected: string[] = [];
    for (const file of files.slice(0, 8)) {
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (file.size > MAX_FILE_BYTES || !acceptedExtensions.has(extension)) {
        rejected.push(file.name);
        continue;
      }
      try {
        const content = (await file.text()).trim();
        if (!content) {
          rejected.push(file.name);
          continue;
        }
        await createKnowledge({ title: file.name, content });
        created += 1;
      } catch {
        rejected.push(file.name);
      }
    }
    setUploading(false);
    if (created) setNotice(`${created} trusted text ${created === 1 ? "source" : "sources"} indexed for semantic retrieval.`);
    if (rejected.length) setError(`Skipped ${rejected.join(", ")}. Use a text-based file up to 1 MB; binary documents require a configured ingestion adapter.`);
  };

  return (
    <PageScaffold
      eyebrow="Knowledge"
      title="Knowledge fabric"
      description="Curate authenticated semantic knowledge that MRE can retrieve when preparing an answer."
      icon={BrainCircuit}
      actions={(
        <>
          <input ref={inputRef} type="file" accept=".txt,.md,.csv,.json,.yaml,.yml,.html,.xml,text/*" multiple hidden onChange={(event) => { void uploadFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button className="button button--secondary" type="button" onClick={() => inputRef.current?.click()} disabled={uploading}><UploadCloud size={15} /> {uploading ? "Indexing…" : "Upload text"}</button>
          <button className="button button--primary" type="button" onClick={() => setDraftOpen(true)}><Plus size={16} /> Trusted note</button>
        </>
      )}
    >
      {notice && <div className="inline-notice" role="status"><CheckCircle2 size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {error && <div className="inline-notice inline-notice--warning" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}

      <div className="metric-grid">
        <MetricCard label="Trusted sources" value={String(items.length)} detail="server-persisted semantic records" />
        <MetricCard label="Pinned sources" value={String(items.filter((item) => item.isPinned).length)} detail="prioritized during retrieval" />
        <MetricCard label="Last updated" value={latestUpdate ? relativeTime(latestUpdate, renderedAt) : "—"} detail="authenticated workspace data" />
        <MetricCard label="Retrieval" value="Enabled" detail="relevance-ranked with memory" />
      </div>

      <div className="filter-bar">
        <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search trusted knowledge" aria-label="Search knowledge" /></label>
        <Link className="button button--secondary" href="/integrations"><Link2 size={15} /> Connected sources</Link>
      </div>

      {loading && <div className="loading-line" role="status"><span /> Loading trusted knowledge…</div>}
      <div className="knowledge-grid">
        {filtered.map((item, index) => (
          <article key={item.id} className={`knowledge-card knowledge-card--${["cyan", "blue", "violet"][index % 3]}`}>
            <header><span><FileText size={20} /></span>{item.isPinned && <span className="status-pill"><span /> Pinned</span>}</header>
            <h2>{item.title}</h2>
            <p>{item.content}</p>
            <div className="knowledge-card__stats"><span><ShieldCheck size={13} /> {Math.round(item.confidenceScore * 100)}% confidence</span><span>Updated {formatDate(item.updatedAt)}</span></div>
            <footer><span><BookOpenCheck size={13} /> Retrieval enabled</span><Link href="/memory">Manage source</Link></footer>
          </article>
        ))}
        <button className="knowledge-add" type="button" onClick={() => setDraftOpen(true)}><span><Plus size={22} /></span><strong>Add trusted knowledge</strong><small>A fact, SOP, product note, or business definition</small></button>
      </div>
      {!loading && !filtered.length && <div className="empty-state"><MemoryStick size={24} /><h2>No trusted knowledge found</h2><p>Add a note, upload a text source, or broaden the search.</p></div>}

      <section className="policy-banner"><ShieldCheck size={16} /><span><strong>Same privacy controls as Memory.</strong> Secrets, payment data, private keys, medical information, and protected identifiers are rejected; every source can be edited, pinned, expired, exported, or deleted.</span></section>

      {draftOpen && <KnowledgeEditor onClose={() => setDraftOpen(false)} onCreate={async (draft) => {
        const memory = await createKnowledge(draft);
        setDraftOpen(false);
        setNotice(`${memory.title} is available to MRE’s semantic retrieval.`);
      }} />}
    </PageScaffold>
  );
}

function KnowledgeEditor({ onClose, onCreate }: { onClose: () => void; onCreate: (draft: KnowledgeDraft) => Promise<void> }) {
  const [draft, setDraft] = useState<KnowledgeDraft>({ title: "", content: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [busy, onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate(draft);
    } catch (caught) {
      setError(errorMessage(caught, "The trusted note could not be saved."));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form className="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-editor-title" onSubmit={(event) => void submit(event)}>
        <header><div><span className="eyebrow"><BrainCircuit size={12} /> Semantic knowledge</span><h2 id="knowledge-editor-title">Add trusted note</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Close knowledge editor"><X size={17} /></button></header>
        <label>Title<input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={160} required /></label>
        <label>Trusted content <small>{draft.content.length}/{MAX_CONTENT_CHARS}</small><textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} maxLength={MAX_CONTENT_CHARS} rows={8} required /></label>
        {error && <div className="inline-notice inline-notice--warning" role="alert"><span>{error}</span></div>}
        <div className="policy-banner"><ShieldCheck size={15} /><span>This becomes transparent semantic memory and remains fully editable in Memory.</span></div>
        <footer><button className="button button--secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button button--primary" type="submit" disabled={busy || !draft.title.trim() || !draft.content.trim()}>{busy ? "Saving…" : "Save trusted note"}</button></footer>
      </form>
    </div>
  );
}

async function loadKnowledge(signal: AbortSignal): Promise<KnowledgeItem[]> {
  const response = await fetch("/api/memory?type=semantic", { signal });
  const payload = await readJson<{ memories?: KnowledgeItem[] }>(response);
  if (!response.ok || !payload.memories) throw new Error(apiError(payload, "Trusted knowledge could not be loaded."));
  return payload.memories;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function apiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  }
  return fallback;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "recently" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function relativeTime(timestamp: number, now: number) {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "Now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}
