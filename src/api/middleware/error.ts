/**
 * Error handling — exports HttpError + errorHandler (used via app.onError).
 *
 * Loud failure — never swallow or replace with a 200 with empty body.
 * Today's lesson: silent partial-success is worse than a clean 5xx.
 *
 * NOTE on instanceof: in some test/runtime environments (esp. with esbuild-cjs
 * interop), `err instanceof HttpError` can return false even when the error
 * IS an HttpError, because the class identity differs across module loads.
 * Belt-and-suspenders: also check name === "HttpError" + duck-typed status/code.
 */

import type { ErrorHandler } from "hono";
import type { ApiError } from "../types.js";

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function isHttpError(err: unknown): err is HttpError {
  if (err instanceof HttpError) return true;
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "HttpError" &&
    typeof (err as { status?: unknown }).status === "number" &&
    typeof (err as { code?: unknown }).code === "string"
  ) {
    return true;
  }
  return false;
}

export const errorHandler: ErrorHandler = (err, c) => {
  if (isHttpError(err)) {
    const payload: ApiError = {
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
    return c.json(payload, err.status as 400 | 401 | 404 | 500);
  }
  // Unknown error — log to stderr + return 500
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[api] uncaught error: ${msg}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  const payload: ApiError = {
    error: "Internal server error",
    code: "internal",
  };
  return c.json(payload, 500);
};
