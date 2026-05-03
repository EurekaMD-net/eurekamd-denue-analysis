import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "../server.js";
import type { ApiServerConfig } from "../types.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-jwt",
  apiKey: "key",
  dbContainer: "test-supabase-db",
};
const AUTH = { "X-Api-Key": "key" };

afterEach(() => vi.restoreAllMocks());

describe("GET /establishment/:clee", () => {
  it("returns 200 + record when PostgREST finds the CLEE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { clee: "06001114119000013102000000U6", nombre: "TEST CO" },
        ],
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/establishment/06001114119000013102000000U6",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clee: string;
      data: { nombre: string };
    };
    expect(body.clee).toBe("06001114119000013102000000U6");
    expect(body.data.nombre).toBe("TEST CO");
  });

  it("returns 404 when CLEE not found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/establishment/09000999999999999999999999U0",
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 400 on invalid CLEE format", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/establishment/short", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.clee");
  });

  it("returns 502 when PostgREST errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/establishment/06001114119000013102000000U6",
      { headers: AUTH },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgrest.error");
  });
});
