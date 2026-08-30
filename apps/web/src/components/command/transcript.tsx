"use client";

import {
  BookmarkPlus,
  Bot,
  CalendarPlus,
  Check,
  ChevronDown,
  Clipboard,
  ExternalLink,
  FileOutput,
  Paperclip,
  Pause,
  Play,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Waves,
  UserRound,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { ChatMessage } from "@/components/command/types";
import { scrollTranscriptIntoView } from "@/components/command/transcript-scroll";
import { cn } from "@/components/ui/cn";

interface TranscriptProps {
  messages: ChatMessage[];
  speaking: boolean;
  onSpeak: (text: string) => void;
  onStopSpeaking: () => void;
  onRetry: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
}

export function Transcript({ messages, speaking, onSpeak, onStopSpeaking, onRetry, onEdit }: TranscriptProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollTranscriptIntoView(bottomRef.current);
  }, [messages]);

  return (
    <section className="transcript-panel" aria-label="Live conversation transcript">
      <div className="transcript-panel__header">
        <span>
          <span className="live-dot" aria-hidden="true" />
          Live transcript
        </span>
        <Link className="text-button" href="/conversations">
          Current conversation <ChevronDown size={14} />
        </Link>
      </div>
      <div className="transcript" aria-live="polite" aria-relevant="additions text">
        {!messages.length && (
          <div className="empty-state transcript-empty">
            <Waves size={24} />
            <h2>No conversation yet</h2>
            <p>Type a message or click the microphone control to start a live exchange with MRE</p>
          </div>
        )}
        {messages.map((message, index) => (
          <MessageBubble
            key={message.id}
            message={message}
            speaking={speaking && index === messages.length - 1}
            onSpeak={onSpeak}
            onStopSpeaking={onStopSpeaking}
            onRetry={onRetry}
            onEdit={onEdit}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

function MessageBubble({
  message,
  speaking,
  onSpeak,
  onStopSpeaking,
  onRetry,
  onEdit,
}: {
  message: ChatMessage;
  speaking: boolean;
  onSpeak: (text: string) => void;
  onStopSpeaking: () => void;
  onRetry: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [savedMemoryId, setSavedMemoryId] = useState<string | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const saveMemory = async () => {
    try {
      if (savedMemoryId) {
        const response = await fetch(`/api/memory/${encodeURIComponent(savedMemoryId)}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error("Delete rejected");
        setSavedMemoryId(null);
        setMemoryStatus("Removed from memory");
      } else {
        const response = await fetch("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            memoryType: "semantic",
            title: "Saved from conversation",
            content: message.content,
            ...(message.serverId ? { sourceMessageId: message.serverId } : {}),
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          memory?: { id: string };
          error?: { message?: string };
        };
        if (!response.ok || !payload.memory) {
          throw new Error(payload.error?.message ?? "Memory write rejected");
        }
        setSavedMemoryId(payload.memory.id);
        setMemoryStatus("Saved to memory");
      }
    } catch {
      setMemoryStatus("Memory was not changed");
    }
  };

  const confirmMemoryAction = async () => {
    if (!message.memoryAction?.memories?.length) return;
    setActionStatus("Applying confirmed memory change…");
    try {
      const response = await fetch("/api/memory/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: message.memoryAction.commandText,
          confirmedIds: message.memoryAction.memories.map((memory) => memory.id),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        result?: { status?: string; deletedIds?: string[] };
      };
      if (!response.ok || !payload.result) throw new Error("Memory action failed");
      setActionStatus(
        payload.result.status === "deleted" ? "Confirmed memories forgotten" : "Memory corrected",
      );
    } catch {
      setActionStatus("No memory was changed");
    }
  };

  return (
    <article className={cn("message", `message--${message.role}`)}>
      <div className="message__avatar" aria-hidden="true">
        {message.role === "assistant" ? <Bot size={16} /> : <UserRound size={16} />}
      </div>
      <div className="message__body">
        <div className="message__meta">
          <strong>{message.role === "assistant" ? "MRE" : "You"}</strong>
          <time suppressHydrationWarning>
            {message.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
          {message.role === "assistant" && <span className="verified-label"><ShieldCheck size={11} /> AI-generated</span>}
        </div>
        {message.activity && !message.content && (
          <div className="activity-line">
            <span className="activity-line__pulse" />
            {message.activity}
          </div>
        )}
        {message.content && <p>{message.content}</p>}
        {!!message.attachments?.length && (
          <div className="message-attachments" aria-label={`${message.attachments.length} attached files`}>
            {message.attachments.map((attachment) => (
              <span key={`${attachment.name}-${attachment.size}`} title={attachment.mediaType}>
                <Paperclip size={12} /> {attachment.name} · {formatFileSize(attachment.size)}
              </span>
            ))}
          </div>
        )}
        {message.stopped && <span className="stopped-label"><Square size={9} /> Interrupted</span>}

        {!!message.memoryUsed?.length && (
          <details className="context-detail">
            <summary>
              <Sparkles size={13} /> Memory used · {message.memoryUsed.length}
            </summary>
            <div>
              {message.memoryUsed.map((memory) => (
                <span key={memory.id}>{memory.title}</span>
              ))}
            </div>
          </details>
        )}
        {!!message.sources?.length && (
          <details className="context-detail">
            <summary>
              <FileOutput size={13} /> Sources · {message.sources.length}
            </summary>
            <div>
              {message.sources.map((source) =>
                source.url ? (
                  <a key={source.title} href={source.url} rel="noreferrer" target="_blank">
                    {source.title} <ExternalLink size={11} />
                  </a>
                ) : (
                  <span key={source.title}>{source.title}</span>
                ),
              )}
            </div>
          </details>
        )}

        {message.memoryAction?.status === "needs-confirmation" && (
          <div className="memory-command-review" role="status">
            <strong>Memory change requires confirmation</strong>
            <p>
              {message.memoryAction.memories?.map((memory) => memory.title).join(", ")}
            </p>
            {actionStatus ? (
              <span>{actionStatus}</span>
            ) : (
              <button type="button" onClick={() => void confirmMemoryAction()}>
                <ShieldCheck size={13} /> Confirm this memory change
              </button>
            )}
          </div>
        )}
        {message.memoryAction?.message && (
          <div className="memory-command-review" role="status">{message.memoryAction.message}</div>
        )}

        {message.content && (
          <div className="message-actions" aria-label={`${message.role} message actions`}>
            <button type="button" onClick={copy} aria-label="Copy message">
              {copied ? <Check size={14} /> : <Clipboard size={14} />}
            </button>
            {message.role === "assistant" && (
              <>
                <button type="button" onClick={speaking ? onStopSpeaking : () => onSpeak(message.content)} aria-label={speaking ? "Stop audio" : "Play audio"}>
                  {speaking ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button type="button" onClick={() => onRetry(message)} aria-label="Retry response">
                  <RotateCcw size={14} />
                </button>
              </>
            )}
            {message.role === "user" && (
              <button type="button" onClick={() => onEdit(message)} aria-label="Edit and resend message">
                <Pencil size={14} />
              </button>
            )}
            <button type="button" onClick={saveMemory} aria-label="Save as memory">
              {savedMemoryId ? <Check size={14} /> : <BookmarkPlus size={14} />}
            </button>
            <Link href="/scheduling" aria-label="Create task from message"><CalendarPlus size={14} /></Link>
            <Link href="/automations" aria-label="Create automation from message"><Workflow size={14} /></Link>
            {memoryStatus && <span className="sr-only" role="status">{memoryStatus}</span>}
          </div>
        )}
      </div>
    </article>
  );
}

function formatFileSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  return `${Math.ceil(size / 1_024)} KB`;
}
