import type { MemoryItem, MessageRole } from "@/lib/data/types";

export type AIMessageRole = Extract<MessageRole, "system" | "user" | "assistant" | "tool">;

export interface AIMessage {
  role: AIMessageRole;
  content: string;
  name?: string;
}

export interface AIRequest {
  messages: AIMessage[];
  conversationId?: string;
  userId?: string;
  systemPrompt?: string;
  memories?: MemoryItem[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type AIChunk =
  | { type: "activity"; label: string }
  | { type: "text"; text: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; finishReason?: string };

export interface ProviderHealth {
  available: boolean;
  provider: string;
  detail?: string;
}

export interface LanguageModelProvider {
  readonly name: string;
  streamResponse(input: AIRequest): AsyncIterable<AIChunk>;
  healthCheck?(signal?: AbortSignal): Promise<ProviderHealth>;
}

export interface SpeechWord {
  text: string;
  startSeconds?: number;
  endSeconds?: number;
  speakerId?: string;
  confidence?: number;
}

export interface SpeechInput {
  audio: Blob | ArrayBuffer | Uint8Array;
  mimeType: string;
  fileName?: string;
  language?: string;
  /** A transcript already produced by the browser Web Speech API. */
  browserTranscript?: string;
  signal?: AbortSignal;
}

export interface Transcript {
  text: string;
  provider: string;
  isFinal: boolean;
  language?: string;
  confidence?: number;
  words?: SpeechWord[];
  /** In credential-free mode, the browser should perform recognition locally. */
  clientFallback?: "web-speech-recognition";
}

export interface SpeechToTextProvider {
  readonly name: string;
  transcribe(input: SpeechInput): Promise<Transcript>;
  healthCheck?(signal?: AbortSignal): Promise<ProviderHealth>;
}

export type SpeechOutputFormat = "mp3_44100_128" | "mp3_22050_32" | "wav_44100";

export interface SpeechSynthesisInput {
  text: string;
  voice?: string;
  language?: string;
  speed?: number;
  outputFormat?: SpeechOutputFormat;
  signal?: AbortSignal;
}

export type AudioResult =
  | {
      kind: "audio";
      provider: string;
      audio: Uint8Array<ArrayBuffer>;
      contentType: string;
      requestId?: string;
    }
  | {
      kind: "browser-speech";
      provider: string;
      text: string;
      language?: string;
      voice?: string;
      rate: number;
    };

export interface TextToSpeechProvider {
  readonly name: string;
  synthesize(input: SpeechSynthesisInput): Promise<AudioResult>;
  healthCheck?(signal?: AbortSignal): Promise<ProviderHealth>;
}
