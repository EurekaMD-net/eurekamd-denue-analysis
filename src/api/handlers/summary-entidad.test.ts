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

/**
 * Mocks PostgREST responses based on URL path:
 *   - mv_coverage      -> [{ loaded: N }]
 *   - mv_sector_summary-> rows with totals
 *   - mv_estrato_por_entidad -> rows with estrato + total
 */
function makePostgrestMock(loaded: number, sectors: number, estratos: number) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes("/mv_coverage")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers(),
        json: async () => [{ loaded }],
      });
    }
    if (url.includes("/mv_sector_summary")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers(),
        json: async () =>
          Array.from({ length: sectors }, (_, i) => ({
            clase_actividad_id: `${622300 + i}`,
            clase_actividad: `Sector ${i}`,
            total: 1000 - i * 50,
          })),
      });
    }
    if (url.includes("/mv_estrato_por_entidad")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers(),
        json: async () =>
          Array.from({ length: estratos }, (_, i) => ({
            estrato: `${i + 1}-${i + 5} personas`,
            total: 500 - i * 100,
          })),
      });
    }
    return Promise.resolve({
      ok: true,
      headers: new Headers(),
      json: async () => [],
    });
  });
}

describe("GET /summary/entidad/:clave", () => {
  it("returns 200 with full entidad summary for a verified entidad (29 Tlaxcala)", async () => {
    vi.stubGlobal("fetch", makePostgrestMock(98692, 5, 4));
    const app = createServer(CONFIG);
    const res = await app.request("/summary/entidad/29", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entidad: string;
      loaded: number;
      inegi_total: number | null;
      coverage_pct: number | null;
      status: string;
      top_sectors: unknown[];
      estrato_distribution: unknown[];
    };
    expect(body.entidad).toBe("29");
    expect(body.loaded).toBe(98692);
    expect(body.inegi_total).toBe(98711);
    expect(body.coverage_pct).toBeCloseTo(99.98, 1);
    expect(body.status).toBe("green");
    expect(body.top_sectors).toHaveLength(5);
    expect(body.estrato_distribution).toHaveLength(4);
  });

  it("computes coverage_pct + status against the populated INEGI count (e.g. 09 CDMX)", async () => {
    // 2026-05-06: all 32 entidades populated from pipeline-state.json — there
    // is no longer an "entidad with no INEGI count" case. CDMX (09) authoritative
    // = 460,762; mock loaded = 50,000 → ~10.85% → red status.
    vi.stubGlobal("fetch", makePostgrestMock(50000, 3, 2));
    const app = createServer(CONFIG);
    const res = await app.request("/summary/entidad/09", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      coverage_pct: number | null;
    };
    expect(body.status).toBe("red");
    expect(body.coverage_pct).not.toBeNull();
  });

  it("returns 400 on invalid entidad", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/summary/entidad/00", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.entidad");
  });

  it("falls back to direct count when mv_coverage has no row for entidad", async () => {
    // mv_coverage returns [] (mv not refreshed yet) → handler falls back to count via Range header
    let firstCall = true;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/mv_coverage")) {
          return Promise.resolve({
            ok: true,
            headers: new Headers(),
            json: async () => [],
          });
        }
        if (url.includes("/establecimientos") && firstCall) {
          firstCall = false;
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-range": "0-0/12345" }),
            json: async () => [],
          });
        }
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          json: async () => [],
        });
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/summary/entidad/06", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loaded: number };
    expect(body.loaded).toBe(12345);
  });
});

describe("GET /summary/entidad/:clave — honest failures (audit #39 #55 #107 #132)", () => {
  function notFound() {
    return Promise.resolve({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => '{"code":"42P01"}',
      json: async () => ({}),
    });
  }

  it("returns 502 mv.missing when mv_sector_summary is not deployed", async () => {
    const base = makePostgrestMock(1000, 3, 2);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        url.includes("/mv_sector_summary") ? notFound() : base(url),
      ),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/summary/entidad/09", { headers: AUTH });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("mv.missing");
  });

  it("returns 502 mv.missing when mv_estrato_por_entidad is not deployed", async () => {
    const base = makePostgrestMock(1000, 3, 2);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        url.includes("/mv_estrato_por_entidad") ? notFound() : base(url),
      ),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/summary/entidad/09", { headers: AUTH });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("mv.missing");
  });

  it("returns 502 on a non-404 mv_coverage error instead of falling back", async () => {
    const base = makePostgrestMock(1000, 3, 2);
    const mockFetch = vi.fn().mockImplementation((url: string) =>
      url.includes("/mv_coverage")
        ? Promise.resolve({
            ok: false,
            status: 500,
            headers: new Headers(),
            text: async () => "boom",
            json: async () => ({}),
          })
        : base(url),
    );
    vi.stubGlobal("fetch", mockFetch);
    const app = createServer(CONFIG);
    const res = await app.request("/summary/entidad/09", { headers: AUTH });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgrest.error");
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/establecimientos"))).toBe(false);
  });

  it("still falls back to a direct count when mv_coverage is 404", async () => {
    const base = makePostgrestMock(0, 3, 2);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/mv_coverage")) return notFound();
        if (url.includes("/establecimientos"))
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-range": "0-0/777" }),
            json: async () => [],
          });
        return base(url);
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/summary/entidad/06", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loaded: number };
    expect(body.loaded).toBe(777);
  });

  it("returns 502 when the fallback count has no Content-Range total", async () => {
    const base = makePostgrestMock(0, 3, 2);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/mv_coverage")) return notFound();
        if (url.includes("/establecimientos"))
          return Promise.resolve({
            ok: true,
            headers: new Headers(),
            json: async () => [],
          });
        return base(url);
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/summary/entidad/06", { headers: AUTH });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgrest.error");
  });

  it("issues all three MV fetches before reading any response", async () => {
    let coverageRead = false;
    const startedAfterCoverageRead: string[] = [];
    const base = makePostgrestMock(1000, 3, 2);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (coverageRead) startedAfterCoverageRead.push(url);
        if (url.includes("/mv_coverage"))
          return Promise.resolve({
            ok: true,
            headers: new Headers(),
            json: async () => {
              coverageRead = true;
              return [{ loaded: 1000 }];
            },
          });
        return base(url);
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/summary/entidad/09", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(startedAfterCoverageRead).toEqual([]);
  });
});
