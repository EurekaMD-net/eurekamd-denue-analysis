import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

import { createServer } from "../server.js";
import {
  formatPsqlError,
  isRelationMissingError,
  runJsonQueryMvFirst,
} from "./analytics.js";
import type {
  ApiServerConfig,
  MunicipiosAnalyticsResult,
  NationalTreemapResult,
  RiskSummaryResult,
  RiskTrendResult,
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

  it("hits the mat-view first (mv_national_treemap)", async () => {
    mockExec.mockReturnValue("null");
    const app = createServer(CONFIG);
    await app.request("/analytics/national-treemap", { headers: AUTH });
    expect(mockExec).toHaveBeenCalledTimes(1);
    const args = mockExec.mock.calls[0]?.[1] as string[];
    expect(args[args.length - 1]).toMatch(/FROM mv_national_treemap/);
  });

  it("falls back to live multi-CTE SQL when mat-view is missing", async () => {
    mockExec
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed"), {
          stderr: Buffer.from(
            'ERROR:  relation "mv_national_treemap" does not exist',
          ),
        });
      })
      .mockReturnValueOnce("null"); // live SQL returns empty
    const app = createServer(CONFIG);
    await app.request("/analytics/national-treemap", { headers: AUTH });
    expect(mockExec).toHaveBeenCalledTimes(2);
    // Audit W2 (2026-05-04): pin the live-fallback SQL to the multi-CTE
    // shape that the mat-view materializes — prevents drift between the
    // two sources of truth.
    const liveArgs = mockExec.mock.calls[1]?.[1] as string[];
    const liveSql = liveArgs[liveArgs.length - 1];
    expect(liveSql).toMatch(/WITH entidad_counts AS/);
    expect(liveSql).toMatch(/coneval_irs_municipal/);
    expect(liveSql).toMatch(/coneval_pobreza_municipal/);
    expect(liveSql).toMatch(/ROW_NUMBER\(\) OVER/);
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

  it("hits the mat-view first (mv_sector_grade_matrix)", async () => {
    mockExec.mockReturnValue("null");
    const app = createServer(CONFIG);
    await app.request("/analytics/sector-grade-matrix", { headers: AUTH });
    expect(mockExec).toHaveBeenCalledTimes(1);
    const args = mockExec.mock.calls[0]?.[1] as string[];
    const sql = args[args.length - 1];
    expect(sql).toMatch(/FROM mv_sector_grade_matrix/);
  });

  it("falls back to live LEFT JOIN when mat-view is missing", async () => {
    // First call (mat-view) fails with relation-missing
    mockExec
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed"), {
          stderr: Buffer.from(
            'ERROR:  relation "mv_sector_grade_matrix" does not exist',
          ),
        });
      })
      .mockReturnValueOnce("null"); // second call (live) returns empty
    const app = createServer(CONFIG);
    await app.request("/analytics/sector-grade-matrix", { headers: AUTH });
    expect(mockExec).toHaveBeenCalledTimes(2);
    // Second call carries the live SQL with the LEFT JOIN that the
    // mat-view materializes. Pinning this SQL shape so the live fallback
    // never silently drifts away from the indexed sector_actividad_id path.
    const liveArgs = mockExec.mock.calls[1]?.[1] as string[];
    const liveSql = liveArgs[liveArgs.length - 1];
    expect(liveSql).toMatch(/LEFT JOIN coneval_irs_municipal/);
    expect(liveSql).toMatch(/sector_actividad_id/);
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
// isRelationMissingError + runJsonQueryMvFirst
// (audit P3-perf 2026-05-04: mat-view-first read with live-SQL fallback)
// ---------------------------------------------------------------------------

describe("isRelationMissingError", () => {
  it("matches the canonical 'relation X does not exist' phrase", () => {
    const err = new Error(
      'analytics query failed: Command failed | psql stderr: ERROR:  relation "mv_sector_grade_matrix" does not exist',
    );
    expect(isRelationMissingError(err)).toBe(true);
  });

  it("matches by SQLSTATE code 42P01 even without the phrase", () => {
    const err = new Error("postgres failed with code 42P01");
    expect(isRelationMissingError(err)).toBe(true);
  });

  it("inspects err.stderr Buffer when message is generic", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from(
        'ERROR:  relation "mv_national_treemap" does not exist\n',
      ),
    });
    expect(isRelationMissingError(err)).toBe(true);
  });

  it("inspects err.stderr string when message is generic", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: "ERROR:  relation does not exist\n",
    });
    expect(isRelationMissingError(err)).toBe(true);
  });

  it("returns false for unrelated errors (timeout, syntax, permission)", () => {
    expect(isRelationMissingError(new Error("ETIMEDOUT"))).toBe(false);
    expect(
      isRelationMissingError(new Error("syntax error at or near 'FROM'")),
    ).toBe(false);
    expect(
      isRelationMissingError(new Error("permission denied for table")),
    ).toBe(false);
  });

  it("returns false for non-Error throws", () => {
    expect(isRelationMissingError(undefined)).toBe(false);
    expect(isRelationMissingError(null)).toBe(false);
    expect(isRelationMissingError("string")).toBe(false);
  });
});

describe("runJsonQueryMvFirst", () => {
  beforeEach(() => mockExec.mockReset());

  const mvSql = "SELECT * FROM mv_x;";
  const liveSql = "WITH t AS (...) SELECT FROM t;";

  it("succeeds via mat-view (one psql call, live SQL untouched)", () => {
    mockExec.mockReturnValueOnce(JSON.stringify([{ scian: "46", count: 1 }]));
    const rows = runJsonQueryMvFirst<unknown[]>(CONFIG, mvSql, liveSql);
    expect(rows).toEqual([{ scian: "46", count: 1 }]);
    expect(mockExec).toHaveBeenCalledTimes(1);
    const args = mockExec.mock.calls[0]?.[1] as string[];
    expect(args[args.length - 1]).toBe(mvSql);
  });

  it("falls back to live SQL when mat-view is missing", () => {
    // First call (mat-view) throws relation-missing
    mockExec
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed"), {
          stderr: Buffer.from(
            'ERROR:  relation "mv_sector_grade_matrix" does not exist',
          ),
        });
      })
      // Second call (live SQL) returns the data
      .mockReturnValueOnce(JSON.stringify([{ scian: "46", count: 999 }]));

    const rows = runJsonQueryMvFirst<unknown[]>(CONFIG, mvSql, liveSql);
    expect(rows).toEqual([{ scian: "46", count: 999 }]);
    expect(mockExec).toHaveBeenCalledTimes(2);
    // Verify second call was the live SQL
    const liveCallArgs = mockExec.mock.calls[1]?.[1] as string[];
    expect(liveCallArgs[liveCallArgs.length - 1]).toBe(liveSql);
  });

  it("propagates non-relation errors without retrying", () => {
    mockExec.mockImplementationOnce(() => {
      throw Object.assign(new Error("Command failed"), {
        stderr: Buffer.from("ERROR:  syntax error at or near 'FROM'"),
      });
    });
    expect(() => runJsonQueryMvFirst(CONFIG, mvSql, liveSql)).toThrow();
    expect(mockExec).toHaveBeenCalledTimes(1);
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

// ---------------------------------------------------------------------------
// GET /analytics/risk-summary?entidad=NN[&ano=YYYY&baseline_ano=YYYY]
// ---------------------------------------------------------------------------

describe("GET /analytics/risk-summary", () => {
  it("returns per-municipio rows with current + baseline + per-1k normalization", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_mun: "09015",
          municipio: "Cuauhtémoc",
          poblacion: 545884,
          total_delitos: 31858,
          robo_negocio: 1205,
          homicidio_doloso: 71,
          extorsion: 194,
          patrimoniales: 18000,
          violentos: 850,
          total_baseline: 27971,
          delitos_per_1k_pop: 58.36,
          delitos_change_pct: 13.9,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-summary?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RiskSummaryResult;
    expect(body.entidad).toBe("09");
    expect(body.current_ano).toBe(2025);
    expect(body.baseline_ano).toBe(2020);
    expect(body.municipios).toHaveLength(1);
    expect(body.municipios[0]).toMatchObject({
      cve_mun: "09015",
      total_delitos: 31858,
      robo_negocio: 1205,
      delitos_per_1k_pop: 58.36,
      delitos_change_pct: 13.9,
    });
  });

  it("inlines the entidad + ano values verbatim into the SQL", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/risk-summary?entidad=14&ano=2024&baseline_ano=2019",
      { headers: AUTH },
    );
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/LEFT\(cve_mun, 2\) = '14'/);
    expect(sql).toMatch(/ano = 2024/);
    expect(sql).toMatch(/ano = 2019/);
    expect(sql).toMatch(/mv_delitos_municipal_yearly/);
  });

  it("rejects invalid entidad with 400 / validation.entidad", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-summary?entidad=99", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.entidad");
  });

  it("rejects invalid ano with 400 / validation.ano", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/risk-summary?entidad=09&ano=abcd",
      {
        headers: AUTH,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.ano");
  });

  it("rejects invalid baseline_ano with 400 / validation.baseline_ano", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/risk-summary?entidad=09&baseline_ano=99",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.baseline_ano");
  });

  it("requires X-Api-Key", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-summary?entidad=09");
    expect(res.status).toBe(401);
  });

  it("preserves null baseline / null per-1k when sources are missing", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_mun: "32018",
          municipio: "X",
          poblacion: null,
          total_delitos: 5,
          robo_negocio: 0,
          homicidio_doloso: 0,
          extorsion: 0,
          patrimoniales: 1,
          violentos: 0,
          total_baseline: null,
          delitos_per_1k_pop: null,
          delitos_change_pct: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-summary?entidad=32", {
      headers: AUTH,
    });
    const body = (await res.json()) as RiskSummaryResult;
    expect(body.municipios[0]).toMatchObject({
      poblacion: null,
      total_baseline: null,
      delitos_per_1k_pop: null,
      delitos_change_pct: null,
    });
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/risk-trend?cve_mun=NNNNN
// ---------------------------------------------------------------------------

describe("GET /analytics/risk-trend", () => {
  it("returns the monthly series + municipio metadata", async () => {
    mockExec
      .mockReturnValueOnce(
        JSON.stringify([
          {
            ano: 2025,
            mes: 1,
            robo_negocio: 100,
            homicidio_doloso: 6,
            extorsion: 12,
            total: 2451,
          },
          {
            ano: 2025,
            mes: 2,
            robo_negocio: 92,
            homicidio_doloso: 5,
            extorsion: 10,
            total: 2210,
          },
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify([{ municipio: "Cuauhtémoc", poblacion: 545884 }]),
      );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-trend?cve_mun=09015", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RiskTrendResult;
    expect(body.cve_mun).toBe("09015");
    expect(body.municipio).toBe("Cuauhtémoc");
    expect(body.poblacion).toBe(545884);
    expect(body.series).toHaveLength(2);
    expect(body.series[0]).toMatchObject({
      ano: 2025,
      mes: 1,
      robo_negocio: 100,
      total: 2451,
    });
  });

  it("inlines cve_mun verbatim and selects from the long-form table", async () => {
    mockExec.mockReturnValueOnce("[]").mockReturnValueOnce("[]");
    const app = createServer(CONFIG);
    await app.request("/analytics/risk-trend?cve_mun=14039", { headers: AUTH });
    const seriesArgs = mockExec.mock.calls[0]?.[1] as string[];
    const seriesSql = seriesArgs[seriesArgs.length - 1] ?? "";
    expect(seriesSql).toMatch(/cve_mun = '14039'/);
    expect(seriesSql).toMatch(/sesnsp_delitos_municipal\b/);
    expect(seriesSql).toMatch(/GROUP BY ano, mes/);
  });

  it("returns null municipio + poblacion when the cve_mun is unknown to censo", async () => {
    mockExec.mockReturnValueOnce("[]").mockReturnValueOnce("");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-trend?cve_mun=09015", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RiskTrendResult;
    expect(body.municipio).toBeNull();
    expect(body.poblacion).toBeNull();
    expect(body.series).toEqual([]);
  });

  it("rejects invalid cve_mun (non-digit) with 400 / validation.cve_mun", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-trend?cve_mun=foo", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.cve_mun");
  });

  it("rejects cve_mun with bad entidad prefix (e.g. 99XXX)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-trend?cve_mun=99001", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.cve_mun");
  });

  it("rejects cve_mun with wrong length", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-trend?cve_mun=0901", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("requires X-Api-Key", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-trend?cve_mun=09015");
    expect(res.status).toBe(401);
  });
});
