/**
 * Request log middleware — emits one line per request to stderr.
 * Format: "[api] METHOD path -> status (durationMs) user=<sub|apikey|-> ip=<client>"
 * Never logs the bearer token or the API key itself.
 *
 * Stderr (not stdout) so the format never collides with structured handler output.
 */

import type { MiddlewareHandler } from "hono";
import { clientIp, principalOf, trustProxyFromEnv } from "./rate-limit.js";

export const logMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const user = principalOf(c) ?? "-";
  const ip = clientIp(c, trustProxyFromEnv());
  process.stderr.write(
    `[api] ${c.req.method} ${c.req.path} -> ${c.res.status} (${duration}ms) user=${user} ip=${ip}\n`,
  );
};
