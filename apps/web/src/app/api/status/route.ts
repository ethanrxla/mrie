import { getCurrentUser } from "@/lib/auth/session";
import { getEnv, isLocalMode } from "@/lib/env";
import { noStoreJson } from "@/lib/http";
import { createLanguageModelProvider } from "@/lib/providers";

export const runtime = "nodejs";

export async function GET() {
  const env = getEnv();
  const user = await getCurrentUser();
  const provider = createLanguageModelProvider(env);
  const providerHealth = (env.LLM_PROVIDER === "hermes" || env.LLM_PROVIDER === "mrie")
    ? await provider.healthCheck?.(
        AbortSignal.timeout(
          env.LLM_PROVIDER === "hermes"
            ? Math.min(3_000, env.HERMES_CONNECT_TIMEOUT_MS)
            : 3_000,
        ),
      )
    : undefined;
  const intelligenceAvailable = providerHealth?.available !== false;
  return noStoreJson({
    status: intelligenceAvailable ? "operational" : "degraded",
    assistant: "MRE",
    authenticated: Boolean(user),
    localMode: isLocalMode(env),
    registrationAllowed: env.ALLOW_REGISTRATION,
    services: {
      database: isLocalMode(env) ? "local persistent store" : "postgresql",
      llm: env.LLM_PROVIDER,
      speechToText: env.STT_PROVIDER,
      textToSpeech: env.TTS_PROVIDER,
      mrie: env.LLM_PROVIDER === "mrie"
        ? providerHealth?.available ? "connected" : "unavailable"
        : "standby",
      hermes: env.LLM_PROVIDER === "hermes"
        ? providerHealth?.available ? "connected" : "unavailable"
        : "standby",
    },
    providerHealth,
    timestamp: new Date().toISOString(),
  });
}
