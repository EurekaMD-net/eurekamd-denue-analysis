import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));

import { createServer } from "../server.js";
import { formatPsqlError } from "./analytics.js";
import type {
  ApiServerConfig,
  MunicipiosAnalyticsResult,
  NationalTreemapResult,
  SectorGradeMatrixResult,
} from "../types.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-jwt",
  apiKey: "key",
  dbContainer: "test-supabase-db",
};
const AUTH = { "X-Api-Key": "key" };

beforeEach(() => mockExec.mockReset());
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// /analytics/national-treemap
// ---------------------------------------------------------------------------

describe("GET /analytics/national-treemap", () => {
  it("returns 32 entidades joined with IRS + pobreza, all numeric", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          entidad: "06",
          establecimientos: "41765",
          modal_irs_grado: "Bajo",
          pobreza_pct_promedio: "27.4",
        },
        {
          entidad: "09",
          establecimientos: "460866",
          modal_irs_grado: "Muy bajo",
          pobreza_pct_promedio: "18.6",
        },
        {
          entidad: "20",
          establecimientos: "200000",
          modal_irs_grado: "Alto",
          pobreza_pct_promedio: "61.7",
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/national-treemap", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as NationalTreemapResult;
    expect(body.entidades).toHaveLength(3);

    const cdmx = body.entidades.find((e) => e.entidad === "09");
    expect(cdmx).toBeDefined();
    expect(cdmx?.nombre).toBe("Ciudad de México");
    expect(cdmx?.establecimientos).toBe(460866);
    expect(cdmx?.modal_irs_grado).toBe("Muy bajo");
    expect(cdmx?.pobreza_pct_promedio).toBe(18.6);
  });

  it("normalizes unknown grado to 'sin_dato' rather than leaking it", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          entidad: "01",
          establecimientos: "70000",
          modal_irs_grado: "Garbage Value",
          pobreza_pct_promedio: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/national-treemap", {
      headers: AUTH,
    });
    const body = (await res.json()) as NationalTreemapResult;
    expect(body.entidades[0]?.modal_irs_grado).toBe("sin_dato");
    expect(body.entidades[0]?.pobreza_pct_promedio).toBeNull();
  });

  it("sets long Cache-Control + Vary on success", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          entidad: "01",
          establecimientos: "1",
          modal_irs_grado: null,
          pobreza_pct_promedio: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/national-treemap", {
      headers: AUTH,
    });
    expect(res.headers.get("cache-control")).toMatch(/max-age=3600/);
    expect(res.headers.get("vary")).toMatch(/X-Api-Key/i);
  });

  it("returns 401 without API key", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/national-treemap");
    expect(res.status).toBe(401);
    expect(mockExec).not.toHaveBeenCalled();
  });

  // Note: testing the throw-from-execFileSync path with `mockImplementation(() => { throw })`
  // hits a vitest 4 unhandled-exception quirk that fails the test even though
  // the handler catches and converts to 502. Same pattern noted across prior
  // sessions. We exercise the equivalent error surface via malformed JSON
  // (parse_error catch branch) below — same defensive failure mode, no quirk.

  it("returns 502 with code postgres.parse_error on malformed psql output", async () => {
    mockExec.mockReturnValue("not json {{");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/national-treemap", {
      headers: AUTH,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgres.parse_error");
  });

  it("returns empty when DB returns null", async () => {
    mockExec.mockReturnValue("null");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/national-treemap", {
      headers: AUTH,
    });
    const body = (await res.json()) as NationalTreemapResult;
    expect(body.entidades).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// /analytics/sector-grade-matrix
// ---------------------------------------------------------------------------

describe("GET /analytics/sector-grade-matrix", () => {
  it("returns cells with scian + irs_grado + count, all numeric", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        { scian: "11", irs_grado: "Muy bajo", count: "100" },
        { scian: "11", irs_grado: "Alto", count: "5" },
        { scian: "46", irs_grado: "Muy bajo", count: "1500000" },
        { scian: "46", irs_grado: "sin_dato", count: "12" },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/sector-grade-matrix", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SectorGradeMatrixResult;
    expect(body.cells).toHaveLength(4);
    expect(body.cells[2]?.count).toBe(1500000);
    expect(body.cells[3]?.irs_grado).toBe("sin_dato");
  });

  it("collapses unknown grados to sin_dato", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([{ scian: "11", irs_grado: "garbage", count: "1" }]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/sector-grade-matrix", {
      headers: AUTH,
    });
    const body = (await res.json()) as SectorGradeMatrixResult;
    expect(body.cells[0]?.irs_grado).toBe("sin_dato");
  });

  it("uses LEFT JOIN against coneval_irs_municipal", async () => {
    mockExec.mockReturnValue("null");
    const app = createServer(CONFIG);
    await app.request("/analytics/sector-grade-matrix", { headers: AUTH });
    const args = mockExec.mock.calls[0]?.[1] as string[];
    const sql = args[args.length - 1];
    expect(sql).toMatch(/LEFT JOIN coneval_irs_municipal/);
    expect(sql).toMatch(/sector_actividad_id/);
  });
});

// ---------------------------------------------------------------------------
// /analytics/municipios?entidad=
// ---------------------------------------------------------------------------

describe("GET /analytics/municipios?entidad=", () => {
  it("rejects missing entidad with 400", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipios", { headers: AUTH });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects invalid entidad ('00', '33', non-digit) with 400", async () => {
    const app = createServer(CONFIG);
    for (const bad of ["00", "33", "AA", "1", "001", "9'; DROP--"]) {
      const res = await app.request(
        `/analytics/municipios?entidad=${encodeURIComponent(bad)}`,
        { headers: AUTH },
      );
      expect(res.status).toBe(400);
    }
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns rows joined across DENUE × Censo × CONEVAL × CLUES", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_mun: "09007",
          municipio: "Iztapalapa",
          poblacion: "1835486",
          establecimientos: "120000",
          farmacias: "1500",
          unidades_clues: "512",
          pobreza_pct: "43.9",
          irs_grado: "Bajo",
          irs_indice: "-1.23",
        },
        {
          cve_mun: "09005",
          municipio: "Gustavo A. Madero",
          poblacion: "1173351",
          establecimientos: "80000",
          farmacias: "1100",
          unidades_clues: "423",
          pobreza_pct: "33.8",
          irs_grado: "Muy bajo",
          irs_indice: "-1.56",
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipios?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MunicipiosAnalyticsResult;
    expect(body.entidad).toBe("09");
    expect(body.municipios).toHaveLength(2);
    const izta = body.municipios[0];
    expect(izta?.poblacion).toBe(1835486);
    expect(izta?.farmacias).toBe(1500);
    expect(izta?.unidades_clues).toBe(512);
    expect(izta?.pobreza_pct).toBe(43.9);
    expect(izta?.irs_indice).toBe(-1.23);
  });

  it("inlines entidad into SQL only after ENTIDAD_RE gate (defense in depth)", async () => {
    mockExec.mockReturnValue("null");
    const app = createServer(CONFIG);
    await app.request("/analytics/municipios?entidad=09", { headers: AUTH });
    const args = mockExec.mock.calls[0]?.[1] as string[];
    const sql = args[args.length - 1];
    // SQL contains the literal '09' (not interpolated user trash) — ENTIDAD_RE
    // restricts to /^(0[1-9]|[12][0-9]|3[0-2])$/ so quotes are impossible.
    expect(sql).toMatch(/entidad = '09'/);
    expect(sql).toMatch(/LEFT\(cve_mun, 2\) = '09'/);
    expect(sql).toMatch(/farmacias/);
    expect(sql).toMatch(/unidades_clues/);
  });

  it("normalizes null DB columns to null in API response", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_mun: "01001",
          municipio: null,
          poblacion: null,
          establecimientos: "5",
          farmacias: "0",
          unidades_clues: "0",
          pobreza_pct: null,
          irs_grado: null,
          irs_indice: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipios?entidad=01", {
      headers: AUTH,
    });
    const body = (await res.json()) as MunicipiosAnalyticsResult;
    const r = body.municipios[0]!;
    expect(r.municipio).toBeNull();
    expect(r.poblacion).toBeNull();
    expect(r.pobreza_pct).toBeNull();
    expect(r.irs_grado).toBeNull();
    expect(r.irs_indice).toBeNull();
    // But establecimientos/farmacias/unidades_clues are always numeric (0 ok)
    expect(r.establecimientos).toBe(5);
    expect(r.farmacias).toBe(0);
  });

  it("sets short Cache-Control on success", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipios?entidad=09", {
      headers: AUTH,
    });
    expect(res.headers.get("cache-control")).toMatch(/max-age=300/);
  });

  it("rejects malformed dbContainer at runtime (defense)", async () => {
    const badConfig: ApiServerConfig = { ...CONFIG, dbContainer: "--rm" };
    const app = createServer(badConfig);
    const res = await app.request("/analytics/national-treemap", {
      headers: AUTH,
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("config.bad_container");
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /analytics/top-sectors?entidad=
// ---------------------------------------------------------------------------

describe("GET /analytics/top-sectors?entidad=", () => {
  it("returns sectors with names from SCIAN catalog, sorted DESC", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        { scian: "46", count: "120000" },
        { scian: "72", count: "30000" },
        { scian: "62", count: "8000" },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/top-sectors?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entidad: string;
      sectors: Array<{ scian: string; name: string; count: number }>;
    };
    expect(body.entidad).toBe("09");
    expect(body.sectors).toHaveLength(3);
    expect(body.sectors[0]?.scian).toBe("46");
    expect(body.sectors[0]?.name).toMatch(/Comercio al por menor/);
    expect(body.sectors[0]?.count).toBe(120000);
  });

  it("rejects missing/invalid entidad with 400", async () => {
    const app = createServer(CONFIG);
    expect(
      (await app.request("/analytics/top-sectors", { headers: AUTH })).status,
    ).toBe(400);
    expect(
      (
        await app.request("/analytics/top-sectors?entidad=99", {
          headers: AUTH,
        })
      ).status,
    ).toBe(400);
  });

  it("respects limit query param within 1..25", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request("/analytics/top-sectors?entidad=09&limit=5", {
      headers: AUTH,
    });
    const args = mockExec.mock.calls[0]?.[1] as string[];
    const sql = args[args.length - 1];
    expect(sql).toMatch(/LIMIT 5/);
  });

  it("rejects out-of-range limits with 400", async () => {
    const app = createServer(CONFIG);
    expect(
      (
        await app.request("/analytics/top-sectors?entidad=09&limit=0", {
          headers: AUTH,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/analytics/top-sectors?entidad=09&limit=100", {
          headers: AUTH,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/analytics/top-sectors?entidad=09&limit=abc", {
          headers: AUTH,
        })
      ).status,
    ).toBe(400);
  });

  it("uses indexed sector_actividad_id, not SUBSTR", async () => {
    mockExec.mockReturnValue("null");
    const app = createServer(CONFIG);
    await app.request("/analytics/top-sectors?entidad=09", { headers: AUTH });
    const args = mockExec.mock.calls[0]?.[1] as string[];
    const sql = args[args.length - 1];
    expect(sql).toMatch(/sector_actividad_id/);
    expect(sql).not.toMatch(/SUBSTR\(clee/);
  });
});

// ---------------------------------------------------------------------------
// formatPsqlError — pure function, all 3 stderr branches
// (audit W1 2026-05-04: cover all branches without the vitest-4 throw quirk)
// ---------------------------------------------------------------------------

describe("formatPsqlError", () => {
  it("appends Buffer stderr to the base message (truncated to 500)", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from('ERROR:  relation "x" does not exist\nLINE 1: ...'),
    });
    const out = formatPsqlError(err);
    expect(out).toBe(
      'Command failed | psql stderr: ERROR:  relation "x" does not exist\nLINE 1: ...',
    );
  });

  it("appends string stderr (non-Node Buffer environments)", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: "FATAL:  password authentication failed\n",
    });
    expect(formatPsqlError(err)).toBe(
      "Command failed | psql stderr: FATAL:  password authentication failed",
    );
  });

  it("falls back to message when stderr is undefined", () => {
    const err = new Error("ETIMEDOUT");
    expect(formatPsqlError(err)).toBe("ETIMEDOUT");
  });

  it("falls back to message when stderr is empty Buffer", () => {
    const err = Object.assign(new Error("EAGAIN"), {
      stderr: Buffer.from(""),
    });
    expect(formatPsqlError(err)).toBe("EAGAIN");
  });

  it("truncates stderr at 500 chars to bound the 502 response size", () => {
    const big = "a".repeat(2000);
    const err = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from(big),
    });
    const out = formatPsqlError(err);
    expect(out.length).toBeLessThanOrEqual(
      "Command failed | psql stderr: ".length + 500,
    );
    expect(out).toContain("psql stderr: " + "a".repeat(500));
    expect(out).not.toContain("a".repeat(501));
  });

  it("stringifies non-Error throws (e.g., a thrown string)", () => {
    expect(formatPsqlError("naked string throw")).toBe("naked string throw");
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/top-sectors — error paths (R2 + R3 from prior audit)
// ---------------------------------------------------------------------------

describe("GET /analytics/top-sectors error paths", () => {
  // Audit R2: symmetric malformed-JSON coverage with national-treemap.
  it("returns 502 with code postgres.parse_error on malformed psql output", async () => {
    mockExec.mockReturnValue("definitely not json");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/top-sectors?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgres.parse_error");
  });

  // Audit R3: empty-string from psql -t -A trim is treated as empty list.
  it("returns empty sectors array when stdout is empty string", async () => {
    mockExec.mockReturnValue("   ");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/top-sectors?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sectors: unknown[] };
    expect(body.sectors).toEqual([]);
  });
});
