import "server-only";

import type { ServerEnv } from "@/lib/env";
import { getEnv } from "@/lib/env";

import { ProviderError } from "./errors";
import { HermesLanguageModelProvider } from "./hermes";
import { MrieLanguageModelProvider } from "./mrie";
import { OpenAICompatibleLanguageModelProvider } from "./openai-compatible";
import type { LanguageModelProvider } from "./types";

export function createLanguageModelProvider(env: ServerEnv = getEnv()): LanguageModelProvider {
  const nvidiaApiKey = env.NVIDIA_NIM_API_KEY;
  switch (env.LLM_PROVIDER) {
    case "mrie":
      return new MrieLanguageModelProvider(env.MRIE_RPC_HOST, env.MRIE_RPC_PORT);
    case "hermes":
      if (!env.HERMES_GATEWAY_TOKEN) {
        throw new ProviderError("The Hermes provider is missing its server-side gateway token", {
          code: "CONFIGURATION",
          provider: "hermes",
        });
      }
      return new HermesLanguageModelProvider({
        gatewayUrl: env.HERMES_GATEWAY_URL,
        token: env.HERMES_GATEWAY_TOKEN,
        profile: env.HERMES_GATEWAY_PROFILE,
        cwd: env.HERMES_GATEWAY_CWD,
        approvalPolicy: env.HERMES_APPROVAL_POLICY,
        connectTimeoutMs: env.HERMES_CONNECT_TIMEOUT_MS,
        requestTimeoutMs: env.HERMES_REQUEST_TIMEOUT_MS,
      });
    case "openai-compatible":
      if (!env.LLM_BASE_URL || !(env.LLM_API_KEY ?? nvidiaApiKey) || !env.LLM_MODEL) {
        throw new ProviderError("The OpenAI-compatible provider is not fully configured", {
          code: "CONFIGURATION",
          provider: "openai-compatible",
        });
      }
      return new OpenAICompatibleLanguageModelProvider(
        env.LLM_BASE_URL,
        env.LLM_API_KEY ?? nvidiaApiKey!,
        env.LLM_MODEL,
      );
  }
}
