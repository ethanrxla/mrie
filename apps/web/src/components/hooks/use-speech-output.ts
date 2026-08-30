"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface BrowserSpeechDirective {
  kind?: string;
  text?: string;
  voice?: string;
  language?: string;
  rate?: number;
}

export function prepareSpeechText(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " Code block omitted from spoken response. ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]\s|\d+[.)]\s|>\s?)/gm, "")
    .replace(/[|*_~]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function useSpeechOutput() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoiceState] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [rate, setRateState] = useState(1);
  const [volume, setVolume] = useState(0.7);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pulseRef = useRef<number | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const playbackIdRef = useRef(0);

  const supported =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window;

  const stop = useCallback(() => {
    playbackIdRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;

    const utterance = utteranceRef.current;
    utteranceRef.current = null;
    if (utterance) {
      utterance.onstart = null;
      utterance.onboundary = null;
      utterance.onend = null;
      utterance.onerror = null;
    }
    if (supported) window.speechSynthesis.cancel();

    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.onplay = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
    }
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;

    if (meterFrameRef.current !== null) cancelAnimationFrame(meterFrameRef.current);
    meterFrameRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context) void context.close().catch(() => undefined);

    if (pulseRef.current !== null) window.clearInterval(pulseRef.current);
    pulseRef.current = null;
    setSpeaking(false);
    setLevel(0);
  }, [supported]);

  const speakBrowser = useCallback(
    (text: string, playbackId: number, directive: BrowserSpeechDirective = {}) => {
      if (muted || !text.trim() || playbackIdRef.current !== playbackId) return;
      if (!supported) {
        setError("Spoken playback is unavailable in this browser. The full response remains available as text.");
        return;
      }
      const utterance = new SpeechSynthesisUtterance(directive.text?.trim() || text);
      const requestedRate = Number.isFinite(directive.rate) ? directive.rate! : rate;
      utterance.rate = Math.max(0.5, Math.min(2, requestedRate));
      utterance.pitch = 0.96;
      utterance.volume = volume;
      if (directive.language) utterance.lang = directive.language;
      const requestedVoice = directive.voice || selectedVoice;
      const voice =
        voices.find((item) => item.voiceURI === requestedVoice) ??
        voices.find((item) => item.lang.toLowerCase().startsWith("en"));
      if (voice) utterance.voice = voice;
      utteranceRef.current = utterance;

      const isCurrent = () =>
        playbackIdRef.current === playbackId && utteranceRef.current === utterance;
      utterance.onstart = () => {
        if (!isCurrent()) return;
        setError(null);
        setSpeaking(true);
        if (pulseRef.current !== null) window.clearInterval(pulseRef.current);
        pulseRef.current = window.setInterval(() => {
          if (isCurrent()) setLevel(0.22 + Math.random() * 0.7);
        }, 92);
      };
      utterance.onboundary = () => {
        if (isCurrent()) setLevel(0.35 + Math.random() * 0.6);
      };
      const finish = () => {
        if (isCurrent()) stop();
      };
      utterance.onend = finish;
      utterance.onerror = (event) => {
        if (isCurrent() && event.error !== "canceled" && event.error !== "interrupted") {
          setError("Voice playback was blocked. Use Play response or allow audio for this site; captions remain available.");
        }
        finish();
      };
      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        setError("Voice playback was blocked. Use Play response or allow audio for this site; captions remain available.");
        finish();
      }
    },
    [muted, rate, selectedVoice, stop, supported, voices, volume],
  );

  const playServerAudio = useCallback(
    async (blob: Blob, playbackId: number, onPlaybackError: () => void) => {
      if (playbackIdRef.current !== playbackId) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = volume;
      audioRef.current = audio;
      audioUrlRef.current = url;
      let context: AudioContext | null = null;

      const isCurrent = () => playbackIdRef.current === playbackId && audioRef.current === audio;
      const cleanupLocal = () => {
        audio.onplay = null;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.src = "";
        if (audioRef.current === audio) audioRef.current = null;
        if (audioUrlRef.current === url) audioUrlRef.current = null;
        URL.revokeObjectURL(url);
        if (context && audioContextRef.current === context) audioContextRef.current = null;
        if (context) void context.close().catch(() => undefined);
      };

      try {
        if (window.AudioContext) {
          try {
            context = new AudioContext();
            await context.resume();
            if (!isCurrent()) {
              cleanupLocal();
              return;
            }
            const analyser = context.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.72;
            context.createMediaElementSource(audio).connect(analyser);
            analyser.connect(context.destination);
            audioContextRef.current = context;
            const samples = new Uint8Array(analyser.fftSize);
            const measure = () => {
              if (!isCurrent()) return;
              analyser.getByteTimeDomainData(samples);
              let sum = 0;
              for (const sample of samples) {
                const normalized = (sample - 128) / 128;
                sum += normalized * normalized;
              }
              setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
              meterFrameRef.current = requestAnimationFrame(measure);
            };
            audio.onplay = () => {
              if (!isCurrent()) return;
              setError(null);
              setSpeaking(true);
              measure();
            };
          } catch {
            if (context) void context.close().catch(() => undefined);
            context = null;
          }
        }

        audio.onplay ??= () => {
          if (isCurrent()) {
            setError(null);
            setSpeaking(true);
          }
        };
        audio.onended = () => {
          if (isCurrent()) stop();
        };
        audio.onerror = () => {
          if (!isCurrent()) return;
          cleanupLocal();
          setSpeaking(false);
          setLevel(0);
          onPlaybackError();
        };
        await audio.play();
      } catch (error) {
        cleanupLocal();
        throw error;
      }
    },
    [stop, volume],
  );

  const storePreference = useCallback((key: string, value: unknown) => {
    window.dispatchEvent(new CustomEvent("mre:preference", { detail: { key, value } }));
    void fetch("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    }).catch(() => undefined);
  }, []);

  const setMuted = useCallback(
    (value: boolean) => {
      setMutedState(value);
      if (value) stop();
      storePreference("voice.spokenResponses", !value);
    },
    [stop, storePreference],
  );

  const setRate = useCallback(
    (value: number) => {
      if (!Number.isFinite(value)) return;
      const normalized = Math.max(0.7, Math.min(1.4, value));
      setRateState(normalized);
      storePreference("voice.speed", normalized);
    },
    [storePreference],
  );

  const setSelectedVoice = useCallback(
    (value: string) => {
      setSelectedVoiceState(value);
      storePreference("voice.browserVoice", value);
    },
    [storePreference],
  );

  const speak = useCallback(
    async (text: string) => {
      const spokenText = prepareSpeechText(text);
      if (muted || !spokenText) return;
      stop();
      setError(null);
      const playbackId = playbackIdRef.current;
      const controller = new AbortController();
      requestRef.current = controller;
      let fallbackStarted = false;
      const fallbackToBrowser = () => {
        if (fallbackStarted || controller.signal.aborted || playbackIdRef.current !== playbackId) return;
        fallbackStarted = true;
        speakBrowser(spokenText, playbackId);
      };
      try {
        const response = await fetch("/api/speech/synthesize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: spokenText, speed: Math.min(1.2, Math.max(0.7, rate)) }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Speech provider unavailable");
        if (controller.signal.aborted || playbackIdRef.current !== playbackId) return;
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const result = (await response.json()) as BrowserSpeechDirective;
          if (result.kind === "browser-speech") speakBrowser(spokenText, playbackId, result);
          else throw new Error("Unsupported speech response");
        } else {
          const blob = await response.blob();
          if (controller.signal.aborted || playbackIdRef.current !== playbackId) return;
          await playServerAudio(blob, playbackId, fallbackToBrowser);
        }
      } catch {
        fallbackToBrowser();
      } finally {
        if (requestRef.current === controller) requestRef.current = null;
      }
    },
    [muted, playServerAudio, rate, speakBrowser, stop],
  );

  useEffect(() => {
    if (!supported) return;
    const loadVoices = () => {
      const available = window.speechSynthesis.getVoices();
      setVoices(available);
      setSelectedVoiceState(
        (current) =>
          current || available.find((voice) => voice.lang.toLowerCase().startsWith("en"))?.voiceURI || "",
      );
    };
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
      stop();
    };
  }, [stop, supported]);

  useEffect(() => {
    const apply = (preferences: Record<string, unknown>) => {
      if (typeof preferences["voice.spokenResponses"] === "boolean") {
        const shouldMute = preferences["voice.spokenResponses"] !== true;
        setMutedState(shouldMute);
        if (shouldMute) stop();
      }
      if (
        typeof preferences["voice.speed"] === "number" &&
        Number.isFinite(preferences["voice.speed"])
      ) {
        setRateState(Math.max(0.7, Math.min(1.4, preferences["voice.speed"] as number)));
      }
      if (typeof preferences["voice.browserVoice"] === "string") {
        setSelectedVoiceState(preferences["voice.browserVoice"] as string);
      }
      if (
        typeof preferences["sound.volume"] === "number" &&
        Number.isFinite(preferences["sound.volume"])
      ) {
        const nextVolume = Math.max(0, Math.min(1, preferences["sound.volume"] as number));
        setVolume(nextVolume);
        if (audioRef.current) audioRef.current.volume = nextVolume;
      }
    };
    const controller = new AbortController();
    void fetch("/api/preferences", { signal: controller.signal })
      .then(async (response) => {
        if (response.ok) {
          const payload = (await response.json()) as { preferences?: Record<string, unknown> };
          apply(payload.preferences ?? {});
        }
      })
      .catch(() => undefined);
    const handlePreference = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; value: unknown }>).detail;
      if (detail) apply({ [detail.key]: detail.value });
    };
    window.addEventListener("mre:preference", handlePreference);
    return () => {
      controller.abort();
      window.removeEventListener("mre:preference", handlePreference);
    };
  }, [stop]);

  return {
    supported,
    voices,
    selectedVoice,
    setSelectedVoice,
    speaking,
    muted,
    setMuted,
    rate,
    setRate,
    level,
    error,
    speak,
    stop,
  };
}
