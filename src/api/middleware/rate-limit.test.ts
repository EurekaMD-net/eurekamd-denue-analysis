import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { isPriorityPrincipal, makeRateLimitMiddleware } from "./rate-limit.js";

type UserEnv = { Variables: { user: { user_id: string } } };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

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
    // Caddy appends the real peer as the RIGHTMOST entry; the left entry
    // here is client-supplied and must not pick the bucket.
    const r1 = await app.request("/x", {
      headers: { "x-forwarded-for": "10.0.0.1, 203.0.113.5" },
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

  it("a spoofed leftmost x-forwarded-for entry does not change the bucket", async () => {
    const app = makeApp({ max: 1, windowMs: 1000, trustProxy: true });
    const r1 = await app.request("/x", {
      headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.5" },
    });
    expect(r1.status).toBe(200);
    // Rotating the client-controlled left entry must not buy a fresh bucket.
    const r2 = await app.request("/x", {
      headers: { "x-forwarded-for": "198.51.100.2, 203.0.113.5" },
    });
    expect(r2.status).toBe(429);
  });

  it("TRUST_PROXY=1 (no injection): two rightmost XFF values get separate buckets", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const app = makeApp({ max: 1, windowMs: 1000 });
    const a1 = await app.request("/x", {
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(a1.status).toBe(200);
    const b1 = await app.request("/x", {
      headers: { "x-forwarded-for": "203.0.113.6" },
    });
    expect(b1.status).toBe(200);
    const a2 = await app.request("/x", {
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(a2.status).toBe(429);
  });

  it('keyBy "principal" limits per user, not per IP', async () => {
    let user: string | undefined = "user-a";
    let ip = "10.0.0.1";
    const app = new Hono<UserEnv>();
    app.use("*", async (c, next) => {
      if (user) c.set("user", { user_id: user });
      await next();
    });
    app.use(
      "*",
      makeRateLimitMiddleware({
        max: 1,
        windowMs: 1000,
        getIp: () => ip,
        keyBy: "principal",
      }),
    );
    app.get("/x", (c) => c.text("ok"));
    expect((await app.request("/x")).status).toBe(200);
    ip = "10.0.0.2"; // same user, new IP: still limited
    expect((await app.request("/x")).status).toBe(429);
    user = "user-b"; // different user, same IP: own bucket
    expect((await app.request("/x")).status).toBe(200);
    user = undefined; // anonymous: falls back to the IP bucket
    expect((await app.request("/x")).status).toBe(200);
    // the shared API key is one principal across IPs
    const k1 = await app.request("/x", { headers: { "x-api-key": "k" } });
    expect(k1.status).toBe(200);
    ip = "10.0.0.3";
    const k2 = await app.request("/x", { headers: { "x-api-key": "k" } });
    expect(k2.status).toBe(429);
  });

  it('keyBy "principal+ip" separates the same user on two IPs', async () => {
    let ip = "10.0.0.1";
    const app = new Hono<UserEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { user_id: "user-a" });
      await next();
    });
    app.use(
      "*",
      makeRateLimitMiddleware({
        max: 1,
        windowMs: 1000,
        getIp: () => ip,
        keyBy: "principal+ip",
      }),
    );
    app.get("/x", (c) => c.text("ok"));
    expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x")).status).toBe(429);
    ip = "10.0.0.2";
    expect((await app.request("/x")).status).toBe(200);
  });
});

describe("exempt: isPriorityPrincipal (the X-Api-Key tier)", () => {
  // Pre-change: no `exempt` option, so the api-key requests below hit the
  // `if (recent.length >= max)` 429 branch on the 3rd call.
  function exemptApp(user?: string) {
    const app = new Hono<UserEnv>();
    if (user) {
      app.use("*", async (c, next) => {
        c.set("user", { user_id: user });
        await next();
      });
    }
    app.use(
      "*",
      makeRateLimitMiddleware({
        max: 2,
        windowMs: 60_000,
        getIp: () => "10.0.0.1",
        exempt: isPriorityPrincipal,
      }),
    );
    app.get("/x", (c) => c.text("ok"));
    return app;
  }

  it("never 429s the api key and does not consume the shared bucket", async () => {
    const app = exemptApp();
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/x", { headers: { "x-api-key": "k" } });
      expect(res.status).toBe(200);
    }
    // Same IP bucket: had the api-key calls counted, this would be 429.
    expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x")).status).toBe(429);

    // A bearer principal is still limited, even with a stray x-api-key.
    const bearer = exemptApp("user-a");
    const h = { headers: { "x-api-key": "k" } };
    expect((await bearer.request("/x", h)).status).toBe(200);
    expect((await bearer.request("/x", h)).status).toBe(200);
    expect((await bearer.request("/x", h)).status).toBe(429);
  });
});
