import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { makeRateLimitMiddleware } from "./rate-limit.js";

afterEach(() => vi.useRealTimers());

function makeApp(opts: Parameters<typeof makeRateLimitMiddleware>[0]) {
  const app = new Hono();
  app.use("*", makeRateLimitMiddleware(opts));
  app.get("/x", (c) => c.text("ok"));
  return app;
}

describe("makeRateLimitMiddleware", () => {
  it("allows up to `max` requests in the window", async () => {
    const app = makeApp({ max: 3, windowMs: 1000, getIp: () => "1.1.1.1" });
    const responses = await Promise.all([1, 2, 3].map(() => app.request("/x")));
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 once `max` is exceeded", async () => {
    const app = makeApp({ max: 2, windowMs: 1000, getIp: () => "1.1.1.1" });
    await app.request("/x");
    await app.request("/x");
    const res = await app.request("/x");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("rate_limit");
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("isolates buckets per IP", async () => {
    let ip = "10.0.0.1";
    const app = makeApp({ max: 1, windowMs: 1000, getIp: () => ip });
    const r1 = await app.request("/x"); // IP A
    expect(r1.status).toBe(200);
    const r2 = await app.request("/x"); // IP A again — limited
    expect(r2.status).toBe(429);
    ip = "10.0.0.2";
    const r3 = await app.request("/x"); // IP B — allowed
    expect(r3.status).toBe(200);
  });

  it("releases requests after the window passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T00:00:00Z"));
    const app = makeApp({ max: 1, windowMs: 1000, getIp: () => "1.1.1.1" });
    const r1 = await app.request("/x");
    expect(r1.status).toBe(200);
    const r2 = await app.request("/x");
    expect(r2.status).toBe(429);
    vi.advanceTimersByTime(1500);
    const r3 = await app.request("/x");
    expect(r3.status).toBe(200);
  });

  it("derives IP from x-forwarded-for when trustProxy is true", async () => {
    const app = new Hono();
    app.use(
      "*",
      makeRateLimitMiddleware({ max: 1, windowMs: 1000, trustProxy: true }),
    );
    app.get("/x", (c) => c.text("ok"));
    const r1 = await app.request("/x", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request("/x", {
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(r2.status).toBe(429);
    // Different IP
    const r3 = await app.request("/x", {
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    expect(r3.status).toBe(200);
  });

  it("ignores x-forwarded-for when trustProxy is false (anti-spoof)", async () => {
    const app = new Hono();
    // trustProxy=false (default when TRUST_PROXY env unset)
    app.use(
      "*",
      makeRateLimitMiddleware({ max: 1, windowMs: 1000, trustProxy: false }),
    );
    app.get("/x", (c) => c.text("ok"));
    // Both requests look like different IPs via XFF, but the middleware
    // ignores XFF and falls back to remoteAddress (undefined → "unknown").
    // Both share the bucket → second is rate-limited.
    const r1 = await app.request("/x", {
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request("/x", {
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    expect(r2.status).toBe(429);
  });
});
