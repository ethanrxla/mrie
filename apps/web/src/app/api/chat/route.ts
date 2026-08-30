import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import {
  AttachmentValidationError,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS,
  validateChatAttachments,
} from "@/lib/chat/attachments";
import { ChatService } from "@/lib/chat/service";
import { getStore } from "@/lib/data";
import { ApiError, jsonError } from "@/lib/http";
import { logger } from "@/lib/logger";
import { createLanguageModelProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/errors";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 180;

const schema = z.object({
  message: z.string().trim().min(1).max(20_000),
  conversationId: z.string().uuid().optional(),
  attachments: z.array(
    z.object({
      name: z.string().min(1).max(260),
      mediaType: z.string().max(120).optional(),
      size: z.number().int().nonnegative().max(MAX_CHAT_ATTACHMENT_BYTES),
      content: z.string().max(MAX_CHAT_ATTACHMENT_BYTES),
    }).strict(),
  ).max(MAX_CHAT_ATTACHMENTS).optional().default([]),
});

const encoder = new TextEncoder();
const MAX_STREAMED_RESPONSE_CHARS = 2_000_000;
const event = (name: string, data: unknown) =>
  encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    enforceRateLimit(`chat:${user.id}`, { limit: 30, windowMs: 60_000 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "Send a valid JSON request body.", "invalid_json");
    }
    const input = schema.parse(body);
    const attachments = validateChatAttachments(input.attachments);
    const service = new ChatService(await getStore(), createLanguageModelProvider());
    const prepared = await service.prepare(user, input.message, input.conversationId, attachments);
    const providerAbort = new AbortController();
    const abortProvider = () => providerAbort.abort(request.signal.reason);
    if (request.signal.aborted) abortProvider();
    else request.signal.addEventListener("abort", abortProvider, { once: true });
    let streamClosed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let answer = "";
        const emit = (name: string, data: unknown): boolean => {
          if (streamClosed || providerAbort.signal.aborted) return false;
          try {
            controller.enqueue(event(name, data));
            return true;
          } catch {
            streamClosed = true;
            providerAbort.abort(new DOMException("Response stream closed", "AbortError"));
            return false;
          }
        };
        try {
          emit("started", {
              conversationId: prepared.conversation.id,
              userMessageId: prepared.userMessage.id,
          });
          emit("activity", { activity: "Searching business memory" });
          if (prepared.memories.length) {
            emit("memory", {
                memories: prepared.memories.map(({ id, title, memoryType }) => ({
                  id,
                  title,
                  memoryType,
                })),
            });
          }
          if (prepared.memoryCommand && prepared.memoryCommand.status !== "ignored") {
            emit("memory-command", serializeMemoryCommand(prepared.memoryCommand));
          }
          for await (const chunk of service.stream(prepared, user, providerAbort.signal)) {
            if (chunk.type === "activity") {
              if (!emit("activity", { activity: chunk.label })) break;
            } else if (chunk.type === "text") {
              if (answer.length + chunk.text.length > MAX_STREAMED_RESPONSE_CHARS) {
                throw new ProviderError("The provider response exceeded the server display limit", {
                  code: "BAD_RESPONSE",
                  provider: "configured-provider",
                });
              }
              answer += chunk.text;
              if (!emit("delta", { delta: chunk.text })) break;
            }
          }
          if (providerAbort.signal.aborted) return;
          const message = await service.finish(prepared, answer.trim());
          emit("done", {
              conversationId: prepared.conversation.id,
              messageId: message.id,
              memoryIds: prepared.memories.map((memory) => memory.id),
          });
        } catch (error) {
          if (providerAbort.signal.aborted) return;
          const providerError = error instanceof ProviderError;
          logger.warn("Chat stream failed", {
            provider: providerError ? error.provider : "unknown",
            errorType: error instanceof Error ? error.name : typeof error,
          });
          emit("error", {
              code: providerError ? error.code.toLowerCase() : "response_failed",
              message: providerError
                ? "The configured intelligence provider is temporarily unavailable."
                : "MRE could not complete this response.",
              retryable: providerError ? error.retryable : true,
          });
        } finally {
          request.signal.removeEventListener("abort", abortProvider);
          if (!streamClosed) {
            streamClosed = true;
            try {
              controller.close();
            } catch {
              // The client may have already closed the stream.
            }
          }
        }
      },
      cancel(reason) {
        streamClosed = true;
        request.signal.removeEventListener("abort", abortProvider);
        providerAbort.abort(reason);
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-store, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof AttachmentValidationError) {
      return jsonError(new ApiError(400, error.message, "invalid_attachment"));
    }
    if (error instanceof ApiError && error.status === 429) {
      const response = jsonError(error);
      response.headers.set("Retry-After", "60");
      return response;
    }
    return jsonError(error);
  }
}

function serializeMemoryCommand(result: Awaited<ReturnType<ChatService["memory"]["executeCommand"]>>) {
  if (result.status === "created") {
    return { status: result.status, memory: result.memory };
  }
  if (result.status === "found" || result.status === "needs-confirmation") {
    return { status: result.status, memories: result.memories };
  }
  if (result.status === "needs-input" || result.status === "rejected") {
    return { status: result.status, message: result.message };
  }
  return result;
}
