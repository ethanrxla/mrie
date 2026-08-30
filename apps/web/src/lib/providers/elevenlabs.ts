import { boundedErrorBody, errorForHttpStatus, ProviderError, throwIfAborted } from "./errors";
import type {
  AudioResult,
  ProviderHealth,
  SpeechInput,
  SpeechSynthesisInput,
  SpeechToTextProvider,
  SpeechWord,
  TextToSpeechProvider,
  Transcript,
} from "./types";

const API_BASE = "https://api.elevenlabs.io/v1";

interface ElevenLabsTranscript {
  text?: string;
  language_code?: string;
  language_probability?: number;
  words?: Array<{
    text?: string;
    start?: number;
    end?: number;
    speaker_id?: string;
    logprob?: number;
    type?: string;
  }>;
}

function audioBlob(input: SpeechInput): Blob {
  if (input.audio instanceof Blob) return input.audio;
  if (input.audio instanceof ArrayBuffer) return new Blob([input.audio], { type: input.mimeType });
  const bytes = new Uint8Array(input.audio.byteLength);
  bytes.set(input.audio);
  return new Blob([bytes.buffer], { type: input.mimeType });
}

function wordConfidence(logProbability: number | undefined): number | undefined {
  if (logProbability === undefined || !Number.isFinite(logProbability)) return undefined;
  return Math.max(0, Math.min(1, Math.exp(logProbability)));
}

export class ElevenLabsSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = "elevenlabs";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async transcribe(input: SpeechInput): Promise<Transcript> {
    throwIfAborted(input.signal, this.name);
    const form = new FormData();
    form.append("file", audioBlob(input), input.fileName ?? "mre-capture.webm");
    form.append("model_id", this.model);
    if (input.language) form.append("language_code", input.language);
    form.append("tag_audio_events", "false");

    let response: Response;
    try {
      response = await fetch(`${API_BASE}/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": this.apiKey },
        body: form,
        cache: "no-store",
        signal: input.signal,
      });
    } catch (error) {
      throwIfAborted(input.signal, this.name);
      throw new ProviderError("Speech recognition is unavailable", {
        code: "UNAVAILABLE",
        provider: this.name,
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      throw errorForHttpStatus(this.name, response.status, await boundedErrorBody(response));
    }

    const payload = (await response.json()) as ElevenLabsTranscript;
    if (typeof payload.text !== "string") {
      throw new ProviderError("ElevenLabs returned no transcript", {
        code: "BAD_RESPONSE",
        provider: this.name,
      });
    }

    const words: SpeechWord[] | undefined = payload.words
      ?.filter((word) => word.type === undefined || word.type === "word")
      .map((word) => ({
        text: word.text ?? "",
        startSeconds: word.start,
        endSeconds: word.end,
        speakerId: word.speaker_id,
        confidence: wordConfidence(word.logprob),
      }));

    return {
      text: payload.text.trim(),
      provider: this.name,
      isFinal: true,
      language: payload.language_code,
      confidence: payload.language_probability,
      words,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { available: true, provider: this.name, detail: "ElevenLabs STT is configured" };
  }
}

export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = "elevenlabs";

  constructor(
    private readonly apiKey: string,
    private readonly defaultVoiceId: string,
    private readonly model: string,
  ) {}

  async synthesize(input: SpeechSynthesisInput): Promise<AudioResult> {
    throwIfAborted(input.signal, this.name);
    const voiceId = input.voice?.trim() || this.defaultVoiceId;
    const outputFormat = input.outputFormat ?? "mp3_44100_128";
    const speed = input.speed === undefined ? undefined : Math.max(0.7, Math.min(1.2, input.speed));
    const url = `${API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(outputFormat)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "audio/mpeg",
          "content-type": "application/json",
          "xi-api-key": this.apiKey,
        },
        body: JSON.stringify({
          text: input.text,
          model_id: this.model,
          ...(input.language ? { language_code: input.language } : {}),
          ...(speed === undefined ? {} : { voice_settings: { speed } }),
        }),
        cache: "no-store",
        signal: input.signal,
      });
    } catch (error) {
      throwIfAborted(input.signal, this.name);
      throw new ProviderError("Speech synthesis is unavailable", {
        code: "UNAVAILABLE",
        provider: this.name,
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      throw errorForHttpStatus(this.name, response.status, await boundedErrorBody(response));
    }

    return {
      kind: "audio",
      provider: this.name,
      audio: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
      requestId: response.headers.get("request-id") ?? undefined,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { available: true, provider: this.name, detail: "ElevenLabs TTS is configured" };
  }
}
