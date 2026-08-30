import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { jsonError, noStoreJson } from "@/lib/http";
import { createTextToSpeechProvider } from "@/lib/providers";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.object({
  text: z.string().trim().min(1).max(8_000),
  voice: z.string().trim().max(120).optional(),
  language: z.string().trim().max(20).optional(),
  speed: z.number().min(0.7).max(1.2).optional(),
});

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    enforceRateLimit(`tts:${user.id}`, { limit: 30, windowMs: 60_000 });
    const input = schema.parse(await request.json());
    const result = await createTextToSpeechProvider().synthesize({ ...input, signal: request.signal });
    if (result.kind === "browser-speech") return noStoreJson(result);
    return new Response(result.audio, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": result.contentType,
        ...(result.requestId ? { "X-Provider-Request-Id": result.requestId } : {}),
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
