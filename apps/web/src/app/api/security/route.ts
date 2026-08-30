import { z } from "zod";

import { requireUser } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";
import { ApiError, jsonError, noStoreJson } from "@/lib/http";
import { MrieRpcClient } from "@/lib/providers/mrie-rpc";
import { enforceRateLimit } from "@/lib/rate-limit";
import { parseSecurityConsole } from "@/lib/security";

export const runtime = "nodejs";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(250),
  minimumSeverity: z.coerce.number().int().min(0).max(4).default(0),
});

function client(): MrieRpcClient {
  const env = getEnv();
  return new MrieRpcClient(env.MRIE_RPC_HOST, env.MRIE_RPC_PORT);
}

async function runtimeRequest<T>(
  rpcClient: MrieRpcClient,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  try {
    return await rpcClient.request<T>(method, params, AbortSignal.timeout(25_000), 25_000);
  } catch {
    throw new ApiError(
      503,
      "The MRE security runtime is unavailable. Ensure `python -m mrie serve` is running.",
      "mre_unavailable",
    );
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    enforceRateLimit(`security-read:${user.id}`, { limit: 30, windowMs: 60_000 });
    const url = new URL(request.url);
    const unknownKeys = [...url.searchParams.keys()].filter(
      (key) => key !== "limit" && key !== "minimumSeverity",
    );
    if (unknownKeys.length) {
      throw new ApiError(400, "The security query contains unsupported fields.", "invalid_request");
    }
    const input = querySchema.parse({
      limit: url.searchParams.get("limit") ?? undefined,
      minimumSeverity: url.searchParams.get("minimumSeverity") ?? undefined,
    });
    const rpcClient = client();
    const [events, status] = await Promise.all([
      runtimeRequest<unknown>(rpcClient, "security.events", {
        limit: input.limit,
        minimum_severity: input.minimumSeverity,
      }),
      runtimeRequest<unknown>(rpcClient, "security.status", {}),
    ]);
    try {
      return noStoreJson(parseSecurityConsole(events, status));
    } catch {
      throw new ApiError(
        502,
        "MRE returned an invalid security response.",
        "invalid_runtime_response",
      );
    }
  } catch (error) {
    return jsonError(error);
  }
}
