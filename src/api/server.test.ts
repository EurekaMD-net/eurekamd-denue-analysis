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
