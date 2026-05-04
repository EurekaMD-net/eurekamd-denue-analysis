import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "../server.js";
import type { ApiServerConfig, EntidadesResult } from "../types.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-jwt",
  apiKey: "key",
  dbContainer: "test-supabase-db",
};
const AUTH = { "X-Api-Key": "key" };

afterEach(() => vi.restoreAllMocks());

describe("GET /entidades", () => {
  it("returns 32 entries when mv_coverage is applied", async () => {
    // Build a synthetic mv_coverage payload with all 32 claves
    const rows = Array.from({ length: 32 }, (_, i) => ({
      entidad: String(i + 1).padStart(2, "0"),
      loaded: 1000 * (i + 1),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => rows,
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/entidades", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EntidadesResult;
    expect(body.entidades).toHaveLength(32);
    expect(body.entidades[0]?.clave).toBe("01");
    expect(body.entidades[0]?.nombre).toBe("Aguascalientes");
    expect(body.entidades[31]?.clave).toBe("32");
    expect(body.entidades[31]?.nombre).toBe("Zacatecas");
  });

  it("falls back to per-entidad count when mv_coverage is missing (404)", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        call++;
        if (call === 1) {
          // mv_coverage 404 → triggers fallback
          return {
            ok: false,
            status: 404,
            text: async () => "Not Found",
          };
        }
        // 32 follow-up count requests via Range header
        return {
          ok: true,
          status: 206,
          headers: {
            get: (k: string) => (k === "content-range" ? "0-0/12345" : null),
          },
        };
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/entidades", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EntidadesResult;
    expect(body.entidades).toHaveLength(32);
    expect(body.entidades[0]?.loaded).toBe(12345);
    // 1 mv_coverage + 32 fallbacks
    expect(call).toBe(33);
  });

  it("returns 502 when mv_coverage errors with non-404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/entidades", { headers: AUTH });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgrest.error");
  });

  it("computes status from inegi counts (Colima → green)", async () => {
    // Provide a loaded count near the INEGI authoritative for Colima (06).
    const rows = [{ entidad: "06", loaded: 41750 }]; // INEGI: 41756 → 99.98% → green
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => rows,
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/entidades", { headers: AUTH });
    const body = (await res.json()) as EntidadesResult;
    const colima = body.entidades.find((e) => e.clave === "06");
    expect(colima?.loaded).toBe(41750);
    expect(colima?.inegi_total).toBe(41756);
    expect(colima?.status).toBe("green");
    // Aguascalientes has no inegi_total → unverified
    const ags = body.entidades.find((e) => e.clave === "01");
    expect(ags?.status).toBe("unverified");
  });

  it("rejects unauthenticated requests", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/entidades");
    expect(res.status).toBe(401);
  });
});
