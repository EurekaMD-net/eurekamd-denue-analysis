import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "./server.js";
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
    const app = createServer(TEST_CONFIG);
    // Missing cvegeo → 400 from the handler without touching the DB.
    for (let i = 0; i < 20; i++) {
      const res = await app.request("/analytics/ageb-detail", {
        headers: { "X-Api-Key": "test-key" },
      });
      expect(res.status).toBe(400);
    }
    const limited = await app.request("/analytics/ageb-detail", {
      headers: { "X-Api-Key": "test-key" },
    });
    expect(limited.status).toBe(429);
  });
});
