import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { makeAuthMiddleware } from "./auth.js";
import { _clearJwtCache } from "./bearer-auth.js";

const TEST_KEY = "test-api-key-12345";
const JWT_SECRET = "test-jwt-secret";

function makeApp(opts?: { withJwt?: boolean }) {
  const app = new Hono();
  app.use(
    "*",
    makeAuthMiddleware({
      apiKey: TEST_KEY,
      supabaseJwtSecret: opts?.withJwt ? JWT_SECRET : undefined,
    }),
  );
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJwt(claims: Record<string, unknown>, secret = JWT_SECRET): string {
  const headerB64 = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadB64 = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  return `${headerB64}.${payloadB64}.${b64url(sig)}`;
}

describe("makeAuthMiddleware", () => {
  it("rejects request with missing X-Api-Key header (401)", async () => {
    const app = makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("auth.missing");
  });

  it("rejects request with wrong X-Api-Key (401)", async () => {
    const app = makeApp();
    const res = await app.request("/", { headers: { "X-Api-Key": "wrong" } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("auth.invalid");
  });

  it("rejects request with right-prefix-but-shorter key (401)", async () => {
    // timing-safe equality requires equal length
    const app = makeApp();
    const res = await app.request("/", {
      headers: { "X-Api-Key": "test-api-key" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts request with correct X-Api-Key (200)", async () => {
    const app = makeApp();
    const res = await app.request("/", { headers: { "X-Api-Key": TEST_KEY } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("throws at construction time when expectedKey is empty", () => {
    expect(() => makeAuthMiddleware("")).toThrow(/empty/);
    expect(() => makeAuthMiddleware("   ")).toThrow(/empty/);
  });
});

describe("makeAuthMiddleware — Bearer JWT path", () => {
  beforeEach(() => _clearJwtCache());

  it("accepts a valid Supabase JWT", async () => {
    const app = makeApp({ withJwt: true });
    const tok = makeJwt({
      sub: "user-1",
      email: "a@b.com",
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await app.request("/", {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a JWT with bad signature (401)", async () => {
    const app = makeApp({ withJwt: true });
    const tok = makeJwt(
      {
        sub: "user-1",
        role: "authenticated",
        aud: "authenticated",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "wrong-secret",
    );
    const res = await app.request("/", {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(401);
  });

  it("does NOT fall back to X-Api-Key when Bearer is bad", async () => {
    // Caller intent: they sent Bearer. A bad bearer = 401, never silently
    // succeed via a co-sent valid key. Closes a fingerprinting vector.
    const app = makeApp({ withJwt: true });
    const tok = makeJwt(
      {
        sub: "u",
        role: "authenticated",
        aud: "authenticated",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "wrong-secret",
    );
    const res = await app.request("/", {
      headers: { Authorization: `Bearer ${tok}`, "X-Api-Key": TEST_KEY },
    });
    expect(res.status).toBe(401);
  });

  it("returns 503 when Bearer is sent but server has no JWT secret", async () => {
    const app = makeApp({ withJwt: false });
    const tok = makeJwt({
      sub: "u",
      role: "authenticated",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await app.request("/", {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(503);
  });

  it("X-Api-Key path still works alongside JWT-enabled middleware", async () => {
    const app = makeApp({ withJwt: true });
    const res = await app.request("/", { headers: { "X-Api-Key": TEST_KEY } });
    expect(res.status).toBe(200);
  });
});
