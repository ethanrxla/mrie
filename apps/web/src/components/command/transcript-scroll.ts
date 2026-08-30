export interface TranscriptScrollTarget {
  scrollIntoView(options?: ScrollIntoViewOptions): void | Promise<void>;
}

/** Scroll without leaking Chromium's Promise return value into a React effect. */
export function scrollTranscriptIntoView(target: TranscriptScrollTarget | null): void {
  target?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
