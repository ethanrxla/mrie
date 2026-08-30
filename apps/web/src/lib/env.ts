import { loadEnvConfig } from "@next/env";
import path from "node:path";

import { z } from "zod";

const workingDirectory = process.cwd();
if (
  path.basename(workingDirectory).toLowerCase() === "web" &&
  path.basename(path.dirname(workingDirectory)).toLowerCase() === "apps"
) {
  loadEnvConfig(path.resolve(workingDirectory, "../.."), process.env.NODE_ENV !== "production");
}

const booleanString = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: z.string().min(1).optional(),
    AUTH_SECRET: z.string().min(32).optional(),
    ALLOW_REGISTRATION: booleanString,
    LOCAL_MODE: booleanString,
    LOCAL_USER_EMAIL: z.string().email().default("operator@mre.local"),
    LOCAL_STORE_PATH: z.string().trim().min(1).optional(),
    LLM_PROVIDER: z.enum(["openai-compatible", "mrie", "hermes"]).default("mrie"),
    LLM_BASE_URL: z.string().url().optional(),
    LLM_API_KEY: z.string().min(1).optional(),
    NVIDIA_NIM_API_KEY: z.string().min(1).optional(),
    LLM_MODEL: z.string().min(1).optional(),
    MRIE_RPC_HOST: z.string().default("127.0.0.1"),
    MRIE_RPC_PORT: z.coerce.number().int().min(1).max(65_535).default(17_351),
    HERMES_GATEWAY_URL: z.string().url().default("ws://127.0.0.1:9119/api/ws"),
    HERMES_GATEWAY_TOKEN: z.string().min(16).optional(),
    HERMES_GATEWAY_PROFILE: z.string().trim().min(1).optional(),
    HERMES_GATEWAY_CWD: z.string().trim().min(1).optional(),
    HERMES_APPROVAL_POLICY: z.enum(["manual-required", "respect-hermes"]).default("manual-required"),
    HERMES_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(8_000),
    HERMES_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(120_000),
    STT_PROVIDER: z.enum(["browser", "elevenlabs"]).default("browser"),
    TTS_PROVIDER: z.enum(["browser", "elevenlabs"]).default("browser"),
    ELEVENLABS_API_KEY: z.string().min(1).optional(),
    ELEVENLABS_VOICE_ID: z.string().min(1).optional(),
    ELEVENLABS_TTS_MODEL: z.string().default("eleven_flash_v2_5"),
    ELEVENLABS_STT_MODEL: z.string().default("scribe_v2"),
    EMBEDDING_BASE_URL: z.string().url().optional(),
    EMBEDDING_API_KEY: z.string().min(1).optional(),
    EMBEDDING_MODEL: z.string().min(1).optional(),
    OBJECT_STORAGE_URL: z.string().url().optional(),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.AUTH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_SECRET"],
        message: "AUTH_SECRET must contain at least 32 characters in production",
      });
    }
    if (env.NODE_ENV === "production" && !env.LOCAL_MODE && !env.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required unless LOCAL_MODE=true",
      });
    }
    if (env.LLM_PROVIDER === "openai-compatible") {
      for (const key of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const) {
        if (!env[key] && !(key === "LLM_API_KEY" && env.NVIDIA_NIM_API_KEY)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required for the openai-compatible provider`,
          });
        }
      }
    }
    if (env.LLM_PROVIDER === "hermes" && !env.HERMES_GATEWAY_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["HERMES_GATEWAY_TOKEN"],
        message: "HERMES_GATEWAY_TOKEN is required for the Hermes provider",
      });
    }
    if ((env.STT_PROVIDER === "elevenlabs" || env.TTS_PROVIDER === "elevenlabs") && !env.ELEVENLABS_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ELEVENLABS_API_KEY"],
        message: "ELEVENLABS_API_KEY is required for ElevenLabs speech providers",
      });
    }
    if (env.TTS_PROVIDER === "elevenlabs" && !env.ELEVENLABS_VOICE_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ELEVENLABS_VOICE_ID"],
        message: "Choose an original ElevenLabs voice and set ELEVENLABS_VOICE_ID",
      });
    }
  });

export type ServerEnv = z.infer<typeof envSchema>;

let cachedEnv: ServerEnv | undefined;

export function getEnv(): ServerEnv {
  if (cachedEnv) return cachedEnv;
  const values = { ...process.env };
  const parsed = envSchema.safeParse(values);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid MRE server configuration: ${details}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

export function isLocalMode(env = getEnv()): boolean {
  return env.LOCAL_MODE || !env.DATABASE_URL;
}

export function resetEnvForTests(): void {
  cachedEnv = undefined;
}
