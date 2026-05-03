/**
 * Request log middleware — emits one line per request to stderr.
 * Format: "[api] METHOD path -> status (durationMs)"
 *
 * Stderr (not stdout) so the format never collides with structured handler output.
 */

import type { MiddlewareHandler } from "hono";

export const logMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  process.stderr.write(
    `[api] ${c.req.method} ${c.req.path} -> ${c.res.status} (${duration}ms)\n`,
  );
};
