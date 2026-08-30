export type ProviderErrorCode =
  | "ABORTED"
  | "BAD_RESPONSE"
  | "CONFIGURATION"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      code: ProviderErrorCode;
      provider: string;
      retryable?: boolean;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.code = options.code;
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export function throwIfAborted(signal: AbortSignal | undefined, provider: string): void {
  if (signal?.aborted) {
    throw new ProviderError("The provider request was interrupted", {
      code: "ABORTED",
      provider,
      cause: signal.reason,
    });
  }
}

export async function boundedErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1_000);
  } catch {
    return "No response details were provided";
  }
}

export function errorForHttpStatus(provider: string, status: number, detail: string): ProviderError {
  if (status === 429) {
    return new ProviderError(`${provider} rate limit reached`, {
      code: "RATE_LIMITED",
      provider,
      retryable: true,
      status,
    });
  }
  return new ProviderError(`${provider} request failed (${status}): ${detail}`, {
    code: status >= 500 ? "UNAVAILABLE" : "BAD_RESPONSE",
    provider,
    retryable: status >= 500,
    status,
  });
}
