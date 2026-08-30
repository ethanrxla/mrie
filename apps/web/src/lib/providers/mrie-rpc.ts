import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import { ProviderError, throwIfAborted } from "./errors";

interface JsonRpcResponse<T> {
  jsonrpc?: "2.0";
  id?: string;
  result?: T;
  error?: { code?: number; message?: string };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** A one-request-per-connection client for MRE's newline-delimited JSON-RPC socket. */
export class MrieRpcClient {
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  request<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    throwIfAborted(signal, "mrie");
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let settled = false;
      let buffer = "";
      const id = randomUUID();

      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        socket.removeAllListeners();
        socket.end();
        if (error) reject(error);
        else resolve(value as T);
      };
      const onAbort = () => {
        socket.destroy();
        finish(
          new ProviderError("The MRE request was interrupted", {
            code: "ABORTED",
            provider: "mrie",
            cause: signal?.reason,
          }),
        );
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
      socket.setEncoding("utf8");
      socket.setTimeout(timeoutMs);
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as JsonRpcResponse<T>;
          if (response.id !== id) {
            finish(
              new ProviderError("MRE returned a mismatched request identifier", {
                code: "BAD_RESPONSE",
                provider: "mrie",
              }),
            );
          } else if (response.error) {
            finish(
              new ProviderError(response.error.message ?? "MRE returned an error", {
                code: "BAD_RESPONSE",
                provider: "mrie",
              }),
            );
          } else if (response.result === undefined) {
            finish(
              new ProviderError("MRE returned no result", {
                code: "BAD_RESPONSE",
                provider: "mrie",
              }),
            );
          } else {
            finish(undefined, response.result);
          }
        } catch (error) {
          finish(
            new ProviderError("MRE returned malformed JSON", {
              code: "BAD_RESPONSE",
              provider: "mrie",
              cause: error,
            }),
          );
        }
      });
      socket.on("timeout", () => {
        socket.destroy();
        finish(
          new ProviderError("MRE did not respond before the timeout", {
            code: "TIMEOUT",
            provider: "mrie",
            retryable: true,
          }),
        );
      });
      socket.on("error", (error) => {
        finish(
          new ProviderError("MRE is unavailable", {
            code: "UNAVAILABLE",
            provider: "mrie",
            retryable: true,
            cause: error,
          }),
        );
      });
      socket.on("close", () => {
        if (!settled) {
          finish(
            new ProviderError("MRE closed the connection without a response", {
              code: "BAD_RESPONSE",
              provider: "mrie",
              retryable: true,
            }),
          );
        }
      });
    });
  }
}
