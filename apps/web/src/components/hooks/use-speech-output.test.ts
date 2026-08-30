import { describe, expect, it } from "vitest";

import { prepareSpeechText } from "@/components/hooks/use-speech-output";

describe("prepareSpeechText", () => {
  it("turns formatted assistant output into clear spoken text", () => {
    expect(
      prepareSpeechText(
        "## Result\n- **MRE** is [ready](https://example.test).\n```ts\nconst secret = true;\n```",
      ),
    ).toBe("Result MRE is ready. Code block omitted from spoken response.");
  });
});
