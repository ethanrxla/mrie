import { describe, expect, it, vi } from "vitest";

import { scrollTranscriptIntoView } from "@/components/command/transcript-scroll";

describe("scrollTranscriptIntoView", () => {
  it("does not return Chromium's Promise as a React effect cleanup", () => {
    const scrollIntoView = vi.fn(() => Promise.resolve());

    expect(scrollTranscriptIntoView({ scrollIntoView })).toBeUndefined();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
  });
});
