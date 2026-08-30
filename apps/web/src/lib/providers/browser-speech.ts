import { throwIfAborted } from "./errors";
import type {
  AudioResult,
  ProviderHealth,
  SpeechInput,
  SpeechSynthesisInput,
  SpeechToTextProvider,
  TextToSpeechProvider,
  Transcript,
} from "./types";

/**
 * Browser-native speech adapter. Audio never leaves the browser in this mode;
 * the UI uses Web Speech APIs and may pass the resulting transcript here.
 */
export class BrowserSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = "browser";

  async transcribe(input: SpeechInput): Promise<Transcript> {
    throwIfAborted(input.signal, this.name);
    return {
      text: input.browserTranscript?.trim() ?? "",
      provider: this.name,
      isFinal: Boolean(input.browserTranscript?.trim()),
      language: input.language,
      confidence: input.browserTranscript?.trim() ? 1 : undefined,
      clientFallback: "web-speech-recognition",
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      available: true,
      provider: this.name,
      detail: "Delegates recognition to the browser when supported",
    };
  }
}

/** Returns a directive for window.speechSynthesis; it does not fabricate audio. */
export class BrowserTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = "browser";

  async synthesize(input: SpeechSynthesisInput): Promise<AudioResult> {
    throwIfAborted(input.signal, this.name);
    return {
      kind: "browser-speech",
      provider: this.name,
      text: input.text,
      language: input.language,
      voice: input.voice,
      rate: Math.max(0.5, Math.min(2, input.speed ?? 1)),
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      available: true,
      provider: this.name,
      detail: "Delegates synthesis to the browser when supported",
    };
  }
}
