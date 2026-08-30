import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { ApiError, jsonError, noStoreJson } from "@/lib/http";
import { createSpeechToTextProvider } from "@/lib/providers";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    enforceRateLimit(`stt:${user.id}`, { limit: 20, windowMs: 60_000 });
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof Blob) || !audio.size) {
      throw new ApiError(400, "Attach a non-empty audio recording.", "audio_required");
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      throw new ApiError(413, "The audio recording is too large.", "audio_too_large");
    }
    const transcript = await createSpeechToTextProvider().transcribe({
      audio,
      mimeType: audio.type || "audio/webm",
      fileName: audio instanceof File ? audio.name : "mre-capture.webm",
      language: typeof form.get("language") === "string" ? String(form.get("language")) : undefined,
      browserTranscript:
        typeof form.get("browserTranscript") === "string"
          ? String(form.get("browserTranscript"))
          : undefined,
      signal: request.signal,
    });
    return noStoreJson({ transcript });
  } catch (error) {
    return jsonError(error);
  }
}
