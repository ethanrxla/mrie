"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Activity, BrainCircuit, DatabaseZap, RadioTower } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";

import type { MrieState } from "@/components/command/types";
import { cn } from "@/components/ui/cn";

const stateLabels: Record<MrieState, string> = {
  idle: "MRE is ready",
  listening: "MRE is listening",
  processing: "MRE is processing",
  speaking: "MRE is speaking",
  success: "Request completed",
  error: "MRE needs attention",
  offline: "MRE is offline",
};

const orbitNodes = [
  { label: "Memory", icon: DatabaseZap, angle: 18 },
  { label: "Reasoning", icon: BrainCircuit, angle: 112 },
  { label: "Signals", icon: RadioTower, angle: 206 },
  { label: "Agents", icon: Activity, angle: 296 },
];

export function AiCore({ state, audioLevel = 0 }: { state: MrieState; audioLevel?: number }) {
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(true);
  const waveform = useMemo(
    () =>
      Array.from({ length: 36 }, (_, index) => {
        const harmonic = Math.sin(index * 0.73) * 0.24 + Math.cos(index * 0.38) * 0.18;
        return Math.max(0.16, Math.min(1, 0.32 + harmonic + audioLevel * (0.55 + (index % 4) * 0.08)));
      }),
    [audioLevel],
  );

  useEffect(() => {
    const updateVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  return (
    <div className="core-stage">
      <div
        className={cn("ai-core", `ai-core--${state}`, (!visible || reducedMotion) && "ai-core--paused")}
        style={{ "--audio-level": audioLevel } as CSSProperties}
        role="img"
        aria-label={stateLabels[state]}
      >
        <div className="ai-core__ambient" aria-hidden="true" />
        <div className="ai-core__scan" aria-hidden="true" />
        <svg className="ai-core__geometry" viewBox="0 0 420 420" aria-hidden="true">
          <defs>
            <linearGradient id="core-spectrum" x1="52" y1="34" x2="366" y2="382">
              <stop stopColor="#22d3ee" />
              <stop offset="0.5" stopColor="#2563eb" />
              <stop offset="1" stopColor="#a855f7" />
            </linearGradient>
            <radialGradient id="core-light">
              <stop offset="0" stopColor="#f8fafc" stopOpacity=".98" />
              <stop offset=".16" stopColor="#67e8f9" stopOpacity=".82" />
              <stop offset=".48" stopColor="#2563eb" stopOpacity=".28" />
              <stop offset="1" stopColor="#020617" stopOpacity="0" />
            </radialGradient>
            <filter id="soft-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <circle className="core-ring core-ring--outer" cx="210" cy="210" r="182" />
          <circle className="core-ring core-ring--ticks" cx="210" cy="210" r="165" pathLength="100" />
          <circle className="core-ring core-ring--arc-one" cx="210" cy="210" r="142" pathLength="100" />
          <circle className="core-ring core-ring--arc-two" cx="210" cy="210" r="119" pathLength="100" />
          <circle className="core-ring core-ring--fine" cx="210" cy="210" r="92" />
          <path className="core-bracket" d="M87 137V96h42M333 137V96h-42M87 283v41h42M333 283v41h-42" />
          <g className="core-triad">
            <path d="M210 112 294 257H126Z" />
            <path d="m210 135 64 111H146Z" />
          </g>
          <circle className="core-light" cx="210" cy="210" r="88" fill="url(#core-light)" />
          <circle className="core-spark" cx="210" cy="210" r="8" filter="url(#soft-glow)" />
          <g className="core-particles">
            {Array.from({ length: 22 }, (_, index) => {
              const angle = (index / 22) * Math.PI * 2;
              const radius = 48 + (index % 4) * 19;
              return (
                <circle
                  key={index}
                  cx={210 + Math.cos(angle) * radius}
                  cy={210 + Math.sin(angle) * radius}
                  r={index % 3 === 0 ? 1.8 : 1.1}
                />
              );
            })}
          </g>
        </svg>

        <div className="ai-core__identity" aria-hidden="true">
          <span className="ai-core__glyph">X</span>
          <span className="ai-core__name">MRE</span>
          <span className="ai-core__mode">{state.toUpperCase()}</span>
        </div>

        {orbitNodes.map(({ label, icon: Icon, angle }) => (
          <motion.div
            key={label}
            className="core-node"
            style={{ "--node-angle": `${angle}deg` } as CSSProperties}
            animate={reducedMotion ? undefined : { opacity: [0.55, 1, 0.55] }}
            transition={{ repeat: Infinity, duration: 3.4, delay: angle / 300 }}
            title={label}
            aria-hidden="true"
          >
            <Icon size={13} />
          </motion.div>
        ))}

        <div className="core-wave" aria-hidden="true">
          {waveform.map((height, index) => (
            <span key={index} style={{ height: `${height * 100}%`, opacity: 0.48 + height * 0.52 }} />
          ))}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {stateLabels[state]}
      </p>
    </div>
  );
}
