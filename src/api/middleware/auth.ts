/**
 * Auth middleware — checks X-Api-Key header against configured value.
 *
 * Internal-only API. No JWT, no per-user identity. The single key is set via
 * the API_KEY env var at server startup (server fails to boot if missing).
 *
 * Constant-time string comparison via crypto.timingSafeEqual prevents timing
 * attacks on the key.
 */

import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";

export function makeAuthMiddleware(expectedKey: string): MiddlewareHandler {
  if (!expectedKey || expectedKey.trim().length === 0) {
    throw new Error(
      "makeAuthMiddleware: expectedKey is empty. API_KEY env var must be set.",
    );
  }
  const expectedBuf = Buffer.from(expectedKey);

  return async (c, next) => {
    const provided = c.req.header("x-api-key") ?? "";
    if (provided.length === 0) {
      return c.json(
        { error: "Missing X-Api-Key header", code: "auth.missing" },
        401,
      );
    }
    const providedBuf = Buffer.from(provided);
    // timingSafeEqual requires equal lengths
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return c.json({ error: "Invalid X-Api-Key", code: "auth.invalid" }, 401);
    }
    await next();
  };
}
