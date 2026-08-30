import "server-only";

import type { ServerEnv } from "@/lib/env";
import { getEnv } from "@/lib/env";

import { ElevenLabsSpeechToTextProvider, ElevenLabsTextToSpeechProvider } from "./elevenlabs";
import { ProviderError } from "./errors";
import { BrowserSpeechToTextProvider, BrowserTextToSpeechProvider } from "./browser-speech";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./types";

export function createSpeechToTextProvider(env: ServerEnv = getEnv()): SpeechToTextProvider {
  if (env.STT_PROVIDER === "browser") return new BrowserSpeechToTextProvider();
  if (!env.ELEVENLABS_API_KEY) {
    throw new ProviderError("ElevenLabs STT requires ELEVENLABS_API_KEY", {
      code: "CONFIGURATION",
      provider: "elevenlabs",
    });
  }
  return new ElevenLabsSpeechToTextProvider(env.ELEVENLABS_API_KEY, env.ELEVENLABS_STT_MODEL);
}

export function createTextToSpeechProvider(env: ServerEnv = getEnv()): TextToSpeechProvider {
  if (env.TTS_PROVIDER === "browser") return new BrowserTextToSpeechProvider();
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
    throw new ProviderError("ElevenLabs TTS requires ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID", {
      code: "CONFIGURATION",
      provider: "elevenlabs",
    });
  }
  return new ElevenLabsTextToSpeechProvider(
    env.ELEVENLABS_API_KEY,
    env.ELEVENLABS_VOICE_ID,
    env.ELEVENLABS_TTS_MODEL,
  );
}
