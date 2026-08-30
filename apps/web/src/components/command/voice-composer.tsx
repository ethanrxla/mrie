"use client";

import {
  AlertTriangle,
  ArrowUp,
  AudioLines,
  ChevronDown,
  Headphones,
  Keyboard,
  Mic,
  MicOff,
  Paperclip,
  Radio,
  Settings2,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type { MicrophonePermission, NoiseState } from "@/components/hooks/use-microphone";
import { cn } from "@/components/ui/cn";
import {
  AttachmentValidationError,
  CHAT_ATTACHMENT_ACCEPT,
  attachmentsFromFiles,
  type ChatAttachment,
} from "@/lib/chat/attachments";

interface VoiceComposerProps {
  value: string;
  onChange: (value: string) => void;
  attachments: ChatAttachment[];
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onSend: () => void;
  isGenerating: boolean;
  onStopGeneration: () => void;
  isListening: boolean;
  onStartListening: () => Promise<void>;
  onStopListening: (submit?: boolean) => void;
  partialTranscript: string;
  inputLevel: number;
  noiseState: NoiseState;
  permission: MicrophonePermission;
  microphoneError: string | null;
  devices: MediaDeviceInfo[];
  selectedDeviceId: string;
  onSelectDevice: (id: string) => void;
  transcriptionSupported: boolean;
  speechError: string | null;
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
  voices: SpeechSynthesisVoice[];
  selectedVoice: string;
  onSelectVoice: (voice: string) => void;
  voiceRate: number;
  onVoiceRateChange: (rate: number) => void;
  onInterruptAudio: () => void;
  handsFree: boolean;
  onHandsFreeChange: (enabled: boolean) => void;
}

export function VoiceComposer(props: VoiceComposerProps) {
  const {
    value,
    onChange,
    attachments,
    onAttachmentsChange,
    onSend,
    isGenerating,
    onStopGeneration,
    isListening,
    onStartListening,
    onStopListening,
    partialTranscript,
    inputLevel,
    noiseState,
    permission,
    microphoneError,
    devices,
    selectedDeviceId,
    onSelectDevice,
    transcriptionSupported,
    speechError,
    muted,
    onMutedChange,
    voices,
    selectedVoice,
    onSelectVoice,
    voiceRate,
    onVoiceRateChange,
    onInterruptAudio,
    handsFree,
    onHandsFreeChange,
  } = props;
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [readingAttachments, setReadingAttachments] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || handsFree) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, button, select, [contenteditable='true']")) return;
      event.preventDefault();
      onInterruptAudio();
      void onStartListening();
    };
    const keyUp = (event: globalThis.KeyboardEvent) => {
      if (event.code !== "Space" || handsFree) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, button, select, [contenteditable='true']")) return;
      event.preventDefault();
      onStopListening(true);
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [handsFree, onInterruptAudio, onStartListening, onStopListening]);

  useEffect(() => {
    const focusComposer = () => textareaRef.current?.focus();
    window.addEventListener("mre:focus-composer", focusComposer);
    return () => window.removeEventListener("mre:focus-composer", focusComposer);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  const handleMicClick = () => {
    if (isListening) {
      if (handsFree) onHandsFreeChange(false);
      onStopListening(true);
    } else {
      onInterruptAudio();
      void onStartListening();
    }
  };

  const updateHandsFree = (enabled: boolean) => {
    onHandsFreeChange(enabled);
    if (!enabled && isListening) onStopListening(false);
    if (enabled && !isListening) {
      onInterruptAudio();
      void onStartListening();
    }
  };

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setReadingAttachments(true);
    setAttachmentError(null);
    try {
      onAttachmentsChange(await attachmentsFromFiles(files, attachments));
    } catch (error) {
      setAttachmentError(
        error instanceof AttachmentValidationError
          ? error.message
          : "MRE could not read that attachment. Choose a supported text file.",
      );
    } finally {
      setReadingAttachments(false);
    }
  };

  return (
    <section className="voice-command" aria-label="Message and voice controls">
      {microphoneError && (
        <div className="inline-notice inline-notice--warning" role="status">
          <AlertTriangle size={14} />
          <span>{microphoneError}</span>
        </div>
      )}

      {speechError && (
        <div className="inline-notice inline-notice--warning" role="status">
          <AlertTriangle size={14} />
          <span>{speechError}</span>
        </div>
      )}

      {attachmentError && (
        <div className="inline-notice inline-notice--warning" role="alert">
          <AlertTriangle size={14} />
          <span>{attachmentError}</span>
          <button type="button" onClick={() => setAttachmentError(null)}>Dismiss</button>
        </div>
      )}

      {(isListening || partialTranscript) && (
        <div className="live-caption" aria-live="polite">
          <div className="live-caption__meta">
            <span className="privacy-indicator"><span /> Microphone active</span>
            <span>{noiseState === "clear" ? "Voice clear" : noiseState === "noisy" ? "Background noise" : "Waiting for speech"}</span>
          </div>
          <p>{partialTranscript || "Listening…"}</p>
          <div className="input-wave" aria-hidden="true">
            {Array.from({ length: 34 }, (_, index) => (
              <span
                key={index}
                style={{ height: `${Math.max(12, inputLevel * 82 * (0.58 + (index % 5) * 0.12))}%` }}
              />
            ))}
          </div>
        </div>
      )}

      {!!attachments.length && (
        <div className="attachment-list">
          {attachments.map((file) => (
            <span key={`${file.name}-${file.size}`}>
              <Paperclip size={12} /> {file.name} · {formatFileSize(file.size)}
              <button type="button" onClick={() => onAttachmentsChange(attachments.filter((item) => item !== file))} aria-label={`Remove ${file.name}`}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={cn("composer", isListening && "composer--listening")}>
        <button className="composer__utility" type="button" onClick={() => fileInputRef.current?.click()} aria-label="Attach a text file" disabled={readingAttachments}>
          <Paperclip size={18} />
        </button>
        <input ref={fileInputRef} type="file" multiple hidden accept={CHAT_ATTACHMENT_ACCEPT} onChange={(event) => void addFiles(event)} />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask MRE to coordinate, remember, research, or prepare…"
          aria-label="Message MRE"
          rows={1}
          maxLength={12000}
        />
        {isGenerating ? (
          <button className="composer__send composer__send--stop" type="button" onClick={onStopGeneration} aria-label="Stop generation">
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button className="composer__send" type="button" onClick={onSend} disabled={!value.trim() && !attachments.length} aria-label="Send message">
            <ArrowUp size={18} />
          </button>
        )}
      </div>

      <div className="voice-toolbar">
        <button
          className={cn("mic-button", isListening && "mic-button--active")}
          type="button"
          onClick={handleMicClick}
          aria-label={isListening ? "Stop listening" : "Start listening"}
          aria-pressed={isListening}
          disabled={permission === "unsupported"}
        >
          <span className="mic-button__rings" aria-hidden="true" />
          {permission === "denied" ? <MicOff size={23} /> : <Mic size={23} />}
        </button>
        <div className="voice-toolbar__mode">
          <strong>{handsFree ? "Hands-free" : isListening ? "Click to stop" : "Click to talk"}</strong>
          <span>{handsFree ? "Click microphone to stop" : "Or hold Space from anywhere"}</span>
        </div>
        <label className="switch-control">
          <input type="checkbox" checked={handsFree} onChange={(event) => updateHandsFree(event.target.checked)} />
          <span aria-hidden="true" />
          <em>Hands-free</em>
        </label>
        <div className="voice-toolbar__actions">
          <button className={cn("icon-button", muted && "is-active")} type="button" onClick={() => onMutedChange(!muted)} aria-label={muted ? "Enable spoken responses" : "Mute spoken responses"} aria-pressed={muted}>
            {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
          </button>
          <button className={cn("icon-button", showVoiceSettings && "is-active")} type="button" onClick={() => setShowVoiceSettings((current) => !current)} aria-label="Voice settings" aria-expanded={showVoiceSettings}>
            <Settings2 size={17} />
          </button>
        </div>
      </div>

      {showVoiceSettings && (
        <div className="voice-settings">
          <div>
            <label htmlFor="input-device"><Mic size={14} /> Input device</label>
            <div className="select-wrap">
              <select id="input-device" value={selectedDeviceId} onChange={(event) => onSelectDevice(event.target.value)}>
                {!devices.length && <option value="">Default microphone</option>}
                {devices.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
          </div>
          <div>
            <label htmlFor="output-voice"><Headphones size={14} /> MRE voice</label>
            <div className="select-wrap">
              <select id="output-voice" value={selectedVoice} onChange={(event) => onSelectVoice(event.target.value)}>
                {!voices.length && <option value="">System voice</option>}
                {voices.map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
          </div>
          <div>
            <label htmlFor="voice-speed"><AudioLines size={14} /> Voice speed · {voiceRate.toFixed(1)}×</label>
            <input id="voice-speed" type="range" min="0.7" max="1.4" step="0.1" value={voiceRate} onChange={(event) => onVoiceRateChange(Number(event.target.value))} />
          </div>
          <div className="voice-support">
            {transcriptionSupported ? <Radio size={14} /> : <Keyboard size={14} />}
            <span>{transcriptionSupported ? "Live captions supported" : "Text-only transcription fallback"}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function formatFileSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  return `${Math.ceil(size / 1_024)} KB`;
}
