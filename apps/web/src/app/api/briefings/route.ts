import { z } from "zod";

import { assertSameOrigin, requireUser } from "@/lib/auth/session";
import { parseBriefingList, parseBriefingRun } from "@/lib/briefings";
import { getEnv } from "@/lib/env";
import { ApiError, jsonError, noStoreJson } from "@/lib/http";
import { ProviderError } from "@/lib/providers/errors";
import { MrieRpcClient } from "@/lib/providers/mrie-rpc";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const listSchema = z.coerce.number().int().min(1).max(100).default(20);
const runSchema = z.object({ dryRun: z.boolean().default(false) });

function client(): MrieRpcClient {
  const env = getEnv();
  return new MrieRpcClient(env.MRIE_RPC_HOST, env.MRIE_RPC_PORT);
}

async function runtimeRequest<T>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  try {
    return await client().request<T>(
      method,
      params,
      AbortSignal.timeout(timeoutMs),
      timeoutMs,
    );
  } catch (error) {
    if (
      error instanceof ProviderError &&
      (error.code === "TIMEOUT" || error.code === "ABORTED")
    ) {
      throw new ApiError(
        504,
        "MRE did not acknowledge the briefing before the response window closed. The run may still be active; refresh briefing status before retrying.",
        "mrie_timeout",
      );
    }
    throw new ApiError(
      503,
      "The MRE briefing runtime is unavailable. Ensure `python -m mrie serve` is running.",
      "mrie_unavailable",
    );
  }
}

export async function GET(request: Request) {
  try {
    await requireUser();
    const limit = listSchema.parse(new URL(request.url).searchParams.get("limit") ?? undefined);
    const result = await runtimeRequest<unknown>("briefings.list", { limit }, 5_000);
    return noStoreJson(parseBriefingList(result));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    const user = await requireUser();
    enforceRateLimit(`briefing-run:${user.id}`, { limit: 3, windowMs: 60_000 });
    const input = runSchema.parse(await request.json());
    const result = await runtimeRequest<unknown>(
      "briefings.run",
      { dry_run: input.dryRun },
      180_000,
    );
    const parsed = parseBriefingRun(result);
    if (parsed.busy) {
      return noStoreJson(
        {
          error: {
            code: "briefing_in_progress",
            message: "A briefing is already in progress. Wait for it to complete before starting another.",
          },
          scheduler: parsed.scheduler,
        },
        { status: 409 },
      );
    }
    return noStoreJson(parsed);
  } catch (error) {
    return jsonError(error);
  }
}
