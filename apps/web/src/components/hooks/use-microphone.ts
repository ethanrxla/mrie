"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorLike extends Event {
  error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

export type MicrophonePermission = "prompt" | "granted" | "denied" | "unsupported";
export type NoiseState = "quiet" | "clear" | "noisy";

interface UseMicrophoneOptions {
  onFinalTranscript: (transcript: string) => void;
  onStart?: () => void;
  onStop?: () => void;
  onNoSpeech?: () => void;
  autoStopOnSilence?: boolean;
}

const subscribeToStaticBrowserCapability = () => () => undefined;
const getServerCapability = () => false;
const getCaptureCapability = () =>
  typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
const getRecognitionCapability = () => {
  if (typeof window === "undefined") return false;
  const speechWindow = window as SpeechWindow;
  return Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition);
};

export function useMicrophone({
  onFinalTranscript,
  onStart,
  onStop,
  onNoSpeech,
  autoStopOnSilence = false,
}: UseMicrophoneOptions) {
  const [isListening, setIsListening] = useState(false);
  const [permission, setPermission] = useState<MicrophonePermission>("prompt");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [inputLevel, setInputLevel] = useState(0);
  const [noiseState, setNoiseState] = useState<NoiseState>("quiet");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderIntentRef = useRef(new Map<MediaRecorder, boolean>());
  const finalTranscriptRef = useRef("");
  const activeRef = useRef(false);
  const startingRef = useRef(false);
  const startAttemptRef = useRef(0);
  const mountedRef = useRef(false);
  const submitOnStopRef = useRef(false);
  const detectedSpeechRef = useRef(false);
  const lastSpeechAtRef = useRef(0);
  const autoStopRef = useRef(autoStopOnSilence);
  const stopListeningRef = useRef<(submit?: boolean) => void>(() => undefined);
  const transcriptionAbortRef = useRef<AbortController | null>(null);

  const speechWindow = typeof window === "undefined" ? null : (window as SpeechWindow);
  // The server snapshot stays false for hydration, then React reads the browser
  // snapshot and enables voice without retaining the server's disabled button.
  const captureSupported = useSyncExternalStore(
    subscribeToStaticBrowserCapability,
    getCaptureCapability,
    getServerCapability,
  );
  const speechRecognitionSupported = useSyncExternalStore(
    subscribeToStaticBrowserCapability,
    getRecognitionCapability,
    getServerCapability,
  );

  useEffect(() => {
    autoStopRef.current = autoStopOnSilence;
  }, [autoStopOnSilence]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const available = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "audioinput",
      );
      if (!mountedRef.current) return;
      setDevices(available);
      setSelectedDeviceId((current) =>
        current && available.some((device) => device.deviceId === current)
          ? current
          : (available[0]?.deviceId ?? ""),
      );
    } catch {
      // Device enumeration is optional; capture can still use the browser default.
    }
  }, []);

  const releaseMedia = useCallback((resetMeter = true) => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context) void context.close().catch(() => undefined);
    if (resetMeter && mountedRef.current) {
      setInputLevel(0);
      setNoiseState("quiet");
    }
  }, []);

  const finishRecognition = useCallback(() => {
    if (!submitOnStopRef.current) return;
    submitOnStopRef.current = false;
    const transcript = finalTranscriptRef.current.trim();
    if (transcript) onFinalTranscript(transcript);
    else onNoSpeech?.();
  }, [onFinalTranscript, onNoSpeech]);

  const transcribeRecording = useCallback(
    async (blob: Blob) => {
      if (!blob.size || !mountedRef.current) {
        onNoSpeech?.();
        return;
      }
      transcriptionAbortRef.current?.abort();
      const controller = new AbortController();
      transcriptionAbortRef.current = controller;
      setIsTranscribing(true);
      try {
        const form = new FormData();
        const extension = blob.type.includes("ogg")
          ? "ogg"
          : blob.type.includes("mp4")
            ? "m4a"
            : "webm";
        form.append("audio", blob, `mre-capture.${extension}`);
        form.append("language", navigator.language || "en-US");
        const response = await fetch("/api/speech/transcribe", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Transcription unavailable");
        const payload = (await response.json()) as { transcript?: { text?: string } | string };
        const transcript =
          typeof payload.transcript === "string" ? payload.transcript : payload.transcript?.text;
        if (!mountedRef.current || transcriptionAbortRef.current !== controller) return;
        if (transcript?.trim()) {
          const finalTranscript = transcript.trim();
          setPartialTranscript(finalTranscript);
          onFinalTranscript(finalTranscript);
        } else {
          setError("No speech was detected. Try again or continue in text mode.");
          onNoSpeech?.();
        }
      } catch {
        if (!controller.signal.aborted && mountedRef.current) {
          setError("Recorded audio could not be transcribed. Text mode remains available.");
          onNoSpeech?.();
        }
      } finally {
        if (transcriptionAbortRef.current === controller) {
          transcriptionAbortRef.current = null;
          if (mountedRef.current) setIsTranscribing(false);
        }
      }
    },
    [onFinalTranscript, onNoSpeech],
  );

  const stopListening = useCallback(
    (submit = true) => {
      const wasStarting = startingRef.current;
      const wasActive = activeRef.current;
      if (!wasStarting && !wasActive) return;

      if (wasStarting) {
        startingRef.current = false;
        startAttemptRef.current += 1;
      }
      activeRef.current = false;
      submitOnStopRef.current = submit;

      const recorder = recorderRef.current;
      const recognition = recognitionRef.current;
      if (submit) onStop?.();
      else onNoSpeech?.();

      if (recorder && recorder.state !== "inactive") {
        recorderIntentRef.current.set(recorder, submit);
        try {
          recorder.stop();
        } catch {
          recorderIntentRef.current.delete(recorder);
          recorderRef.current = null;
          if (submit) onNoSpeech?.();
        }
      }
      if (recognition) {
        const stopAttempt = startAttemptRef.current;
        try {
          recognition.stop();
        } catch {
          finishRecognition();
        }
        window.setTimeout(() => {
          if (startAttemptRef.current === stopAttempt) finishRecognition();
        }, 750);
      }
      if (!recognition && !recorder && submit) queueMicrotask(finishRecognition);

      releaseMedia();
      if (mountedRef.current) setIsListening(false);
    },
    [finishRecognition, onNoSpeech, onStop, releaseMedia],
  );

  useEffect(() => {
    stopListeningRef.current = stopListening;
  }, [stopListening]);

  const startMeter = useCallback((stream: MediaStream) => {
    if (!window.AudioContext) return;
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.76;
      context.createMediaStreamSource(stream).connect(analyser);
      audioContextRef.current = context;
      const samples = new Uint8Array(analyser.fftSize);

      const measure = () => {
        if (!activeRef.current) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.min(1, Math.sqrt(sum / samples.length) * 3.4);
        setInputLevel(rms);
        setNoiseState(rms < 0.04 ? "quiet" : rms < 0.42 ? "clear" : "noisy");
        const now = performance.now();
        if (rms > 0.075) {
          detectedSpeechRef.current = true;
          lastSpeechAtRef.current = now;
        } else if (
          autoStopRef.current &&
          detectedSpeechRef.current &&
          now - lastSpeechAtRef.current > 1_150
        ) {
          detectedSpeechRef.current = false;
          stopListeningRef.current(true);
          return;
        }
        animationFrameRef.current = requestAnimationFrame(measure);
      };
      measure();
    } catch {
      // Metering is decorative; recording and recognition remain functional.
    }
  }, []);

  const startListening = useCallback(async () => {
    if (
      activeRef.current ||
      startingRef.current ||
      transcriptionAbortRef.current ||
      !captureSupported
    ) {
      if (!captureSupported) {
        setPermission("unsupported");
        setError("This browser does not support microphone capture. Text mode remains available.");
      }
      return;
    }

    const attempt = ++startAttemptRef.current;
    startingRef.current = true;
    setError(null);
    setPartialTranscript("");
    finalTranscriptRef.current = "";
    detectedSpeechRef.current = false;
    lastSpeechAtRef.current = performance.now();
    submitOnStopRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!mountedRef.current || attempt !== startAttemptRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      startingRef.current = false;
      streamRef.current = stream;
      activeRef.current = true;
      setPermission("granted");
      setIsListening(true);
      startMeter(stream);
      void refreshDevices();
      onStart?.();

      const Recognition = speechWindow?.SpeechRecognition ?? speechWindow?.webkitSpeechRecognition;
      if (!Recognition) {
        if (typeof MediaRecorder !== "undefined") {
          const recorder = new MediaRecorder(stream);
          const chunks: Blob[] = [];
          recorder.ondataavailable = (event) => {
            if (event.data.size) chunks.push(event.data);
          };
          recorder.onstop = () => {
            const shouldSubmit = recorderIntentRef.current.get(recorder) === true;
            recorderIntentRef.current.delete(recorder);
            const blob = new Blob(chunks, {
              type: recorder.mimeType || "audio/webm",
            });
            if (recorderRef.current === recorder) recorderRef.current = null;
            if (shouldSubmit && startAttemptRef.current === attempt) void transcribeRecording(blob);
          };
          recorderRef.current = recorder;
          recorder.start(250);
        } else {
          setError(
            "Live transcription is unavailable in this browser. Use text input or a supported browser.",
          );
          stopListeningRef.current(false);
        }
        return;
      }

      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";
      recognition.onresult = (event) => {
        if (startAttemptRef.current !== attempt) return;
        let interim = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const text = event.results[index]?.[0]?.transcript ?? "";
          if (event.results[index]?.isFinal) {
            finalTranscriptRef.current = `${finalTranscriptRef.current} ${text}`.trim();
          } else {
            interim += text;
          }
        }
        setPartialTranscript(`${finalTranscriptRef.current} ${interim}`.trim());
      };
      recognition.onerror = (event) => {
        if (startAttemptRef.current !== attempt) return;
        if (event.error !== "aborted" && event.error !== "no-speech") {
          const reason = event.error ? event.error.replaceAll("-", " ") : "unknown error";
          setError(`Voice recognition unavailable: ${reason}.`);
        }
      };
      recognition.onend = () => {
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        if (startAttemptRef.current !== attempt) return;
        if (activeRef.current) stopListeningRef.current(true);
        else finishRecognition();
      };
      recognitionRef.current = recognition;
      recognition.start();
    } catch (caught) {
      if (attempt !== startAttemptRef.current || !mountedRef.current) return;
      startingRef.current = false;
      recognitionRef.current = null;
      const denied =
        caught instanceof DOMException &&
        (caught.name === "NotAllowedError" || caught.name === "SecurityError");
      if (caught instanceof DOMException && caught.name === "OverconstrainedError") {
        setSelectedDeviceId("");
      }
      setPermission(denied ? "denied" : "prompt");
      setError(
        denied
          ? "Microphone access was denied. Enable it in your browser settings or continue in text mode."
          : "MRE could not open the selected microphone.",
      );
      activeRef.current = false;
      setIsListening(false);
      releaseMedia();
    }
  }, [
    captureSupported,
    finishRecognition,
    onStart,
    refreshDevices,
    releaseMedia,
    selectedDeviceId,
    speechWindow,
    startMeter,
    transcribeRecording,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    const recorderIntents = recorderIntentRef.current;
    let permissionStatus: PermissionStatus | null = null;
    let applyPermission: (() => void) | null = null;
    if (captureSupported) {
      void navigator.permissions
        ?.query({ name: "microphone" as PermissionName })
        .then((status) => {
          if (!mountedRef.current) return;
          permissionStatus = status;
          applyPermission = () => {
            if (!mountedRef.current) return;
            setPermission(status.state === "granted" ? "granted" : status.state === "denied" ? "denied" : "prompt");
          };
          applyPermission();
          status.addEventListener("change", applyPermission);
        })
        .catch(() => undefined);
    }

    const mediaDevices = navigator.mediaDevices;
    const handleDeviceChange = () => void refreshDevices();
    mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);
    const refreshFrame = window.requestAnimationFrame(() => void refreshDevices());
    return () => {
      window.cancelAnimationFrame(refreshFrame);
      mountedRef.current = false;
      startAttemptRef.current += 1;
      startingRef.current = false;
      submitOnStopRef.current = false;
      transcriptionAbortRef.current?.abort();
      transcriptionAbortRef.current = null;
      if (permissionStatus && applyPermission) {
        permissionStatus.removeEventListener("change", applyPermission);
      }
      mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);

      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        try {
          recognition.abort();
        } catch {
          // Some engines throw after recognition has already ended.
        }
      }
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorderIntents.set(recorder, false);
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // Recorder already stopped.
          }
        }
      }
      recorderIntents.clear();
      releaseMedia(false);
    };
  }, [captureSupported, refreshDevices, releaseMedia]);

  return {
    captureSupported,
    speechRecognitionSupported,
    permission: captureSupported ? permission : "unsupported",
    isListening,
    partialTranscript,
    inputLevel,
    noiseState,
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    error,
    isTranscribing,
    clearError: () => setError(null),
    startListening,
    stopListening,
  };
}
