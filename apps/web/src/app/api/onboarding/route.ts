import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError, noStoreJson } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
  displayName: z.string().trim().min(2).max(100),
  preferredName: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(80),
  memoryEnabled: z.boolean(),
  conversationMode: z.enum(["push", "continuous"]),
  spokenResponses: z.boolean(),
  voiceSpeed: z.number().min(0.7).max(1.4),
  browserVoice: z.string().max(300),
  integrations: z.array(z.string().trim().min(1).max(80)).max(24),
});

/**
 * Persist first-run choices as one idempotent operation. The completion marker is
 * deliberately written last so a partial provider/database failure sends the
 * operator back through setup instead of admitting them with incomplete policy.
 */
export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const input = schema.parse(await request.json());
    const store = await getStore();
    const preferences = [
      { key: "memory.autoSave", value: input.memoryEnabled },
      { key: "voice.handsFree", value: input.conversationMode === "continuous" },
      { key: "voice.spokenResponses", value: input.spokenResponses },
      { key: "voice.speed", value: input.voiceSpeed },
      { key: "voice.browserVoice", value: input.browserVoice },
      { key: "integrations.selected", value: input.integrations },
    ];

    const completion = await store.completeOnboarding(user.id, {
      profile: {
        displayName: input.displayName,
        preferredName: input.preferredName,
        timezone: input.timezone,
      },
      preferences,
    });

    return noStoreJson({
      user: completion.user,
      preferences: completion.preferences,
      onboardingComplete: true,
    });
  } catch (error) {
    return jsonError(error);
  }
}
