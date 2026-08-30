"use client";

import { Archive, Clock3, MessageSquareText, Plus, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { PageScaffold } from "@/components/pages/page-scaffold";

interface ConversationItem {
  id: string;
  title: string;
  summary?: string;
  updatedAt: string;
  messages?: number;
}

export function ConversationsView() {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/conversations", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Conversations unavailable");
        const payload = (await response.json()) as { conversations?: ConversationItem[] } | ConversationItem[];
        const items = Array.isArray(payload) ? payload : payload.conversations;
        setConversations((items ?? []).map((item) => ({
          ...item,
          updatedAt: formatConversationDate(item.updatedAt),
        })));
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setLoadError("Conversation history could not be loaded. No placeholder conversations are being shown.");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const filtered = useMemo(
    () => conversations.filter((conversation) => `${conversation.title} ${conversation.summary ?? ""}`.toLowerCase().includes(query.toLowerCase())),
    [conversations, query],
  );

  const archiveConversation = async (conversation: ConversationItem) => {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) {
      setNotice("That conversation could not be archived.");
      return;
    }
    setConversations((current) => current.filter((item) => item.id !== conversation.id));
    setNotice(`Archived “${conversation.title}”.`);
  };

  return (
    <PageScaffold
      eyebrow="Conversations"
      title="Conversation archive"
      description="Resume prior work with its transcript, sources, decisions, and remembered context intact."
      icon={MessageSquareText}
      actions={<Link className="button button--primary" href="/?new=true"><Plus size={16} /> New conversation</Link>}
    >
      {notice && <div className="inline-notice" role="status"><Archive size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {loadError && <div className="inline-notice inline-notice--warning" role="alert"><span>{loadError}</span></div>}
      <div className="filter-bar">
        <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></label>
      </div>
      {loading && <div className="loading-line" role="status"><span /> Synchronizing conversations…</div>}
      <div className="conversation-grid">
        {filtered.map((conversation) => (
          <article className="conversation-card" key={conversation.id}>
            <div className="conversation-card__top">
              <span className="conversation-card__icon"><MessageSquareText size={17} /></span>
              <button className="icon-button" type="button" onClick={() => void archiveConversation(conversation)} aria-label={`Archive ${conversation.title}`}><Archive size={16} /></button>
            </div>
            <h2>{conversation.title}</h2>
            <p>{conversation.summary ?? "Conversation ready to resume."}</p>
            <footer>
              <span><Clock3 size={12} /> {conversation.updatedAt}</span>
              {conversation.messages !== undefined && <span>{conversation.messages} messages</span>}
            </footer>
            <Link href={`/?conversation=${encodeURIComponent(conversation.id)}`} aria-label={`Resume ${conversation.title}`}>Resume <Sparkles size={13} /></Link>
          </article>
        ))}
      </div>
      {!loading && !loadError && !filtered.length && (
        <div className="empty-state"><Search size={24} /><h2>{conversations.length ? "No conversations match" : "No conversations yet"}</h2><p>{conversations.length ? "Try a broader phrase." : "Start a command session and its persisted transcript will appear here."}</p></div>
      )}
    </PageScaffold>
  );
}

function formatConversationDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
