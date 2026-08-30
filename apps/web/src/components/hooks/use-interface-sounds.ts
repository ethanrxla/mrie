"use client";

import { useCallback, useEffect, useRef } from "react";

export type InterfaceTone = "activate" | "listen" | "process" | "complete" | "warning";

const toneShape: Record<InterfaceTone, { from: number; to: number; duration: number }> = {
  activate: { from: 310, to: 440, duration: 0.09 },
  listen: { from: 520, to: 680, duration: 0.11 },
  process: { from: 260, to: 330, duration: 0.08 },
  complete: { from: 440, to: 740, duration: 0.15 },
  warning: { from: 330, to: 220, duration: 0.18 },
};

export function useInterfaceSounds() {
  const enabledRef = useRef(true);
  const volumeRef = useRef(0.7);
  const contextsRef = useRef(new Set<AudioContext>());

  useEffect(() => {
    const contexts = contextsRef.current;
    const apply = (preferences: Record<string, unknown>) => {
      if (typeof preferences["sound.effects"] === "boolean") {
        enabledRef.current = preferences["sound.effects"] as boolean;
      }
      if (typeof preferences["sound.volume"] === "number") {
        const volume = preferences["sound.volume"] as number;
        if (Number.isFinite(volume)) volumeRef.current = Math.max(0, Math.min(1, volume));
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
      for (const context of contexts) {
        void context.close().catch(() => undefined);
      }
      contexts.clear();
    };
  }, []);

  return useCallback(async (tone: InterfaceTone) => {
    if (!enabledRef.current || volumeRef.current <= 0) return;
    type WebkitAudioWindow = Window & { webkitAudioContext?: typeof AudioContext };
    const AudioContextClass = window.AudioContext ?? (window as WebkitAudioWindow).webkitAudioContext;
    if (!AudioContextClass) return;
    let context: AudioContext | null = null;
    try {
      context = new AudioContextClass();
      contextsRef.current.add(context);
      await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const shape = toneShape[tone];
      const now = context.currentTime;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(shape.from, now);
      oscillator.frequency.exponentialRampToValueAtTime(shape.to, now + shape.duration);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volumeRef.current * 0.055), now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + shape.duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.addEventListener(
        "ended",
        () => {
          if (!context) return;
          contextsRef.current.delete(context);
          void context.close().catch(() => undefined);
        },
        { once: true },
      );
      oscillator.start(now);
      oscillator.stop(now + shape.duration + 0.01);
    } catch {
      if (context) {
        contextsRef.current.delete(context);
        void context.close().catch(() => undefined);
      }
    }
  }, []);
}
