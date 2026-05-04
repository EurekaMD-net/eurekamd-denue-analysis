/**
 * Per-IP token-bucket rate limit. Used for /tiles only — point lookups
 * and summaries don't need throttling, but tile fetches scale linearly
 * with the visible map area, so a single panning user can fire 100+ in
 * a few seconds.
 *
 * Plan §"P1 — API additions" mandates 5 req/sec per IP for /tiles.
 * Anything above that returns 429 with a Retry-After hint.
 *
 * Design notes:
 *  - Sliding window, in-memory Map keyed by IP.
 *  - Periodic cleanup prevents unbounded growth (entries idle >5min are GC'd).
 *  - getIp is injectable for tests; production reads x-forwarded-for first
 *    (Caddy adds it) and falls back to the socket address.
 */

import type { MiddlewareHandler, Context } from "hono";

export interface RateLimitOptions {
  /** Window length in milliseconds. Default 1000ms (1 second). */
  windowMs?: number;
  /** Max requests per window per IP. Default 5. */
  max?: number;
  /** Override IP extraction. Used by tests. */
  getIp?: (c: Context) => string;
  /** Idle entries older than this are GC'd. Default 5 minutes. */
  cleanupAfterMs?: number;
  /** Hard cap on bucket count. When exceeded the oldest is evicted. */
  maxBuckets?: number;
  /** When false, x-forwarded-for is ignored (anti-spoof). Default reads TRUST_PROXY env. */
  trustProxy?: boolean;
}

const DEFAULT_OPTIONS: Required<
  Omit<RateLimitOptions, "getIp" | "trustProxy">
> = {
  windowMs: 1000,
  max: 5,
  cleanupAfterMs: 5 * 60 * 1000,
  maxBuckets: 10_000,
};

export function makeRateLimitMiddleware(
  options: RateLimitOptions = {},
): MiddlewareHandler {
  const { windowMs, max, cleanupAfterMs, maxBuckets } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const trustProxy =
    options.trustProxy ??
    (process.env["TRUST_PROXY"] === "1" ||
      process.env["TRUST_PROXY"] === "true");
  const getIp = options.getIp ?? makeDefaultGetIp(trustProxy);
  const buckets = new Map<string, number[]>();
  let lastCleanup = Date.now();

  return async (c, next) => {
    const now = Date.now();
    const ip = getIp(c);

    if (now - lastCleanup > cleanupAfterMs) {
      gcStale(buckets, now, cleanupAfterMs);
      lastCleanup = now;
    }
    // Hard cap: evict oldest bucket when over the cap. Keeps the Map bounded
    // even under sustained load from many distinct IPs (DDoS / scrape).
    if (buckets.size >= maxBuckets) {
      const firstKey = buckets.keys().next().value;
      if (firstKey !== undefined) buckets.delete(firstKey);
    }

    const recent = (buckets.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      const oldest = recent[0] ?? now;
      const retryMs = Math.max(0, windowMs - (now - oldest));
      c.header("Retry-After", String(Math.ceil(retryMs / 1000)));
      return c.json(
        {
          error: `Rate limit exceeded: max ${max} requests per ${windowMs}ms`,
          code: "rate_limit",
        },
        429,
      );
    }
    recent.push(now);
    buckets.set(ip, recent);
    await next();
    return undefined;
  };
}

function makeDefaultGetIp(trustProxy: boolean): (c: Context) => string {
  return (c: Context): string => {
    if (trustProxy) {
      const xff = c.req.header("x-forwarded-for");
      if (xff) {
        // Caddy may forward a comma-separated list; first entry is the client.
        const first = xff.split(",")[0]?.trim();
        if (first) return first;
      }
      const realIp = c.req.header("x-real-ip");
      if (realIp) return realIp.trim();
    }
    // @hono/node-server exposes the raw incoming message under c.env.
    // Always preferred when trustProxy=false to prevent header spoofing.
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } };
    return env?.incoming?.socket?.remoteAddress ?? "unknown";
  };
}

function gcStale(
  buckets: Map<string, number[]>,
  now: number,
  thresholdMs: number,
): void {
  for (const [ip, times] of buckets) {
    if (times.length === 0) {
      buckets.delete(ip);
      continue;
    }
    const newest = times[times.length - 1] ?? 0;
    if (now - newest > thresholdMs) buckets.delete(ip);
  }
}
