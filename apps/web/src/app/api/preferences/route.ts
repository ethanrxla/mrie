import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError, noStoreJson } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
  key: z
    .enum([
      "memory.autoSave",
      "voice.spokenResponses",
      "voice.handsFree",
      "voice.speed",
      "voice.browserVoice",
      "sound.effects",
      "sound.volume",
      "accessibility.highContrast",
      "accessibility.reducedMotion",
      "response.style",
      "integrations.selected",
    ]),
  value: z.unknown(),
});

export async function GET() {
  try {
    const user = await requireUser();
    const preferences = await (await getStore()).listPreferences(user.id);
    return noStoreJson({
      preferences: Object.fromEntries(preferences.map((preference) => [preference.key, preference.value])),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    const input = schema.parse(await request.json());
    const preference = await (await getStore()).upsertPreference(user.id, input.key, input.value);
    return noStoreJson({ preference });
  } catch (error) {
    return jsonError(error);
  }
}
