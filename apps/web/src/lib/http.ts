import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { logger } from "@/lib/logger";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "request_failed",
  ) {
    super(message);
  }
}

export function jsonError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_request",
          message: "The request contains invalid fields.",
          fields: error.flatten().fieldErrors,
        },
      },
      { status: 400 },
    );
  }
  logger.error("Unhandled API request failure", {
    errorType: error instanceof Error ? error.name : typeof error,
  });
  return NextResponse.json(
    { error: { code: "internal_error", message: "MRE could not complete this request." } },
    { status: 500 },
  );
}

export function noStoreJson(data: unknown, init: ResponseInit = {}): NextResponse {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
