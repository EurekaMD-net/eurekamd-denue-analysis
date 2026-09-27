import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createServer } from "./server.js";
import { requestContext } from "./request-context.js";
import type { ApiServerConfig } from "./types.js";

const TEST_CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-jwt",
  apiKey: "test-key",
  dbContainer: "test-supabase-db",
};

afterEach(() => {
  vi.restoreAllMocks();
});

const JWT_SECRET = "test-jwt-secret";
const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64url").replace(/=+$/, "");
/** HS256 Supabase-style JWT for a member of the uncharted app. */
function memberJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({
      sub: "user-1",
      role: "authenticated",
      aud: "authenticated",
      app_metadata: { apps: ["uncharted"] },
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = createHmac("sha256", JWT_SECRET)
    .update(`${head}.${body}`)
    .digest();
  return `${head}.${body}.${b64url(sig)}`;
}

describe("createServer — config validation", () => {
  it("throws if supabaseUrl is missing", () => {
    expect(() => createServer({ ...TEST_CONFIG, supabaseUrl: "" })).toThrow(
      /supabaseUrl/,
    );
  });

  it("throws if serviceRoleKey is missing", () => {
    expect(() => createServer({ ...TEST_CONFIG, serviceRoleKey: "" })).toThrow(
      /serviceRoleKey/,
    );
  });

  it("throws if apiKey is missing", () => {
    expect(() => createServer({ ...TEST_CONFIG, apiKey: "" })).toThrow(
      /apiKey/,
    );
  });

  it("throws if dbContainer is missing", () => {
    expect(() => createServer({ ...TEST_CONFIG, dbContainer: "" })).toThrow(
      /dbContainer/,
    );
  });
});

describe("createServer — routing", () => {
  it("/health is unauthenticated and returns ok", async () => {
    const app = createServer(TEST_CONFIG);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("denue-api");
  });

  it("/search rejects without X-Api-Key (401)", async () => {
    const app = createServer(TEST_CONFIG);
    const res = await app.request("/search");
    expect(res.status).toBe(401);
  });

  it("/establishment/:clee rejects without X-Api-Key (401)", async () => {
    const app = createServer(TEST_CONFIG);
    const res = await app.request("/establishment/0900012345678");
    expect(res.status).toBe(401);
  });

  it("/clusters rejects without X-Api-Key (401)", async () => {
    const app = createServer(TEST_CONFIG);
    const res = await app.request("/clusters?entidad=09&scian=46");
    expect(res.status).toBe(401);
  });

  it("/summary/sector/:scian rejects without X-Api-Key (401)", async () => {
    const app = createServer(TEST_CONFIG);
    const res = await app.request("/summary/sector/46");
    expect(res.status).toBe(401);
  });

  it("unknown route returns 404 even with valid auth", async () => {
    const app = createServer(TEST_CONFIG);
    const res = await app.request("/nope", {
      headers: { "X-Api-Key": "test-key" },
    });
    expect(res.status).toBe(404);
  });
});

describe("createServer — edge limits", () => {
  it("/sage/query rejects a 17 KB body with 413 before the handler", async () => {
    const app = createServer(TEST_CONFIG);
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { "X-Api-Key": "test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ question: "x".repeat(17 * 1024) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("payload_too_large");
  });

  it("/sage/query lets a small body through to the handler", async () => {
    const app = createServer(TEST_CONFIG);
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { "X-Api-Key": "test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hola" }),
    });
    // No sageProvider in TEST_CONFIG → the handler's own 503.
    expect(res.status).toBe(503);
  });

  it("/analytics/ageb-detail is limited to 20/min per principal+IP", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const app = createServer({ ...TEST_CONFIG, supabaseJwtSecret: JWT_SECRET });
    const headers = { Authorization: `Bearer ${memberJwt()}` };
    // Missing cvegeo → 400 from the handler without touching the DB.
    for (let i = 0; i < 20; i++) {
      const res = await app.request("/analytics/ageb-detail", { headers });
      expect(res.status).toBe(400);
    }
    const limited = await app.request("/analytics/ageb-detail", { headers });
    expect(limited.status).toBe(429);
  });

  it("the X-Api-Key (Jarvis) is exempt from the /analytics limits", async () => {
    // Pre-change (before 9966f0f): the ageb-detail limiter had no
    // `exempt`, so request 21 here was a 429.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const app = createServer(TEST_CONFIG);
    for (let i = 0; i < 30; i++) {
      const res = await app.request("/analytics/ageb-detail", {
        headers: { "X-Api-Key": "test-key" },
      });
      expect(res.status).toBe(400);
    }
    // A forged key is rejected by auth before any limiter could exempt it.
    const forged = await app.request("/analytics/ageb-detail", {
      headers: { "X-Api-Key": "not-the-key" },
    });
    expect(forged.status).toBe(401);
  });

  it("a bearer user's nested Sage dispatch carrying the key is NOT exempt", async () => {
    // Fails on 9966f0f: its limiters exempted on the raw x-api-key header
    // (the since-removed isPriorityPrincipal), so call 21 below was a 400.
    // Sage's dispatcher re-enters the app with the shared key inside the
    // browser user's (non-priority) request context.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const app = createServer(TEST_CONFIG);
    const statuses: number[] = [];
    await requestContext.run({ principal: "user-1", priority: false }, async () => {
      for (let i = 0; i < 21; i++) {
        const res = await app.request("/analytics/ageb-detail", {
          headers: { "X-Api-Key": "test-key" },
        });
        statuses.push(res.status);
      }
    });
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("nested Sage dispatches are metered per browser user, not in one shared bucket", async () => {
    // Fails on 4fed1e3: auth.ts set `principal: "apikey"` on the nested
    // path and principalOf ignored the context, so both users landed in
    // `p:apikey|ip:unknown` and user-2's first call was already a 429.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const app = createServer(TEST_CONFIG);
    const nested = (user: string, n: number) =>
      requestContext.run({ principal: user, priority: false }, async () => {
        const statuses: number[] = [];
        for (let i = 0; i < n; i++) {
          const res = await app.request("/analytics/ageb-detail", {
            headers: { "X-Api-Key": "test-key" },
          });
          statuses.push(res.status);
        }
        return statuses;
      });
    for (const user of ["user-1", "user-2"]) {
      expect(await nested(user, 20)).toEqual(Array(20).fill(400));
    }
    expect(await nested("user-1", 1)).toEqual([429]);
    // A direct X-Api-Key call (Jarvis) is still exempt.
    for (let i = 0; i < 25; i++) {
      const res = await app.request("/analytics/ageb-detail", {
        headers: { "X-Api-Key": "test-key" },
      });
      expect(res.status).toBe(400);
    }
  });
});
