/**
 * Auth middleware — accepts EITHER a Supabase JWT Bearer token (browser
 * users) OR the shared X-Api-Key (machine clients, ops scripts).
 *
 * Decision order on every request:
 *   1. If Authorization: Bearer <jwt> present → verify against
 *      SUPABASE_JWT_SECRET. Pass on success; reject on signature/exp
 *      failure WITHOUT falling back to the key (a malformed JWT means
 *      the caller intended to use that path).
 *   2. Else if X-Api-Key present → constant-time compare against
 *      API_KEY env. Pass on match.
 *   3. Else reject 401.
 *
 * On a successful JWT path, c.set("user", {...}) is attached so
 * downstream handlers can identify the caller. The X-Api-Key path
 * leaves `user` unset — handlers that need identity must guard.
 */

import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { verifyBearer, type AuthedUser } from "./bearer-auth.js";

export interface AuthMiddlewareConfig {
  /** Shared API key (machine-client path). Required. */
  apiKey: string;
  /**
   * Supabase JWT secret (HS256). When absent, Bearer tokens are not
   * accepted — only X-Api-Key. Server still boots; browser users won't
   * be able to sign in until set.
   */
  supabaseJwtSecret?: string;
}

export function makeAuthMiddleware(
  configOrKey: AuthMiddlewareConfig | string,
): MiddlewareHandler {
  const config: AuthMiddlewareConfig =
    typeof configOrKey === "string" ? { apiKey: configOrKey } : configOrKey;

  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error(
      "makeAuthMiddleware: apiKey is empty. API_KEY env var must be set.",
    );
  }
  const expectedKeyBuf = Buffer.from(config.apiKey);

  return async (c, next) => {
    // ---- Path 1: Bearer JWT ----------------------------------------
    const authHeader = c.req.header("authorization") ?? null;
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      if (!config.supabaseJwtSecret) {
        // Name the missing key on stderr only; the client learns nothing
        // about server configuration (audit finding #10).
        process.stderr.write(
          "[auth] bearer rejected: SUPABASE_JWT_SECRET is not configured\n",
        );
        return c.json({ error: "Service unavailable" }, 503);
      }
      const result = verifyBearer(authHeader, {
        jwtSecret: config.supabaseJwtSecret,
      });
      if (!result.ok) {
        // Precise reason to stderr only: echoing it would be a verification
        // oracle (valid signature vs forged) — audit finding #10.
        process.stderr.write(`[auth] bearer rejected: ${result.reason}\n`);
        return c.json(
          { error: "Unauthorized", code: "auth.bearer_invalid" },
          401,
        );
      }
      c.set("user", result.user as AuthedUser);
      return next();
    }

    // ---- Path 2: X-Api-Key (machine clients) -----------------------
    const provided = c.req.header("x-api-key") ?? "";
    if (provided.length === 0) {
      return c.json(
        {
          error: "Missing Authorization Bearer or X-Api-Key header",
          code: "auth.missing",
        },
        401,
      );
    }
    const providedBuf = Buffer.from(provided);
    if (
      providedBuf.length !== expectedKeyBuf.length ||
      !timingSafeEqual(providedBuf, expectedKeyBuf)
    ) {
      return c.json({ error: "Invalid X-Api-Key", code: "auth.invalid" }, 401);
    }
    return next();
  };
}
