/**
 * Sliding-window rate limit, keyed per IP, per principal, or both.
 * Registered in server.ts on:
 *  - /sage/query: 6/min per principal (each request fires 2 LLM calls).
 *  - /analytics/*: 120/min per principal+IP; 20/min on ageb-detail and
 *    agebs-by-municipio (psql per request on the shared cluster).
 *  - /tiles/*: 60/s per IP, sized for MapLibre's viewport burst (tile
 *    fetches scale with the visible map area).
 * Anything above a limit returns 429 with a Retry-After hint.
 * The shared X-Api-Key (Jarvis, the priority machine caller) is exempt on
 * /analytics/* and /tiles/* via `exempt: isPriorityRequest` (the request
 * context auth sets, request-context.ts); /sage/query still meters it (the
 * LLM budget guard against a leaked key).
 *
 * Design notes:
 *  - Sliding window, in-memory Map keyed by bucket (see keyBy).
 *  - Periodic cleanup prevents unbounded growth (entries idle >5min are GC'd).
 *  - getIp is injectable for tests. With TRUST_PROXY=1 production reads the
 *    RIGHTMOST x-forwarded-for entry (the hop Caddy appended); without it,
 *    the socket address (which is Caddy's loopback for every client).
 *  - keyBy picks the bucket: client IP, authenticated principal, or both.
 */

import type { MiddlewareHandler, Context } from "hono";
import { requestContext } from "../request-context.js";

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
  /**
   * Bucket key. "ip" (default) = client IP. "principal" = the authenticated
   * caller (JWT sub, or the shared X-Api-Key), falling back to the IP for
   * anonymous requests; register it AFTER the auth middleware. "principal+ip"
   * = both, so one account on two networks gets two buckets.
   */
  keyBy?: "ip" | "principal" | "principal+ip";
  /**
   * When true for a request, it is neither counted nor limited. Server
   * wiring passes isPriorityRequest, which reads the context auth sets, so
   * register the limiter AFTER the auth middleware.
   */
  exempt?: (c: Context) => boolean;
}

const DEFAULT_OPTIONS: Required<
  Omit<RateLimitOptions, "getIp" | "trustProxy" | "keyBy" | "exempt">
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
  const trustProxy = options.trustProxy ?? trustProxyFromEnv();
  const getIp = options.getIp ?? ((c: Context) => clientIp(c, trustProxy));
  const keyBy = options.keyBy ?? "ip";
  const buckets = new Map<string, number[]>();
  let lastCleanup = Date.now();

  return async (c, next) => {
    if (options.exempt?.(c)) {
      await next();
      return undefined;
    }
    const now = Date.now();
    const key = bucketKey(c, getIp(c), keyBy);

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

    const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
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
    buckets.set(key, recent);
    await next();
    return undefined;
  };
}

/** TRUST_PROXY=1|true: the API sits behind exactly one trusted proxy (Caddy). */
export function trustProxyFromEnv(): boolean {
  return (
    process.env["TRUST_PROXY"] === "1" || process.env["TRUST_PROXY"] === "true"
  );
}

/**
 * Resolved client IP. With trustProxy, the RIGHTMOST x-forwarded-for entry:
 * a proxy appends the peer it saw, so with exactly one trusted proxy that
 * entry is the real client and everything to its left is client-supplied
 * (spoofable). Without the header (or trustProxy), the socket address.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const last = xff.split(",").pop()?.trim();
      if (last) return last;
    }
  }
  // @hono/node-server exposes the raw incoming message under c.env.
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } };
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

/**
 * Authenticated caller: the principal auth put in the request context
 * (for Sage's nested dispatch, the outer user's sub), else the JWT sub,
 * "apikey" for the shared X-Api-Key, undefined when anonymous. Never the
 * secret.
 */
export function principalOf(c: Context): string | undefined {
  const fromContext = requestContext.getStore()?.principal;
  if (fromContext) return fromContext;
  const user = c.get("user") as { user_id?: string } | undefined;
  if (user?.user_id) return user.user_id;
  return c.req.header("x-api-key") ? "apikey" : undefined;
}

function bucketKey(
  c: Context,
  ip: string,
  keyBy: NonNullable<RateLimitOptions["keyBy"]>,
): string {
  if (keyBy === "ip") return ip;
  const principal = principalOf(c);
  if (keyBy === "principal") {
    return principal ? `p:${principal}` : `ip:${ip}`;
  }
  return `p:${principal ?? "-"}|ip:${ip}`;
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
