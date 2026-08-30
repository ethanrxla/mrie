"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatMessage, MrieState } from "@/components/command/types";
import type { ChatAttachment } from "@/lib/chat/attachments";

interface StreamPayload {
  delta?: string;
  content?: string;
  message?: string;
  activity?: string;
  conversationId?: string;
  userMessageId?: string;
  messageId?: string;
  status?: string;
  memories?: Array<{ id: string; title: string; content?: string }>;
  memory?: { id: string; title: string };
  sources?: Array<{ title: string; url?: string }>;
}

interface UseStreamingChatOptions {
  onComplete?: (text: string) => void;
}

const MAX_STREAMED_TEXT_CHARS = 2_000_000;

class ChatRequestError extends Error {}

export function useStreamingChat({ onComplete }: UseStreamingChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<MrieState>("idle");
  const [statusText, setStatusText] = useState("Ready");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [historyError, setHistoryError] = useState<string | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const operationRef = useRef(0);

  const clearStatusTimer = useCallback(() => {
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = null;
  }, []);

  useEffect(
    () => () => {
      operationRef.current += 1;
      chatAbortRef.current?.abort();
      historyAbortRef.current?.abort();
      clearStatusTimer();
    },
    [clearStatusTimer],
  );

  const patchMessage = useCallback((id: string, changes: Partial<ChatMessage>) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...changes } : message)),
    );
  }, []);

  const appendDelta = useCallback((id: string, delta: string) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === id ? { ...message, content: `${message.content}${delta}` } : message,
      ),
    );
  }, []);

  const sendMessage = useCallback(
    async (rawMessage: string, attachments: ChatAttachment[] = []) => {
      const message = rawMessage.trim();
      if (!message || chatAbortRef.current) return;

      historyAbortRef.current?.abort();
      historyAbortRef.current = null;
      clearStatusTimer();
      const operation = ++operationRef.current;
      const userId = crypto.randomUUID();
      const assistantId = crypto.randomUUID();
      setHistoryError(null);
      setMessages((current) => [
        ...current,
        { id: userId, role: "user", content: message, attachments, createdAt: new Date() },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          createdAt: new Date(),
          activity: "Connecting to MRE",
        },
      ]);
      setState("processing");
      setStatusText("Understanding");

      const controller = new AbortController();
      chatAbortRef.current = controller;
      let completedText = "";

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ conversationId, message, attachments }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new ChatRequestError(
            payload?.error?.message ?? `Chat service returned ${response.status}.`,
          );
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.toLowerCase().includes("json")) {
          const payload = (await response.json()) as StreamPayload;
          completedText = payload.content ?? payload.message ?? "Response completed.";
          appendDelta(assistantId, completedText);
          if (payload.conversationId) setConversationId(payload.conversationId);
        } else {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let receivedDone = false;

          const consumeFrames = (frames: string[]) => {
            for (const frame of frames) {
              const parsed = parseSseFrame(frame);
              if (!parsed) continue;
              const { event, payload } = parsed;
              if (event === "started") {
                if (payload.conversationId) setConversationId(payload.conversationId);
                if (payload.userMessageId) patchMessage(userId, { serverId: payload.userMessageId });
              } else if (event === "activity") {
                const activity = payload.activity ?? payload.message ?? "Working";
                setStatusText(activity);
                patchMessage(assistantId, { activity });
              } else if (event === "memory") {
                const memories = payload.memories ?? (payload.memory ? [payload.memory] : []);
                patchMessage(assistantId, { memoryUsed: memories });
                setStatusText("Retrieving memory");
              } else if (event === "delta") {
                const delta = payload.delta ?? payload.content ?? "";
                if (completedText.length + delta.length > MAX_STREAMED_TEXT_CHARS) {
                  throw new Error("The streamed response exceeded the display limit.");
                }
                completedText += delta;
                appendDelta(assistantId, delta);
              } else if (event === "memory-command") {
                patchMessage(assistantId, {
                  memoryAction: {
                    status: payload.status ?? "review",
                    commandText: message,
                    message: payload.message,
                    memories: payload.memories,
                  },
                });
              } else if (event === "done") {
                receivedDone = true;
                if (payload.conversationId) setConversationId(payload.conversationId);
                if (payload.messageId) patchMessage(assistantId, { serverId: payload.messageId });
                if (payload.sources) patchMessage(assistantId, { sources: payload.sources });
              } else if (event === "error") {
                throw new Error(payload.message ?? "The AI provider could not complete the response.");
              }
            }
          };

          try {
            while (true) {
              const result = await reader.read();
              buffer += decoder.decode(result.value, { stream: !result.done });
              const frames = buffer.split(/\r?\n\r?\n/);
              buffer = frames.pop() ?? "";
              consumeFrames(frames);
              if (result.done) break;
            }
            if (buffer.trim()) consumeFrames([buffer]);
          } finally {
            reader.releaseLock();
          }
          if (!receivedDone) throw new Error("The response stream ended before completion.");
        }

        if (controller.signal.aborted || operationRef.current !== operation) return;
        setState("success");
        setStatusText("Complete");
        patchMessage(assistantId, { activity: undefined });
        if (completedText) onComplete?.(completedText);
        statusTimerRef.current = window.setTimeout(() => {
          if (operationRef.current !== operation) return;
          setState((current) => (current === "success" ? "idle" : current));
          setStatusText((current) => (current === "Complete" ? "Ready" : current));
          statusTimerRef.current = null;
        }, 1_100);
      } catch (error) {
        if (operationRef.current !== operation) return;
        if (controller.signal.aborted) {
          patchMessage(assistantId, {
            activity: undefined,
            stopped: true,
            content: completedText || "Response stopped.",
          });
          setState("idle");
          setStatusText("Stopped");
        } else {
          patchMessage(assistantId, {
            activity: undefined,
            content:
              completedText ||
              (error instanceof ChatRequestError
                ? error.message
                : "MRE could not complete that request. Your message remains visible so you can retry."),
          });
          setState("error");
          setStatusText(navigator.onLine ? "Intelligence provider unavailable" : "Offline");
        }
      } finally {
        if (chatAbortRef.current === controller) chatAbortRef.current = null;
      }
    },
    [appendDelta, clearStatusTimer, conversationId, onComplete, patchMessage],
  );

  const stopGeneration = useCallback(() => {
    chatAbortRef.current?.abort();
    historyAbortRef.current?.abort();
  }, []);

  const newConversation = useCallback(() => {
    operationRef.current += 1;
    const chatController = chatAbortRef.current;
    const historyController = historyAbortRef.current;
    chatController?.abort();
    historyController?.abort();
    if (chatAbortRef.current === chatController) chatAbortRef.current = null;
    if (historyAbortRef.current === historyController) historyAbortRef.current = null;
    clearStatusTimer();
    setMessages([]);
    setConversationId(undefined);
    setHistoryError(null);
    setState("idle");
    setStatusText("Ready");
  }, [clearStatusTimer]);

  const loadConversation = useCallback(
    async (id: string) => {
      const previousChat = chatAbortRef.current;
      previousChat?.abort();
      if (chatAbortRef.current === previousChat) chatAbortRef.current = null;
      historyAbortRef.current?.abort();
      clearStatusTimer();
      const controller = new AbortController();
      historyAbortRef.current = controller;
      const operation = ++operationRef.current;
      setHistoryError(null);
      setState("processing");
      setStatusText("Restoring conversation");
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Conversation unavailable");
        const payload = (await response.json()) as {
          conversation?: { id: string };
          messages?: Array<{
            id: string;
            role: string;
            content: string;
            createdAt: string;
            sources?: Array<{ title: string; url?: string }>;
            memoryIds?: string[];
            toolActivity?: Array<{ label: string; status: string }>;
            attachments?: ChatAttachment[];
          }>;
        };
        if (controller.signal.aborted || operationRef.current !== operation) return;
        const restored = (payload.messages ?? [])
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map<ChatMessage>((message) => ({
            id: message.id,
            role: message.role as "user" | "assistant",
            content: message.content,
            createdAt: new Date(message.createdAt),
            serverId: message.id,
            attachments: message.attachments ?? [],
            sources: message.sources,
            memoryUsed: message.memoryIds?.map((memoryId) => ({
              id: memoryId,
              title: "Retrieved memory",
            })),
            activity: message.toolActivity?.find((activity) => activity.status !== "completed")?.label,
          }));
        setMessages(restored);
        setConversationId(payload.conversation?.id ?? id);
        setState("success");
        setStatusText("Conversation restored");
        statusTimerRef.current = window.setTimeout(() => {
          if (operationRef.current !== operation) return;
          setState((current) => (current === "success" ? "idle" : current));
          setStatusText((current) => (current === "Conversation restored" ? "Ready" : current));
          statusTimerRef.current = null;
        }, 900);
      } catch {
        if (controller.signal.aborted || operationRef.current !== operation) return;
        setHistoryError("That conversation could not be restored. You can continue in a new session.");
        setState("error");
        setStatusText("History unavailable");
      } finally {
        if (historyAbortRef.current === controller) historyAbortRef.current = null;
      }
    },
    [clearStatusTimer],
  );

  return {
    messages,
    state,
    setState,
    statusText,
    setStatusText,
    conversationId,
    historyError,
    isGenerating: state === "processing",
    sendMessage,
    stopGeneration,
    loadConversation,
    newConversation,
  };
}

export function parseSseFrame(frame: string): { event: string; payload: StreamPayload } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join("\n");
  try {
    return { event, payload: JSON.parse(raw) as StreamPayload };
  } catch {
    return { event, payload: event === "delta" ? { delta: raw } : { message: raw } };
  }
}
