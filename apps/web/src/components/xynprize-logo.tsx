"use client";

import { useState } from "react";

import { cn } from "@/components/ui/cn";

const logoCandidates = [
  "/xynprize-logo.svg",
  "/xynprize-logo.png",
  "/xynprize-logo.webp",
];

export function XynPrizeLogo({ compact = false, className }: { compact?: boolean; className?: string }) {
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [showFallback, setShowFallback] = useState(false);

  return (
    <div className={cn("brand-lockup", compact && "brand-lockup--compact", className)}>
      <span className="brand-mark" aria-hidden="true">
        {!showFallback ? (
          // A native image allows customers to drop in any supported logo without a rebuild.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt=""
            src={logoCandidates[candidateIndex]}
            onError={() => {
              if (candidateIndex < logoCandidates.length - 1) {
                setCandidateIndex((current) => current + 1);
              } else {
                setShowFallback(true);
              }
            }}
          />
        ) : (
          <svg viewBox="0 0 48 48" role="presentation">
            <defs>
              <linearGradient id="xynprize-mark-gradient" x1="8" y1="5" x2="40" y2="43">
                <stop stopColor="#22d3ee" />
                <stop offset="0.55" stopColor="#2563eb" />
                <stop offset="1" stopColor="#a855f7" />
              </linearGradient>
            </defs>
            <path
              d="M10 8.5 23.8 22 38 8.5l2.3 5.7L28.6 25.5l11.7 8.3-3.5 5.7-13-10-12.7 10-3.4-5.7 11.5-8.3L7.7 14.2 10 8.5Z"
              fill="url(#xynprize-mark-gradient)"
            />
            <circle cx="24" cy="24" r="21" fill="none" stroke="#22d3ee" strokeOpacity=".28" />
          </svg>
        )}
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>XynPrize</strong>
          <small>Command Intelligence</small>
        </span>
      )}
      <span className="sr-only">XynPrize Ltd.</span>
    </div>
  );
}
