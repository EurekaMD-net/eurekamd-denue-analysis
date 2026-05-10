import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// `mockExec` doubles as the queue for both `execFileSync` (sync handlers) and
// `execFile` (async handlers via promisify). Tests seed responses via
// `mockExec.mockReturnValueOnce(stdout)` and the bridge below calls mockExec()
// from inside the async-callback path so the same FIFO queue drains both.
// Order in agebDetailHandler's Promise.all MUST match the queue order.
const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
const { mockExecAsync } = vi.hoisted(() => ({
  mockExecAsync: vi.fn(
    (
      file: string,
      args: string[],
      opts: unknown,
      cb: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      // Forward args to mockExec so tests reading `mockExec.mock.calls[N][1]`
      // can inspect the SQL passed via either sync or async path.
      try {
        const stdout = (
          mockExec as unknown as (f: string, a: string[], o: unknown) => unknown
        )(file, args, opts);
        cb(null, {
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: "",
        });
      } catch (err) {
        cb(err as Error, { stdout: "", stderr: "" });
      }
    },
  ),
}));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
  execFile: mockExecAsync,
}));

import { createServer } from "../server.js";
import {
  formatPsqlError,
  isRelationMissingError,
  resolveCurrentMortalityAno,
  resolveCurrentRiskAno,
  runJsonQueryMvFirst,
} from "./analytics.js";
import type {
  AgebDetailResult,
  AgebFarmaciaOpportunityResult,
  AgebsByMunicipioResult,
  AirportsByMunicipioResult,
  ApiServerConfig,
  ColoniasByAgebResult,
  ColoniasByMunicipioResult,
  EntidadDetailResult,
  LicensedPharmaciesByAgebResult,
  LicensedPharmaciesByMunicipioResult,
  LocalitiesByMunicipioResult,
  LocalityDetailResult,
  ManzanasByAgebResult,
  MortalitySummaryResult,
  MortalityTrendResult,
  MunicipioDetailResult,
  MunicipiosAnalyticsResult,
  NationalTreemapResult,
  OpportunityByAgebResult,
  OpportunityByColoniaResult,
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

  // Audit W1 (2026-05-05): the handler uses runJsonQueryMvFirst, so a missing
  // mv_delitos_municipal_yearly should silently fall back to the live SQL
  // path against sesnsp_delitos_municipal. Test pattern matches sector-grade-
  // matrix's symmetric fallback test.
  it("falls back to live SQL when mv_delitos_municipal_yearly is absent", async () => {
    mockExec
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed"), {
          stderr: Buffer.from(
            'ERROR:  relation "mv_delitos_municipal_yearly" does not exist',
          ),
        });
      })
      .mockReturnValueOnce(
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
    expect(body.municipios).toHaveLength(1);
    // Two psql calls: one MV attempt + one live fallback.
    expect(mockExec).toHaveBeenCalledTimes(2);
    const liveArgs = mockExec.mock.calls[1]?.[1] as string[];
    const liveSql = liveArgs[liveArgs.length - 1] ?? "";
    expect(liveSql).toMatch(/FROM sesnsp_delitos_municipal\b/);
    expect(liveSql).not.toMatch(/mv_delitos_municipal_yearly/);
  });

  // Audit W2 (2026-05-05): symmetric malformed-JSON coverage with the other
  // analytics endpoints. risk-summary goes through runJsonQueryMvFirst so the
  // first (mv) call is what malforms here.
  it("returns 502 with code postgres.parse_error on malformed psql output", async () => {
    mockExec.mockReturnValue("definitely not json");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-summary?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgres.parse_error");
  });

  // Audit W5 (2026-05-05) long-term fix: handler honors config.currentRiskAno
  // when set, so the risk-summary default ano follows the data instead of
  // a redeploy-coupled constant.
  it("uses config.currentRiskAno as the default when no ano arg is provided", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer({ ...CONFIG, currentRiskAno: 2026 });
    const res = await app.request("/analytics/risk-summary?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RiskSummaryResult;
    expect(body.current_ano).toBe(2026);
    // SQL composition should reflect the resolved year, not 2025.
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/ano = 2026/);
  });
});

// ---------------------------------------------------------------------------
// resolveCurrentRiskAno — runtime resolver for the latest reported year
// ---------------------------------------------------------------------------

describe("resolveCurrentRiskAno", () => {
  it("returns the latest fully-reported year (12 months) from SESNSP", () => {
    mockExec.mockReturnValueOnce(JSON.stringify([2025]));
    expect(resolveCurrentRiskAno(CONFIG)).toEqual({
      ano: 2025,
      source: "data",
    });
    expect(mockExec).toHaveBeenCalledTimes(1);
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/FROM sesnsp_delitos_municipal\b/);
    expect(sql).toMatch(/COUNT\(DISTINCT mes\) = 12/);
  });

  it("falls back on malformed output (DB error) — source=fallback", () => {
    // Drives runJsonQuery down the parse_error throw branch, which
    // tryResolveAno swallows. Avoids the vitest 4 throw-from-execFileSync
    // unhandled-exception quirk noted at the top of this file.
    mockExec.mockReturnValueOnce("not json at all");
    expect(resolveCurrentRiskAno(CONFIG)).toEqual({
      ano: 2025, // RISK_DEFAULT_CURRENT_ANO
      source: "fallback",
    });
  });

  it("falls back when no fully-reported year exists — source=fallback", () => {
    // [null] — when no year has 12 months reported (fresh DB or partial-only).
    mockExec.mockReturnValueOnce(JSON.stringify([null]));
    expect(resolveCurrentRiskAno(CONFIG)).toEqual({
      ano: 2025,
      source: "fallback",
    });
  });

  it("rejects out-of-range years (corrupt data) and falls back", () => {
    // Defense: even if MAX(ano) returns 2099 due to a corrupt row, the
    // resolver bounds-checks the value to RISK_ANO_RE's range (2010-2039)
    // and falls through to the static constant.
    mockExec.mockReturnValueOnce(JSON.stringify([2099]));
    expect(resolveCurrentRiskAno(CONFIG)).toEqual({
      ano: 2025,
      source: "fallback",
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

  // Audit W3 (2026-05-05): inverse of the cve_mun-unknown-to-censo case —
  // the series query's stdout is empty/blank but the meta call succeeds with
  // a populated municipio. Exercises the runJsonQuery `null/empty → []` branch
  // for the FIRST call. Series should land as [], meta still parsed.
  it("returns empty series when the first psql call yields blank stdout", async () => {
    mockExec
      .mockReturnValueOnce("   ")
      .mockReturnValueOnce(
        JSON.stringify([{ municipio: "Cuauhtémoc", poblacion: 545884 }]),
      );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-trend?cve_mun=09015", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RiskTrendResult;
    expect(body.series).toEqual([]);
    expect(body.municipio).toBe("Cuauhtémoc");
  });

  // Audit W2 (2026-05-05): symmetric malformed-JSON coverage. Series-call
  // path returning unparseable text should produce 502 / postgres.parse_error.
  it("returns 502 with code postgres.parse_error on malformed psql output", async () => {
    mockExec.mockReturnValue("definitely not json");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/risk-trend?cve_mun=09015", {
      headers: AUTH,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgres.parse_error");
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/mortality-summary?entidad=NN[&ano=YYYY] — v0.2.3-A
// ---------------------------------------------------------------------------

describe("GET /analytics/mortality-summary", () => {
  it("returns per-municipio rows with cause breakdown + per-1k normalization", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_mun: "09007",
          municipio: "Iztapalapa",
          poblacion: 1835486,
          total_defunciones: 12121,
          def_menores_1ano: 208,
          def_circulatorio: 3350,
          def_neoplasias: 1744,
          def_endocrinas: 2053,
          def_externas: 835,
          tasa_mortalidad_per_1k: 6.6,
          tasa_infantil_per_1k: 0.11,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-summary?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MortalitySummaryResult;
    expect(body.entidad).toBe("09");
    expect(body.current_ano).toBe(2024);
    expect(body.municipios).toHaveLength(1);
    expect(body.municipios[0]).toMatchObject({
      cve_mun: "09007",
      total_defunciones: 12121,
      def_circulatorio: 3350,
      tasa_mortalidad_per_1k: 6.6,
    });
  });

  it("inlines entidad + ano into the SQL and reads the mat-view", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request("/analytics/mortality-summary?entidad=14&ano=2023", {
      headers: AUTH,
    });
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/LEFT\(m\.cve_mun, 2\) = '14'/);
    expect(sql).toMatch(/m\.ano = 2023/);
    expect(sql).toMatch(/mv_mortalidad_municipal_yearly/);
  });

  it("rejects invalid entidad with 400 / validation.entidad", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-summary?entidad=99", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.entidad");
  });

  it("rejects invalid ano with 400 / validation.ano", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/mortality-summary?entidad=09&ano=foo",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.ano");
  });

  it("requires X-Api-Key", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-summary?entidad=09");
    expect(res.status).toBe(401);
  });

  it("uses config.currentMortalityAno as default when no ano arg provided", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer({ ...CONFIG, currentMortalityAno: 2025 });
    const res = await app.request("/analytics/mortality-summary?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MortalitySummaryResult;
    expect(body.current_ano).toBe(2025);
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/m\.ano = 2025/);
  });

  it("preserves null poblacion / null tasas when source is missing", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_mun: "32018",
          municipio: "X",
          poblacion: null,
          total_defunciones: 5,
          def_menores_1ano: 0,
          def_circulatorio: 1,
          def_neoplasias: 0,
          def_endocrinas: 1,
          def_externas: 0,
          tasa_mortalidad_per_1k: null,
          tasa_infantil_per_1k: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-summary?entidad=32", {
      headers: AUTH,
    });
    const body = (await res.json()) as MortalitySummaryResult;
    expect(body.municipios[0]).toMatchObject({
      poblacion: null,
      tasa_mortalidad_per_1k: null,
      tasa_infantil_per_1k: null,
    });
  });

  it("falls back to live SQL when mv_mortalidad_municipal_yearly is absent", async () => {
    mockExec
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed"), {
          stderr: Buffer.from(
            'ERROR:  relation "mv_mortalidad_municipal_yearly" does not exist',
          ),
        });
      })
      .mockReturnValueOnce(
        JSON.stringify([
          {
            cve_mun: "09007",
            municipio: "Iztapalapa",
            poblacion: 1835486,
            total_defunciones: 12121,
            def_menores_1ano: 208,
            def_circulatorio: 3350,
            def_neoplasias: 1744,
            def_endocrinas: 2053,
            def_externas: 835,
            tasa_mortalidad_per_1k: 6.6,
            tasa_infantil_per_1k: 0.11,
          },
        ]),
      );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-summary?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MortalitySummaryResult;
    expect(body.municipios).toHaveLength(1);
    expect(mockExec).toHaveBeenCalledTimes(2);
    const liveArgs = mockExec.mock.calls[1]?.[1] as string[];
    const liveSql = liveArgs[liveArgs.length - 1] ?? "";
    expect(liveSql).toMatch(/FROM inegi_edr_defunciones_raw\b/);
    expect(liveSql).not.toMatch(/mv_mortalidad_municipal_yearly/);
    // Audit W3 (2026-05-05): pin the live SQL's filter shape so future
    // edits can't drift from the mat-view's FILTER aggregation. If these
    // diverge, the fallback path returns different numbers than the
    // mat-view path — the worst kind of bug because both 200.
    expect(liveSql).toMatch(/ent_resid = '09'/);
    expect(liveSql).toMatch(/NULLIF\(capitulo, ''\)::int = 9/);
    expect(liveSql).toMatch(/NULLIF\(capitulo, ''\)::int = 2/);
    expect(liveSql).toMatch(/NULLIF\(capitulo, ''\)::int = 4/);
    expect(liveSql).toMatch(/NULLIF\(capitulo, ''\)::int = 20/);
    expect(liveSql).toMatch(/LEFT\(edad, 1\) IN \('1','2','3'\)/);
  });

  it("returns 502 with code postgres.parse_error on malformed psql output", async () => {
    mockExec.mockReturnValue("definitely not json");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-summary?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgres.parse_error");
  });

  it("sets long Cache-Control + Vary on success", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-summary?entidad=09", {
      headers: AUTH,
    });
    expect(res.headers.get("cache-control")).toMatch(/max-age=3600/);
    expect(res.headers.get("vary")).toMatch(/X-Api-Key/i);
  });
});

// ---------------------------------------------------------------------------
// resolveCurrentMortalityAno — runtime resolver (v0.2.3-A)
// ---------------------------------------------------------------------------

describe("resolveCurrentMortalityAno", () => {
  it("returns the latest year with >= 100k registered deaths", () => {
    mockExec.mockReturnValueOnce(JSON.stringify([2024]));
    expect(resolveCurrentMortalityAno(CONFIG)).toEqual({
      ano: 2024,
      source: "data",
    });
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/FROM inegi_edr_defunciones_raw\b/);
    expect(sql).toMatch(/HAVING COUNT\(\*\) >= 100000/);
  });

  it("falls back on malformed output — source=fallback", () => {
    mockExec.mockReturnValueOnce("not json");
    expect(resolveCurrentMortalityAno(CONFIG)).toEqual({
      ano: 2024, // MORTALITY_DEFAULT_CURRENT_ANO
      source: "fallback",
    });
  });

  it("falls back when no primary year exists yet — source=fallback", () => {
    mockExec.mockReturnValueOnce(JSON.stringify([null]));
    expect(resolveCurrentMortalityAno(CONFIG)).toEqual({
      ano: 2024,
      source: "fallback",
    });
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/mortality-trend?cve_mun=NNNNN — v0.2.3-A
// ---------------------------------------------------------------------------

describe("GET /analytics/mortality-trend", () => {
  it("returns annual series + municipio metadata", async () => {
    mockExec
      .mockReturnValueOnce(
        JSON.stringify([
          {
            ano: 2024,
            total_defunciones: 12121,
            def_menores_1ano: 208,
            def_circulatorio: 3350,
            def_neoplasias: 1744,
            def_endocrinas: 2053,
            def_externas: 835,
          },
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify([{ municipio: "Iztapalapa", poblacion: 1835486 }]),
      );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-trend?cve_mun=09007", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MortalityTrendResult;
    expect(body.cve_mun).toBe("09007");
    expect(body.municipio).toBe("Iztapalapa");
    expect(body.poblacion).toBe(1835486);
    expect(body.series).toHaveLength(1);
    expect(body.series[0]).toMatchObject({
      ano: 2024,
      total_defunciones: 12121,
      def_circulatorio: 3350,
    });
  });

  it("inlines cve_mun verbatim into the SQL", async () => {
    // Series mat-view call → "[]" (success, empty); meta call → empty array.
    mockExec.mockReturnValueOnce("[]").mockReturnValueOnce("[]");
    const app = createServer(CONFIG);
    await app.request("/analytics/mortality-trend?cve_mun=14039", {
      headers: AUTH,
    });
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/cve_mun = '14039'/);
    expect(sql).toMatch(/mv_mortalidad_municipal_yearly/);
  });

  it("rejects invalid cve_mun with 400 / validation.cve_mun", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/mortality-trend?cve_mun=not-a-key",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.cve_mun");
  });

  it("rejects out-of-range entidad in cve_mun (33...) with 400", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-trend?cve_mun=33001", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("rejects 4-digit cve_mun with 400", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-trend?cve_mun=0900", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("requires X-Api-Key", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-trend?cve_mun=09007");
    expect(res.status).toBe(401);
  });

  it("returns empty series when the municipio has no rows yet", async () => {
    mockExec
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce(
        JSON.stringify([{ municipio: "X", poblacion: 100 }]),
      );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-trend?cve_mun=32058", {
      headers: AUTH,
    });
    const body = (await res.json()) as MortalityTrendResult;
    expect(body.series).toEqual([]);
    expect(body.municipio).toBe("X");
  });

  it("returns 502 with code postgres.parse_error on malformed psql output", async () => {
    mockExec.mockReturnValue("definitely not json");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-trend?cve_mun=09007", {
      headers: AUTH,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgres.parse_error");
  });

  // Audit C2 (2026-05-05): trend now uses runJsonQueryMvFirst with a live
  // aggregation fallback against inegi_edr_defunciones_raw. Mirrors the
  // mortality-summary M1 fallback test.
  it("falls back to live SQL when mv_mortalidad_municipal_yearly is absent", async () => {
    mockExec
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed"), {
          stderr: Buffer.from(
            'ERROR:  relation "mv_mortalidad_municipal_yearly" does not exist',
          ),
        });
      })
      .mockReturnValueOnce(
        JSON.stringify([
          {
            ano: 2024,
            total_defunciones: 12121,
            def_menores_1ano: 208,
            def_circulatorio: 3350,
            def_neoplasias: 1744,
            def_endocrinas: 2053,
            def_externas: 835,
          },
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify([{ municipio: "Iztapalapa", poblacion: 1835486 }]),
      );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/mortality-trend?cve_mun=09007", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MortalityTrendResult;
    expect(body.series).toHaveLength(1);
    // First call (mat-view) threw; second (live) succeeded; third (meta).
    expect(mockExec).toHaveBeenCalledTimes(3);
    const liveArgs = mockExec.mock.calls[1]?.[1] as string[];
    const liveSql = liveArgs[liveArgs.length - 1] ?? "";
    expect(liveSql).toMatch(/FROM inegi_edr_defunciones_raw\b/);
    expect(liveSql).toMatch(/ent_resid = '09'/);
    expect(liveSql).toMatch(/mun_resid = '007'/);
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/state-calibrators?entidad=NN — v0.2.3-C
// ---------------------------------------------------------------------------

describe("GET /analytics/state-calibrators", () => {
  it("returns merged ENIGH + ENOE for the requested entidad", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          entidad: "19",
          // ENIGH (annual household)
          enigh_ano: 2024,
          hogares_estimados: "1859166",
          poblacion_estimada: "6129347",
          ingreso_corriente_promedio: "117033.88",
          ingreso_corriente_mediana: "83057.47",
          decil_1_ingreso: "36579.55",
          decil_9_ingreso: "197162.73",
          gasto_corriente_promedio: "59192.24",
          pct_gasto_alimentos: "34.73",
          pct_gasto_vivienda: "10.81",
          pct_gasto_salud: "3.5",
          pct_gasto_transporte: "12.4",
          pct_gasto_educacion: "5.1",
          // ENOE (quarterly labor force, year-averaged)
          enoe_ano: 2025,
          enoe_trimestres_cargados: 4,
          poblacion_15_mas: "4912779",
          pea: "3016206",
          ocupada: "2930863",
          desocupada: "87433",
          informal: "1000804",
          tasa_participacion: "61.40",
          tasa_desocupacion: "2.90",
          tasa_informalidad: "34.15",
          ingreso_promedio_mensual_ocupado: "14174.12",
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/state-calibrators?entidad=19", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entidad: string;
      calibrators: Record<string, number | null>;
    };
    expect(body.entidad).toBe("19");
    expect(body.calibrators).toMatchObject({
      entidad: "19",
      // ENIGH side
      enigh_ano: 2024,
      hogares_estimados: 1859166,
      ingreso_corriente_promedio: 117033.88,
      decil_1_ingreso: 36579.55,
      pct_gasto_alimentos: 34.73,
      // ENOE side
      enoe_ano: 2025,
      enoe_trimestres_cargados: 4,
      poblacion_15_mas: 4912779,
      tasa_informalidad: 34.15,
      tasa_desocupacion: 2.9,
      ingreso_promedio_mensual_ocupado: 14174.12,
    });
  });

  it("populates only the loaded side when one source is missing (ENOE-only)", async () => {
    // ENIGH columns null (LEFT JOIN miss); ENOE columns populated.
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          entidad: "07",
          enigh_ano: null,
          hogares_estimados: null,
          poblacion_estimada: null,
          ingreso_corriente_promedio: null,
          ingreso_corriente_mediana: null,
          decil_1_ingreso: null,
          decil_9_ingreso: null,
          gasto_corriente_promedio: null,
          pct_gasto_alimentos: null,
          pct_gasto_vivienda: null,
          pct_gasto_salud: null,
          pct_gasto_transporte: null,
          pct_gasto_educacion: null,
          enoe_ano: 2025,
          enoe_trimestres_cargados: 4,
          poblacion_15_mas: "4224762",
          pea: "2322868",
          ocupada: "2266164",
          desocupada: "56704",
          informal: "1741155",
          tasa_participacion: "54.98",
          tasa_desocupacion: "2.44",
          tasa_informalidad: "76.83",
          ingreso_promedio_mensual_ocupado: "6971.83",
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/state-calibrators?entidad=07", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entidad: string;
      calibrators: Record<string, number | null>;
    };
    expect(body.calibrators.enigh_ano).toBeNull();
    expect(body.calibrators.ingreso_corriente_promedio).toBeNull();
    expect(body.calibrators.enoe_ano).toBe(2025);
    expect(body.calibrators.tasa_informalidad).toBe(76.83);
  });

  it("returns the empty-shaped row when neither calibrator table exists", async () => {
    mockExec.mockImplementationOnce(() => {
      throw Object.assign(new Error("Command failed"), {
        stderr: Buffer.from(
          'ERROR:  relation "calibrators_enigh_state" does not exist',
        ),
      });
    });
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/state-calibrators?entidad=07", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entidad: string;
      calibrators: Record<string, number | null>;
    };
    expect(body.entidad).toBe("07");
    expect(body.calibrators.entidad).toBe("07");
    expect(body.calibrators.enigh_ano).toBeNull();
    expect(body.calibrators.ingreso_corriente_promedio).toBeNull();
    // ENOE side also nulled out by the empty-shape fallback.
    expect(body.calibrators.enoe_ano).toBeNull();
    expect(body.calibrators.tasa_informalidad).toBeNull();
  });

  it("returns the empty-shaped row when the entidad has no loaded data", async () => {
    // Empty json_agg → "[]" stdout → handler maps to empty-shape.
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/state-calibrators?entidad=32", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entidad: string;
      calibrators: Record<string, number | null>;
    };
    expect(body.calibrators.entidad).toBe("32");
    expect(body.calibrators.enigh_ano).toBeNull();
  });

  it("inlines entidad verbatim into both calibrator queries (LEFT JOIN shape)", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request("/analytics/state-calibrators?entidad=14", {
      headers: AUTH,
    });
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    // Both ENIGH and ENOE CTEs filter by the same entidad.
    expect(sql.match(/entidad = '14'/g)?.length).toBe(2);
    expect(sql).toMatch(/calibrators_enigh_state/);
    expect(sql).toMatch(/calibrators_enoe_state/);
    // Each CTE picks its own latest wave independently.
    expect(sql.match(/ORDER BY ano_levantamiento DESC/g)?.length).toBe(2);
    expect(sql.match(/LIMIT 1/g)?.length).toBe(2);
  });

  it("rejects invalid entidad with 400 / validation.entidad", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/state-calibrators?entidad=99", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.entidad");
  });

  it("rejects missing entidad with 400", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/state-calibrators", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("requires X-Api-Key", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/state-calibrators?entidad=09");
    expect(res.status).toBe(401);
  });

  it("propagates non-relation-missing errors as 502", async () => {
    // Malformed output (not the friendly 42P01 path) → 502 surfaces normally.
    mockExec.mockReturnValue("not json");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/state-calibrators?entidad=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgres.parse_error");
  });

  it("sets long Cache-Control + Vary on success", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/state-calibrators?entidad=09", {
      headers: AUTH,
    });
    expect(res.headers.get("cache-control")).toMatch(/max-age=3600/);
    expect(res.headers.get("vary")).toMatch(/X-Api-Key/i);
  });
});

// ---------------------------------------------------------------------------
// /analytics/agebs-by-municipio  (v0.2.4-A)
// ---------------------------------------------------------------------------

describe("GET /analytics/agebs-by-municipio", () => {
  it("rejects missing cve_mun", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/agebs-by-municipio", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects malformed cve_mun (not 5 digits)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/agebs-by-municipio?cve_mun=21X14",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects out-of-range entidad prefix (33xxx)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/agebs-by-municipio?cve_mun=33001",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown order_by", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/agebs-by-municipio?cve_mun=21114&order_by=hot",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects limit above AGEBS_MAX_LIMIT (200)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/agebs-by-municipio?cve_mun=21114&limit=201",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects negative or non-integer limit", async () => {
    const app = createServer(CONFIG);
    const r1 = await app.request(
      "/analytics/agebs-by-municipio?cve_mun=21114&limit=0",
      { headers: AUTH },
    );
    const r2 = await app.request(
      "/analytics/agebs-by-municipio?cve_mun=21114&limit=3.5",
      { headers: AUTH },
    );
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });

  it("returns AGEB list with full numeric coercion + default order_by", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cvegeo: "2111400010412",
          ambito: "Urbana",
          centroid_lat: "19.047480",
          centroid_lon: "-98.196916",
          area_km2: "0.6231",
          establecimientos: "3177",
          farmacias: "18",
          clues: "42",
        },
        {
          cvegeo: "2111400010408",
          ambito: "Urbana",
          centroid_lat: "19.05",
          centroid_lon: "-98.21",
          area_km2: "0.65",
          establecimientos: "2020",
          farmacias: "25",
          clues: "5",
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/agebs-by-municipio?cve_mun=21114",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgebsByMunicipioResult;
    expect(body.cve_mun).toBe("21114");
    expect(body.order_by).toBe("establecimientos");
    expect(body.total_returned).toBe(2);
    expect(body.agebs[0]).toMatchObject({
      cvegeo: "2111400010412",
      ambito: "Urbana",
      establecimientos: 3177,
      farmacias: 18,
      clues: 42,
    });
    expect(typeof body.agebs[0]?.centroid_lat).toBe("number");
    expect(typeof body.agebs[0]?.area_km2).toBe("number");
    expect(res.headers.get("cache-control")).toMatch(/max-age=3600/);
  });

  it("respects order_by=clues in the SQL ORDER BY", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/agebs-by-municipio?cve_mun=09007&order_by=clues",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("clues DESC");
    expect(sql).not.toContain("establecimientos DESC");
  });

  it("normalizes ambito enum (rejects unexpected values to null)", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cvegeo: "2111400010412",
          ambito: "Mixto",
          centroid_lat: null,
          centroid_lon: null,
          area_km2: null,
          establecimientos: 0,
          farmacias: 0,
          clues: 0,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/agebs-by-municipio?cve_mun=21114",
      { headers: AUTH },
    );
    const body = (await res.json()) as AgebsByMunicipioResult;
    expect(body.agebs[0]?.ambito).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /analytics/ageb-detail  (v0.2.4-A)
// ---------------------------------------------------------------------------

describe("GET /analytics/ageb-detail", () => {
  it("rejects missing cvegeo", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/ageb-detail", { headers: AUTH });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects cvegeo with wrong length or interior non-digit", async () => {
    const app = createServer(CONFIG);
    const r1 = await app.request(
      "/analytics/ageb-detail?cvegeo=21114000104120",
      { headers: AUTH },
    );
    // Letter at position 11 (interior) — only the LAST char may be letter.
    const r2 = await app.request(
      "/analytics/ageb-detail?cvegeo=2111400010X12",
      { headers: AUTH },
    );
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });

  it("rejects LOWERCASE letter suffix (INEGI's convention is uppercase only)", async () => {
    // CVEGEO_RE is case-sensitive on the suffix letter. A request with '086a'
    // must be rejected before any psql call so we don't waste a query on a
    // guaranteed-empty row.
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=211140001086a",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("ACCEPTS 9-char rural cvegeo (no locality component)", async () => {
    // 2026-05-06: 17,469 ageb_polygons rows are rural (cve_loc='0000') and
    // INEGI encodes them as 9-char (ENT+MUN+AGEB). 120,945 DENUE rows live
    // there. CVEGEO_RE was previously /^[0-9]{12}[0-9A-Z]$/ which rejected
    // rural at endpoint entry. Now /^([0-9]{12}[0-9A-Z]|[0-9]{8}[0-9A-Z])$/.
    // Regression test for the rural-acceptance contract.
    mockExec.mockReturnValueOnce(
      JSON.stringify([
        {
          cvegeo: "300280017",
          cve_ent: "30",
          cve_mun: "028",
          cve_loc: "0000",
          cve_ageb: "0017",
          ambito: "Rural",
          area_km2: "5.0",
          centroid_lat: "19.50",
          centroid_lon: "-96.00",
          bbox_minlon: null,
          bbox_minlat: null,
          bbox_maxlon: null,
          bbox_maxlat: null,
        },
      ]),
    );
    mockExec
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(
        JSON.stringify([{ total_establecimientos: 0, total_farmacias: 0 }]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([0]))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]));

    const app = createServer(CONFIG);
    const res = await app.request("/analytics/ageb-detail?cvegeo=300280017", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
  });

  it("ACCEPTS cvegeo with letter-suffix AGEB (INEGI assigns A-Z to ~9% of AGEBs)", async () => {
    // v0.2.4-B fix: 7,461 of 81,451 AGEBs have letter suffix at position 13
    // (e.g. 211140001086A — when AGEB 0010 was subdivided, daughter is 010A).
    // Original CVEGEO_RE = /^[0-9]{13}$/ rejected them all. New regex is
    // /^[0-9]{12}[0-9A-Z]$/. This test pins the relaxed acceptance.
    mockExec.mockReturnValueOnce(
      JSON.stringify([
        {
          cvegeo: "211140001086A",
          cve_ent: "21",
          cve_mun: "114",
          cve_loc: "0001",
          cve_ageb: "086A",
          ambito: "Urbana",
          area_km2: "0.5",
          centroid_lat: "19.05",
          centroid_lon: "-98.20",
          bbox_minlon: null,
          bbox_minlat: null,
          bbox_maxlon: null,
          bbox_maxlat: null,
        },
      ]),
    );
    mockExec
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(
        JSON.stringify([{ total_establecimientos: 0, total_farmacias: 0 }]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([0]))
      .mockReturnValueOnce(JSON.stringify([]))
      // v0.2.6: agebRezagoSql — letter-suffix AGEBs typically not in CONEVAL
      .mockReturnValueOnce(JSON.stringify([]));

    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=211140001086A",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 when AGEB not in ageb_polygons", async () => {
    mockExec.mockReturnValueOnce(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=9999999999999",
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
  });

  it("returns full breakdown with locality population proxy + top sectors", async () => {
    mockExec
      .mockReturnValueOnce(
        JSON.stringify([
          {
            cvegeo: "2111400010412",
            cve_ent: "21",
            cve_mun: "114",
            cve_loc: "0001",
            cve_ageb: "0412",
            ambito: "Urbana",
            area_km2: "0.6231",
            centroid_lat: "19.047480",
            centroid_lon: "-98.196916",
            bbox_minlon: "-98.20",
            bbox_minlat: "19.04",
            bbox_maxlon: "-98.19",
            bbox_maxlat: "19.05",
          },
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify([
          { loc_population: "1542232", loc_name: "Heroica Puebla de Zaragoza" },
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify([
          { total_establecimientos: "3177", total_farmacias: "18" },
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify([
          { scian2: "46", count: "1200" },
          { scian2: "72", count: "300" },
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify([
          {
            clues: "PLSSA001234",
            nombre: "Hospital Regional",
            tipo: "HOSPITAL GENERAL",
            lat: "19.047",
            lon: "-98.197",
          },
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([42]))
      .mockReturnValueOnce(
        JSON.stringify([
          {
            pobtot: "2175",
            pobfem: "1130",
            pobmas: "1045",
            p_60ymas: "354",
            p_15ymas: "1794",
            p_18ymas: "1683",
            pea: "1042",
            pocupada: "1010",
            graproes: "11.5",
            tvivhab: "650",
            tvivpar: "640",
            vph_inter: "458",
            vph_autom: "128",
          },
        ]),
      )
      // v0.2.6: agebRezagoSql — Puebla centro AGEB has Bajo grado
      .mockReturnValueOnce(
        JSON.stringify([
          {
            grado: "Bajo",
            pobtot: "2175",
            vivpar_hab: "640",
            ind_analfabeta: "1.2",
            ind_no_escuela_6_14: "0.5",
            ind_no_escuela_15_24: "10.1",
            ind_basica_incompleta: "12.3",
            ind_sin_salud: "20.4",
            ind_hacinamiento: "1.0",
            ind_sin_agua: "0",
            ind_sin_excusado: "0",
            ind_sin_drenaje: "0",
            ind_sin_luz: "0",
            ind_piso_tierra: "0",
            ind_sin_lavadora: "5.2",
            ind_sin_refri: "1.1",
            ind_sin_telfijo: "32.0",
            ind_sin_celular: "2.1",
            ind_sin_compu: "30.5",
            ind_sin_internet: "18.7",
          },
        ]),
      );

    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=2111400010412",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgebDetailResult;
    expect(body.cvegeo).toBe("2111400010412");
    expect(body.cve_ent).toBe("21");
    expect(body.cve_mun).toBe("114");
    expect(body.cve_loc).toBe("0001");
    expect(body.cve_ageb).toBe("0412");
    expect(body.ambito).toBe("Urbana");
    expect(body.area_km2).toBe(0.6231);
    expect(body.bbox).toEqual([-98.2, 19.04, -98.19, 19.05]);
    expect(body.loc_population).toBe(1542232);
    expect(body.loc_name).toBe("Heroica Puebla de Zaragoza");
    expect(body.total_establecimientos).toBe(3177);
    expect(body.total_farmacias).toBe(18);
    expect(body.top_sectors).toHaveLength(2);
    expect(body.top_sectors[0]?.scian2).toBe("46");
    expect(typeof body.top_sectors[0]?.nombre).toBe("string");
    expect(body.top_sectors[0]?.count).toBe(1200);
    expect(body.clues_count).toBe(42);
    expect(body.clues_sample).toHaveLength(1);
    expect(body.clues_sample[0]?.clues).toBe("PLSSA001234");
    // v0.2.4-B: AGEB-level census fields
    expect(body.population).toBe(2175);
    expect(body.census).toMatchObject({
      pobtot: 2175,
      pobfem: 1130,
      pobmas: 1045,
      p_60ymas: 354,
      vph_inter: 458,
      vph_autom: 128,
    });
    expect(body.census?.graproes).toBe(11.5);
  });

  it("returns null AGEB census fields when AGEB is rural / not in censo_ageb", async () => {
    // Identity + locality found, but censo_ageb empty → census stays null,
    // population stays null, loc_population fallback is unaffected.
    mockExec
      .mockReturnValueOnce(
        JSON.stringify([
          {
            cvegeo: "1099900020001",
            cve_ent: "10",
            cve_mun: "999",
            cve_loc: "0002",
            cve_ageb: "0001",
            ambito: "Rural",
            area_km2: "5.0",
            centroid_lat: "23.5",
            centroid_lon: "-104.0",
            bbox_minlon: null,
            bbox_minlat: null,
            bbox_maxlon: null,
            bbox_maxlat: null,
          },
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify([{ loc_population: "120", loc_name: "El Rancho" }]),
      )
      .mockReturnValueOnce(
        JSON.stringify([{ total_establecimientos: 0, total_farmacias: 0 }]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([0]))
      .mockReturnValueOnce(JSON.stringify([]))
      // v0.2.6: agebRezagoSql — rural AGEB has no CONEVAL row
      .mockReturnValueOnce(JSON.stringify([]));

    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=1099900020001",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgebDetailResult;
    expect(body.population).toBeNull();
    expect(body.census).toBeNull();
    expect(body.loc_population).toBe(120);
    expect(body.ambito).toBe("Rural");
  });

  it("splits cvegeo into entidad/mun/loc chunks for locality lookup SQL", async () => {
    mockExec
      .mockReturnValueOnce(
        JSON.stringify([
          {
            cvegeo: "0900700010001",
            cve_ent: "09",
            cve_mun: "007",
            cve_loc: "0001",
            cve_ageb: "0001",
            ambito: "Urbana",
            area_km2: "1.0",
            centroid_lat: "19.4",
            centroid_lon: "-99.1",
            bbox_minlon: null,
            bbox_minlat: null,
            bbox_maxlon: null,
            bbox_maxlat: null,
          },
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(
        JSON.stringify([{ total_establecimientos: 0, total_farmacias: 0 }]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([0]))
      .mockReturnValueOnce(JSON.stringify([]))
      // v0.2.6: agebRezagoSql
      .mockReturnValueOnce(JSON.stringify([]));

    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=0900700010001",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const args = mockExec.mock.calls[1]?.[1] as string[] | undefined;
    const locSql = args?.[args.length - 1];
    expect(locSql).toContain("entidad = '09'");
    expect(locSql).toContain("mun = '007'");
    expect(locSql).toContain("loc = '0001'");
  });
});

// ---------------------------------------------------------------------------
// /analytics/ageb-farmacia-opportunity  (v0.2.4-A)
// ---------------------------------------------------------------------------

describe("GET /analytics/ageb-farmacia-opportunity", () => {
  it("rejects missing cve_mun", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/ageb-farmacia-opportunity", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects limit above AGEB_FARMACIA_MAX_LIMIT (100)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-farmacia-opportunity?cve_mun=09007&limit=101",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns ranked AGEBs with score + numeric coercion + v0.2.4-B population/score_per_1k", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cvegeo: "0900700015214",
          ambito: "Urbana",
          centroid_lat: "19.36",
          centroid_lon: "-99.07",
          area_km2: "0.34",
          num_establecimientos: "180",
          num_farmacias: "0",
          num_clues: "8",
          population: "1500",
          score: "58.0",
          // 58 / 1500 * 1000 = 38.667
          score_per_1k: "38.667",
        },
        {
          cvegeo: "0900700015301",
          ambito: "Urbana",
          centroid_lat: null,
          centroid_lon: null,
          area_km2: "0.42",
          num_establecimientos: "120",
          num_farmacias: "1",
          num_clues: "3",
          population: null, // rural / not in censo_ageb
          score: "36.5",
          score_per_1k: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-farmacia-opportunity?cve_mun=09007",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgebFarmaciaOpportunityResult;
    expect(body.cve_mun).toBe("09007");
    expect(body.total_returned).toBe(2);
    expect(body.agebs[0]).toMatchObject({
      cvegeo: "0900700015214",
      num_establecimientos: 180,
      num_farmacias: 0,
      num_clues: 8,
      score: 58,
      population: 1500,
      score_per_1k: 38.667,
    });
    expect(body.agebs[1]?.score).toBe(36.5);
    expect(body.agebs[1]?.centroid_lat).toBeNull();
    expect(body.agebs[1]?.population).toBeNull();
    expect(body.agebs[1]?.score_per_1k).toBeNull();
    expect(res.headers.get("cache-control")).toMatch(/max-age=3600/);
  });

  it("emits LEFT JOIN to censo_ageb for population (v0.2.4-B)", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request("/analytics/ageb-farmacia-opportunity?cve_mun=21114", {
      headers: AUTH,
    });
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("LEFT JOIN censo_ageb cab");
    expect(sql).toContain("cab.pobtot");
    // score_per_1k uses CASE to null-guard when population is null/0
    expect(sql).toMatch(
      /WHEN cab\.pobtot IS NULL OR cab\.pobtot = 0 THEN NULL/,
    );
  });

  it("emits the score formula in the SQL ORDER BY", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/ageb-farmacia-opportunity?cve_mun=21114&limit=5",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toMatch(/COALESCE\(s\.cnt, 0\) \* 0\.5/);
    expect(sql).toMatch(/COALESCE\(e\.cnt, 0\) \* 0\.3/);
    expect(sql).toMatch(/COALESCE\(f\.cnt, 0\) \* 1\.0/);
    expect(sql).toContain("LIMIT 5");
  });

  it("uses the RAW score expression in json_agg ORDER BY (qa-audit W1)", async () => {
    // Lock: both the inner ORDER BY and the json_agg ORDER BY use the raw
    // num_clues * 0.5 + num_establecimientos * 0.3 - num_farmacias * 1.0
    // expression, NOT the rounded `t.score` field. Otherwise rows tied at
    // the 3-decimal rounded score get reordered between the two passes.
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request("/analytics/ageb-farmacia-opportunity?cve_mun=21114", {
      headers: AUTH,
    });
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toMatch(
      /json_agg\(row_to_json\(t\) ORDER BY \(\s*t\.num_clues \* 0\.5/,
    );
    expect(sql).not.toMatch(/json_agg\(row_to_json\(t\) ORDER BY t\.score/);
  });
});

// ---------------------------------------------------------------------------
// SQL-injection contract — pre-validation gates block adversarial input
// before any docker exec call. Same pattern as ENTIDAD_RE / RISK_ANO_RE
// elsewhere in this file. (qa-audit R1)
// ---------------------------------------------------------------------------

describe("AGEB endpoints — SQL-injection contract", () => {
  it("agebs-by-municipio rejects ';DROP--' adversarial cve_mun without invoking psql", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/agebs-by-municipio?cve_mun=" +
        encodeURIComponent("21114';DROP TABLE establecimientos;--"),
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("ageb-detail rejects 13-char string with non-digits without invoking psql", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=" + encodeURIComponent("11111';--ABCDE"),
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("ageb-farmacia-opportunity rejects float limit without invoking psql", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-farmacia-opportunity?cve_mun=21114&limit=" +
        encodeURIComponent("10);DROP TABLE--"),
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  // v0.2.9 endpoints carry the same contract — qa-audit W1 closure.
  it("manzanas-by-ageb rejects adversarial cvegeo without invoking psql", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/manzanas-by-ageb?cvegeo=" +
        encodeURIComponent("0900700012475';DROP TABLE censo_manzana;--"),
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("manzanas-by-ageb rejects adversarial order_by without invoking psql", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/manzanas-by-ageb?cvegeo=0900700012475&order_by=" +
        encodeURIComponent("pobtot;DROP--"),
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("colonias-by-ageb rejects adversarial cvegeo without invoking psql", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/colonias-by-ageb?cvegeo=" +
        encodeURIComponent("0900700012475';--XXXX"),
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// v0.2.5 — vertical-agnostic opportunity engine
// ---------------------------------------------------------------------------

describe("GET /analytics/opportunity-by-ageb (v0.2.5)", () => {
  it("rejects missing target_scian", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects missing cve_mun even if target_scian is set", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?target_scian=464111",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects mixed-length target_scian (3 + 6 digits)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=461,464111",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/misma longitud/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects more than 10 SCIAN codes", async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) =>
      String(46_4111 + i),
    ).join(",");
    const app = createServer(CONFIG);
    const res = await app.request(
      `/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=${tooMany}`,
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects target_scian with letters or spaces (SQL-injection guard)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=" +
        encodeURIComponent("464111';--"),
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects bad order_by", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=464111&order_by=banana",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("dispatches 6-digit code to clase_actividad_id column", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=464111,464112",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("clase_actividad_id IN ('464111','464112')");
    // Defensive: must NOT mention the wrong column
    expect(sql).not.toContain("sector_actividad_id IN");
  });

  it("dispatches 2-digit code to sector_actividad_id column", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=46",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("sector_actividad_id IN ('46')");
  });

  it("dispatches 3-digit code to subsector_actividad_id column", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=464",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("subsector_actividad_id IN ('464')");
  });

  it("dispatches 4-digit code to rama_actividad_id column", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=4641",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("rama_actividad_id IN ('4641')");
  });

  it("dispatches 5-digit code to subrama_actividad_id column", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=46411",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("subrama_actividad_id IN ('46411')");
  });

  it("returns ranked AGEBs with score = pobtot / target_count + numeric coercion", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cvegeo: "0901400015214",
          ambito: "Urbana",
          centroid_lat: "19.36",
          centroid_lon: "-99.07",
          area_km2: "0.34",
          pobtot: "5000",
          target_count: "2",
          total_estab: "180",
          score: "2500.00",
        },
        {
          cvegeo: "0901400015301",
          ambito: "Urbana",
          centroid_lat: null,
          centroid_lon: null,
          area_km2: "0.42",
          pobtot: "3000",
          target_count: "0", // greenfield → score null
          total_estab: "120",
          score: null,
        },
        {
          cvegeo: "09014000153A1",
          ambito: "Rural",
          centroid_lat: "19.40",
          centroid_lon: "-99.10",
          area_km2: "1.20",
          pobtot: null, // not in censo_ageb urbana
          target_count: "1",
          total_estab: "5",
          score: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=464111,464112",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpportunityByAgebResult;
    expect(body.cve_mun).toBe("09014");
    expect(body.scian_level).toBe("clase");
    expect(body.target_scian).toEqual(["464111", "464112"]);
    expect(body.order_by).toBe("score");
    expect(body.total_returned).toBe(3);
    expect(body.agebs[0]).toMatchObject({
      cvegeo: "0901400015214",
      pobtot: 5000,
      target_count: 2,
      total_estab: 180,
      score: 2500,
    });
    expect(body.agebs[1].score).toBeNull();
    expect(body.agebs[1].target_count).toBe(0);
    expect(body.agebs[2].pobtot).toBeNull();
    expect(body.agebs[2].score).toBeNull();
  });

  it("respects limit cap (101 → 400)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=464111&limit=101",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("emits LEFT JOIN to censo_ageb (population denominator)", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09014&target_scian=464111",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("LEFT JOIN censo_ageb cab");
    expect(sql).toContain("cab.pobtot");
    expect(sql).toMatch(/CASE\s+WHEN cab\.pobtot IS NULL OR cab\.pobtot = 0/);
    expect(sql).toMatch(/WHEN COALESCE\(t\.cnt, 0\) = 0 THEN NULL/);
  });
});

describe("GET /analytics/opportunity-by-colonia (v0.2.5)", () => {
  it("rejects missing target_scian", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-colonia?cve_mun=09014",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("uses r.-qualified column refs in outer json_agg ORDER BY (production-bug regression)", async () => {
    // 2026-05-05 production hit: unqualified `total_estab` / `target_count`
    // in the OUTER json_agg ORDER BY ran against the subquery alias `r` and
    // Postgres failed with "column total_estab does not exist". Unit tests
    // mocked psql output so they passed. Lock the qualifier for every
    // order_by branch that references a derived column.
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);

    for (const orderBy of [
      "score",
      "target_count",
      "total_estab",
      "colonia",
    ] as const) {
      mockExec.mockClear();
      mockExec.mockReturnValue(JSON.stringify([]));
      await app.request(
        `/analytics/opportunity-by-colonia?cve_mun=09014&target_scian=464111&order_by=${orderBy}`,
        { headers: AUTH },
      );
      const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
      const sql = args?.[args.length - 1] ?? "";
      // Extract the line carrying the OUTER json_agg ORDER BY clause.
      const outerLine = sql
        .split("\n")
        .find((line) => line.includes("json_agg(row_to_json(r) ORDER BY"));
      expect(outerLine, `order_by=${orderBy}`).toBeDefined();
      if (orderBy === "score") {
        expect(outerLine).toContain("r.total_estab");
        expect(outerLine).toContain("r.target_count");
      } else {
        expect(outerLine).toContain(`r.${orderBy}`);
      }
    }
  });

  it("normalizes colonia case via UPPER+TRIM in SQL (collapse spelling drift)", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/opportunity-by-colonia?cve_mun=09014&target_scian=464111",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("UPPER(TRIM(colonia))");
    expect(sql).toContain("GROUP BY UPPER(TRIM(colonia))");
    // Excludes empty/null colonia rows
    expect(sql).toContain("colonia IS NOT NULL");
    expect(sql).toContain("TRIM(colonia) != ''");
  });

  it("returns top colonias with score = total_estab / target_count + null on greenfield", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          colonia: "ROMA NORTE",
          target_count: "3",
          total_estab: "250",
          score: "83.33",
        },
        {
          colonia: "POLANCO",
          target_count: "0", // greenfield
          total_estab: "180",
          score: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-colonia?cve_mun=09014&target_scian=464111&order_by=score",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpportunityByColoniaResult;
    expect(body.cve_mun).toBe("09014");
    expect(body.scian_level).toBe("clase");
    expect(body.total_returned).toBe(2);
    expect(body.colonias[0]).toMatchObject({
      colonia: "ROMA NORTE",
      target_count: 3,
      total_estab: 250,
      score: 83.33,
    });
    expect(body.colonias[1].score).toBeNull();
    expect(body.colonias[1].target_count).toBe(0);
  });

  it("filters out null-colonia rows from the response (DB hygiene)", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          colonia: "CENTRO",
          target_count: "2",
          total_estab: "60",
          score: "30",
        },
        // a row with null colonia shouldn't reach this layer (SQL excludes
        // them) but if it did we'd drop it instead of crashing
        { colonia: null, target_count: "1", total_estab: "10", score: "10" },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-colonia?cve_mun=09014&target_scian=464111",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpportunityByColoniaResult;
    expect(body.total_returned).toBe(1);
    expect(body.colonias).toHaveLength(1);
    expect(body.colonias[0].colonia).toBe("CENTRO");
  });

  it("respects MAX_LIMIT cap (201 → 400)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-colonia?cve_mun=09014&target_scian=464111&limit=201",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("GET /analytics/colonias-by-municipio (v0.2.5)", () => {
  it("rejects missing cve_mun", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/colonias-by-municipio", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects bad order_by", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/colonias-by-municipio?cve_mun=09014&order_by=score",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns colonias sorted by num_establecimientos by default", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        { colonia: "DEL VALLE CENTRO", num_establecimientos: "920" },
        { colonia: "ROMA NORTE", num_establecimientos: "445" },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/colonias-by-municipio?cve_mun=09014",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ColoniasByMunicipioResult;
    expect(body.cve_mun).toBe("09014");
    expect(body.order_by).toBe("num_establecimientos");
    expect(body.total_returned).toBe(2);
    expect(body.colonias[0]).toMatchObject({
      colonia: "DEL VALLE CENTRO",
      num_establecimientos: 920,
    });
  });

  it("emits UPPER+TRIM in SQL for casing-fold + excludes null/empty colonia", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request("/analytics/colonias-by-municipio?cve_mun=09014", {
      headers: AUTH,
    });
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("UPPER(TRIM(colonia))");
    expect(sql).toContain("colonia IS NOT NULL");
    expect(sql).toContain("TRIM(colonia) != ''");
  });

  it("respects MAX_LIMIT cap (201 → 400)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/colonias-by-municipio?cve_mun=09014&limit=201",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// v0.2.6 — CONEVAL Grado de Rezago Social at AGEB
// ---------------------------------------------------------------------------

describe("GET /analytics/ageb-detail rezago_social field (v0.2.6)", () => {
  it("returns rezago_social with all 17 indicators when AGEB is in CONEVAL", async () => {
    mockExec
      .mockReturnValueOnce(
        JSON.stringify([
          {
            cvegeo: "0900700010017",
            cve_ent: "09",
            cve_mun: "007",
            cve_loc: "0001",
            cve_ageb: "0017",
            ambito: "Urbana",
            area_km2: "0.5",
            centroid_lat: "19.36",
            centroid_lon: "-99.07",
            bbox_minlon: null,
            bbox_minlat: null,
            bbox_maxlon: null,
            bbox_maxlat: null,
          },
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(
        JSON.stringify([{ total_establecimientos: 5, total_farmacias: 1 }]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([0]))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(
        JSON.stringify([
          {
            grado: "Bajo",
            pobtot: "5868",
            vivpar_hab: "1645",
            ind_analfabeta: "0.89",
            ind_no_escuela_6_14: "3.46",
            ind_no_escuela_15_24: "43.87",
            ind_basica_incompleta: "16.61",
            ind_sin_salud: "37.40",
            ind_hacinamiento: "2.92",
            ind_sin_agua: "0.12",
            ind_sin_excusado: "0.24",
            ind_sin_drenaje: "0.06",
            ind_sin_luz: "0.06",
            ind_piso_tierra: "0.30",
            ind_sin_lavadora: "17.09",
            ind_sin_refri: "5.96",
            ind_sin_telfijo: "33.09",
            ind_sin_celular: "7.18",
            ind_sin_compu: "44.89",
            ind_sin_internet: "25.97",
          },
        ]),
      );

    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=0900700010017",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgebDetailResult;
    expect(body.rezago_social).not.toBeNull();
    expect(body.rezago_social!.grado).toBe("Bajo");
    expect(body.rezago_social!.pobtot).toBe(5868);
    expect(body.rezago_social!.indicators.ind_analfabeta).toBeCloseTo(0.89, 2);
    expect(body.rezago_social!.indicators.ind_sin_internet).toBeCloseTo(
      25.97,
      2,
    );
  });

  it("returns rezago_social=null when AGEB not in CONEVAL (rural / post-2020)", async () => {
    mockExec
      .mockReturnValueOnce(
        JSON.stringify([
          {
            cvegeo: "1099900020001",
            cve_ent: "10",
            cve_mun: "999",
            cve_loc: "0002",
            cve_ageb: "0001",
            ambito: "Rural",
            area_km2: "5.0",
            centroid_lat: "23.5",
            centroid_lon: "-104.0",
            bbox_minlon: null,
            bbox_minlat: null,
            bbox_maxlon: null,
            bbox_maxlat: null,
          },
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(
        JSON.stringify([{ total_establecimientos: 0, total_farmacias: 0 }]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([0]))
      .mockReturnValueOnce(JSON.stringify([]))
      // v0.2.6 rezago: empty array — AGEB has no CONEVAL row
      .mockReturnValueOnce(JSON.stringify([]));

    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=1099900020001",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgebDetailResult;
    expect(body.rezago_social).toBeNull();
  });

  it("returns rezago_social=null when grado is not in the CONEVAL allowlist", async () => {
    // Defense in depth: even if a malformed row escapes the view filter, the
    // handler's isRezagoGrado() guard collapses unknown grados to null
    // rather than passing through an unsanctioned string.
    mockExec
      .mockReturnValueOnce(
        JSON.stringify([
          {
            cvegeo: "0900700010017",
            cve_ent: "09",
            cve_mun: "007",
            cve_loc: "0001",
            cve_ageb: "0017",
            ambito: "Urbana",
            area_km2: "0.5",
            centroid_lat: "19.36",
            centroid_lon: "-99.07",
            bbox_minlon: null,
            bbox_minlat: null,
            bbox_maxlon: null,
            bbox_maxlat: null,
          },
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(
        JSON.stringify([{ total_establecimientos: 1, total_farmacias: 0 }]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([0]))
      .mockReturnValueOnce(JSON.stringify([]))
      // Adversarial: garbage grado that should NOT pass to the response
      .mockReturnValueOnce(
        JSON.stringify([{ grado: "NOT_A_VALID_GRADO", pobtot: "100" }]),
      );

    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=0900700010017",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgebDetailResult;
    expect(body.rezago_social).toBeNull();
  });
});

describe("GET /analytics/opportunity-by-ageb rezago_grado filter (v0.2.6)", () => {
  it("rejects rezago_grado with invalid value (catches typos and SQL injection)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09007&target_scian=464111&rezago_grado=Banana",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects rezago_grado with adversarial payload (apostrophe SQL injection)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09007&target_scian=464111&rezago_grado=" +
        encodeURIComponent("Bajo';DROP TABLE--"),
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects duplicate rezago_grado entries", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09007&target_scian=464111&rezago_grado=Bajo,Bajo",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("accepts multi-valued rezago_grado (Alto + Muy alto)", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09007&target_scian=464111&rezago_grado=Alto,Muy%20alto",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpportunityByAgebResult;
    expect(body.rezago_grado_filter).toEqual(["Alto", "Muy alto"]);
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    expect(sql).toContain("LEFT JOIN coneval_grs_ageb cga");
    expect(sql).toContain("AND cga.grado IN ('Alto','Muy alto')");
  });

  it("LEFT JOINs coneval_grs_ageb even with no rezago_grado filter (surface grado)", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09007&target_scian=464111",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1];
    // JOIN must always be present so cga.grado projects into the row
    expect(sql).toContain("LEFT JOIN coneval_grs_ageb cga");
    expect(sql).toContain("cga.grado AS rezago_grado");
    // No filter clause when the param is absent
    expect(sql).not.toContain("AND cga.grado IN");
  });

  it("returns rezago_grado_filter=[] when param absent", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09007&target_scian=464111",
      { headers: AUTH },
    );
    const body = (await res.json()) as OpportunityByAgebResult;
    expect(body.rezago_grado_filter).toEqual([]);
  });

  it("propagates per-row rezago_grado from SQL into payload + null-folds bad values", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cvegeo: "0900700015658",
          ambito: "Urbana",
          centroid_lat: "19.36",
          centroid_lon: "-99.07",
          area_km2: "0.5",
          pobtot: "7959",
          target_count: "2",
          total_estab: "120",
          score: "3979.5",
          rezago_grado: "Alto",
        },
        {
          cvegeo: "0900700099999",
          ambito: "Urbana",
          centroid_lat: null,
          centroid_lon: null,
          area_km2: "1.0",
          pobtot: null,
          target_count: "0",
          total_estab: "5",
          score: null,
          rezago_grado: null, // not in CONEVAL — null passthrough
        },
        {
          cvegeo: "0900700088888",
          ambito: "Urbana",
          centroid_lat: null,
          centroid_lon: null,
          area_km2: "0.3",
          pobtot: "1500",
          target_count: "0",
          total_estab: "10",
          score: null,
          rezago_grado: "BOGUS_VALUE", // adversarial — must collapse to null
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09007&target_scian=464111",
      { headers: AUTH },
    );
    const body = (await res.json()) as OpportunityByAgebResult;
    expect(body.agebs[0].rezago_grado).toBe("Alto");
    expect(body.agebs[1].rezago_grado).toBeNull();
    // Adversarial value MUST collapse to null at the type boundary
    expect(body.agebs[2].rezago_grado).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v0.2.7 — health-coverage gap (Censo derechohabiencia) + SINBA morbidity
// ---------------------------------------------------------------------------

describe("GET /analytics/opportunity-by-ageb v0.2.7 fields", () => {
  it("emits LEFT JOIN to sinba_morbidity_municipal in the SQL", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09007&target_scian=464111",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("LEFT JOIN (");
    expect(sql).toContain("FROM sinba_morbidity_municipal");
    expect(sql).toContain("anio = (SELECT MAX(anio)");
    // Casos columns must project as the response field names
    expect(sql).toContain("smm.casos_dm2_promedio AS casos_dm2_muni");
    expect(sql).toContain("smm.casos_hta_promedio AS casos_hta_muni");
    expect(sql).toContain("smm.casos_obesidad_promedio AS casos_obesidad_muni");
  });

  it("emits pct_sin_cobertura_salud computation with NULL guards (pobtot=0/null + psinder=null)", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09007&target_scian=464111",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toMatch(
      /WHEN cab\.pobtot IS NULL OR cab\.pobtot = 0 THEN NULL/,
    );
    expect(sql).toMatch(/WHEN cab\.psinder IS NULL THEN NULL/);
    expect(sql).toContain("cab.psinder::numeric / cab.pobtot * 100");
  });

  it("returns pct_sin_cobertura_salud + casos_*_muni with numeric coercion", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cvegeo: "0900700011053",
          ambito: "Urbana",
          centroid_lat: "19.354",
          centroid_lon: "-99.055",
          area_km2: "0.30",
          pobtot: "7253",
          target_count: "1",
          total_estab: "218",
          score: "7253",
          rezago_grado: "Bajo",
          pct_sin_cobertura_salud: "32.7",
          casos_dm2_muni: "8780.4",
          casos_hta_muni: "6917.8",
          casos_obesidad_muni: "3362.6",
        },
        {
          // rural / not-in-censo AGEB — all v0.2.7 fields should null-fold
          cvegeo: "1099900020001",
          ambito: "Rural",
          centroid_lat: null,
          centroid_lon: null,
          area_km2: "5.0",
          pobtot: null,
          target_count: "0",
          total_estab: "2",
          score: null,
          rezago_grado: null,
          pct_sin_cobertura_salud: null,
          casos_dm2_muni: null,
          casos_hta_muni: null,
          casos_obesidad_muni: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/opportunity-by-ageb?cve_mun=09007&target_scian=464111",
      { headers: AUTH },
    );
    const body = (await res.json()) as OpportunityByAgebResult;
    expect(body.agebs[0].pct_sin_cobertura_salud).toBeCloseTo(32.7, 1);
    expect(body.agebs[0].casos_dm2_muni).toBeCloseTo(8780.4, 1);
    expect(body.agebs[0].casos_hta_muni).toBeCloseTo(6917.8, 1);
    expect(body.agebs[0].casos_obesidad_muni).toBeCloseTo(3362.6, 1);
    expect(body.agebs[1].pct_sin_cobertura_salud).toBeNull();
    expect(body.agebs[1].casos_dm2_muni).toBeNull();
    expect(body.agebs[1].casos_hta_muni).toBeNull();
    expect(body.agebs[1].casos_obesidad_muni).toBeNull();
  });
});

describe("GET /analytics/ageb-detail v0.2.7 census derechohabiencia", () => {
  it("returns derechohabiencia fields in census block when AGEB is in censo_ageb", async () => {
    mockExec
      .mockReturnValueOnce(
        JSON.stringify([
          {
            cvegeo: "0900700010017",
            cve_ent: "09",
            cve_mun: "007",
            cve_loc: "0001",
            cve_ageb: "0017",
            ambito: "Urbana",
            area_km2: "0.5",
            centroid_lat: "19.36",
            centroid_lon: "-99.07",
            bbox_minlon: null,
            bbox_minlat: null,
            bbox_maxlon: null,
            bbox_maxlat: null,
          },
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(
        JSON.stringify([{ total_establecimientos: 1, total_farmacias: 0 }]),
      )
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([0]))
      .mockReturnValueOnce(
        JSON.stringify([
          {
            pobtot: "5868",
            pobfem: "3000",
            pobmas: "2868",
            p_60ymas: "800",
            p_15ymas: "4500",
            p_18ymas: "4200",
            pea: "2500",
            pocupada: "2400",
            graproes: "10.5",
            tvivhab: "1645",
            tvivpar: "1645",
            vph_inter: "1200",
            vph_autom: "800",
            // v0.2.7 derechohabiencia
            pder_ss: "3670",
            pder_imss: "2430",
            pder_imssb: null,
            pder_iste: "100",
            pder_istee: "50",
            pder_segp: "1090",
            pafil_ipriv: "200",
            psinder: "2196",
          },
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([]));

    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/ageb-detail?cvegeo=0900700010017",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgebDetailResult;
    expect(body.census).not.toBeNull();
    expect(body.census!.psinder).toBe(2196);
    expect(body.census!.pder_imss).toBe(2430);
    expect(body.census!.pder_iste).toBe(100);
    expect(body.census!.pafil_ipriv).toBe(200);
    expect(body.census!.pder_imssb).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v0.2.8 — COFEPRIS licensed pharmacies
// ---------------------------------------------------------------------------

describe("GET /analytics/licensed-pharmacies-by-municipio (v0.2.8)", () => {
  it("rejects missing cve_mun", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/licensed-pharmacies-by-municipio",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects malformed cve_mun (not 5 digits)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/licensed-pharmacies-by-municipio?cve_mun=invalid",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects 4-digit cve_mun (boundary)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/licensed-pharmacies-by-municipio?cve_mun=0901",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("returns full counts for a populated muni", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_mun: "09015",
          total_licenciadas: "299",
          con_estupefacientes: "117",
          con_psicotropicos: "280",
          con_vacunas: "201",
          con_toxoides: "211",
          con_sueros_antitoxinas: "170",
          con_hemoderivados: "216",
          hospitalarias: "10",
          boticas: "0",
          droguerias: "9",
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/licensed-pharmacies-by-municipio?cve_mun=09015",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LicensedPharmaciesByMunicipioResult;
    expect(body).toEqual({
      cve_mun: "09015",
      total_licenciadas: 299,
      con_estupefacientes: 117,
      con_psicotropicos: 280,
      con_vacunas: 201,
      con_toxoides: 211,
      con_sueros_antitoxinas: 170,
      con_hemoderivados: 216,
      hospitalarias: 10,
      boticas: 0,
      droguerias: 9,
    });
  });

  it("returns zeroes (not 404) when muni has no licensed pharmacies", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/licensed-pharmacies-by-municipio?cve_mun=20570",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LicensedPharmaciesByMunicipioResult;
    expect(body).toEqual({
      cve_mun: "20570",
      total_licenciadas: 0,
      con_estupefacientes: 0,
      con_psicotropicos: 0,
      con_vacunas: 0,
      con_toxoides: 0,
      con_sueros_antitoxinas: 0,
      con_hemoderivados: 0,
      hospitalarias: 0,
      boticas: 0,
      droguerias: 0,
    });
  });

  it("queries the cofepris_farmacias_by_municipio view, not the raw table", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/licensed-pharmacies-by-municipio?cve_mun=09015",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("FROM cofepris_farmacias_by_municipio");
    expect(sql).toContain("cve_mun = '09015'");
    // Endpoint must NOT touch the raw table — that would skip the Vigente filter.
    expect(sql).not.toMatch(/FROM cofepris_farmacias\b(?! _by)/);
  });

  it("emits Cache-Control + Vary headers", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/licensed-pharmacies-by-municipio?cve_mun=09015",
      { headers: AUTH },
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Vary")).toBe("X-Api-Key");
  });
});

describe("GET /analytics/licensed-pharmacies-by-ageb (v0.2.8)", () => {
  it("rejects missing cvegeo", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/licensed-pharmacies-by-ageb", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects 12-char cvegeo (boundary)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/licensed-pharmacies-by-ageb?cvegeo=090070001005",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("accepts 13-char cvegeo with letter suffix", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/licensed-pharmacies-by-ageb?cvegeo=090070001005A",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
  });

  it("returns counts when AGEB has licensed pharmacies", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cvegeo: "0901500011024",
          total_licenciadas: "8",
          con_controlados: "5",
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/licensed-pharmacies-by-ageb?cvegeo=0901500011024",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LicensedPharmaciesByAgebResult;
    expect(body).toEqual({
      cvegeo: "0901500011024",
      total_licenciadas: 8,
      con_controlados: 5,
    });
  });

  it("returns zeroes for unmatched AGEB", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/licensed-pharmacies-by-ageb?cvegeo=2057001234567",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LicensedPharmaciesByAgebResult;
    expect(body).toEqual({
      cvegeo: "2057001234567",
      total_licenciadas: 0,
      con_controlados: 0,
    });
  });

  it("queries the cofepris_farmacias_by_ageb view", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/licensed-pharmacies-by-ageb?cvegeo=0901500011024",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("FROM cofepris_farmacias_by_ageb");
    expect(sql).toContain("cvegeo_ageb = '0901500011024'");
  });
});

// ---------------------------------------------------------------------------
// v0.2.9 — Sub-AGEB drilldown: manzanas + colonias inside an AGEB
// ---------------------------------------------------------------------------

describe("GET /analytics/manzanas-by-ageb (v0.2.9)", () => {
  it("rejects missing cvegeo", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/manzanas-by-ageb", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects malformed cvegeo (12 chars, missing suffix)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/manzanas-by-ageb?cvegeo=090070001247",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects bad order_by", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/manzanas-by-ageb?cvegeo=0900700012475&order_by=score",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects limit > 200", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/manzanas-by-ageb?cvegeo=0900700012475&limit=201",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("returns manzanas ordered by pobtot by default", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cvegeo_mza: "0900700012475005",
          mza: "005",
          pobtot: "24",
          pobfem: "5",
          pobmas: "19",
          tvivpar: "8",
          vph_inter: "6",
          vph_autom: "3",
        },
        {
          cvegeo_mza: "0900700012475006",
          mza: "006",
          pobtot: "14",
          pobfem: "0",
          pobmas: "14",
          tvivpar: null,
          vph_inter: null,
          vph_autom: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/manzanas-by-ageb?cvegeo=0900700012475",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ManzanasByAgebResult;
    expect(body.cvegeo).toBe("0900700012475");
    expect(body.order_by).toBe("pobtot");
    expect(body.total_returned).toBe(2);
    expect(body.manzanas[0]).toEqual({
      cvegeo_mza: "0900700012475005",
      mza: "005",
      pobtot: 24,
      pobfem: 5,
      pobmas: 19,
      tvivpar: 8,
      vph_inter: 6,
      vph_autom: 3,
    });
    expect(body.manzanas[1].tvivpar).toBeNull();
    expect(body.manzanas[1].vph_inter).toBeNull();
  });

  it("returns empty array (not 404) when AGEB has no manzanas", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/manzanas-by-ageb?cvegeo=2057001234567",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ManzanasByAgebResult;
    expect(body.total_returned).toBe(0);
    expect(body.manzanas).toEqual([]);
  });

  it("emits SQL filter on cvegeo_ageb + DESC NULLS LAST + tiebreak by mza", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/manzanas-by-ageb?cvegeo=0900700012475&order_by=tvivpar",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("FROM censo_manzana");
    expect(sql).toContain("cvegeo_ageb = '0900700012475'");
    // v0.2.9 audit W4 (2026-05-06): pin ORDER BY position relative to LIMIT
    // rather than substring-match in isolation. A buggy SQL that emits
    // `ORDER BY tvivpar DESC NULLS LAST, mza ASC, junk_col` would still
    // pass `.toContain` — the regex requires nothing between the ORDER BY
    // and the LIMIT keyword (whitespace allowed). Same defense pattern is
    // worth applying to any future ORDER BY assertion in this file.
    expect(sql).toMatch(/ORDER BY tvivpar DESC NULLS LAST, mza ASC\s+LIMIT\b/);
    // No second ORDER BY clause — guards against accidental double-sort.
    expect(sql.match(/ORDER BY/g)?.length).toBe(1);
  });

  it("emits Cache-Control + Vary headers", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/manzanas-by-ageb?cvegeo=0900700012475",
      { headers: AUTH },
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Vary")).toBe("X-Api-Key");
  });
});

describe("GET /analytics/colonias-by-ageb (v0.2.9)", () => {
  it("rejects missing cvegeo", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/colonias-by-ageb", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects malformed cvegeo", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/colonias-by-ageb?cvegeo=tooshort",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects limit > 100", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/colonias-by-ageb?cvegeo=0900700012475&limit=101",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("returns colonias ordered by establishment count", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        { colonia: "ROMA NORTE", num_establecimientos: "445" },
        { colonia: "ROMA SUR", num_establecimientos: "127" },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/colonias-by-ageb?cvegeo=0900700012475",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ColoniasByAgebResult;
    expect(body.cvegeo).toBe("0900700012475");
    expect(body.total_returned).toBe(2);
    expect(body.colonias[0]).toEqual({
      colonia: "ROMA NORTE",
      num_establecimientos: 445,
    });
  });

  it("returns empty array (not 404) when AGEB has no establecimientos", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/colonias-by-ageb?cvegeo=2057001234567",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ColoniasByAgebResult;
    expect(body.total_returned).toBe(0);
    expect(body.colonias).toEqual([]);
  });

  it("emits UPPER+TRIM normalization, excludes null/empty colonias, filters on ageb=cvegeo", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request("/analytics/colonias-by-ageb?cvegeo=0900700012475", {
      headers: AUTH,
    });
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("UPPER(TRIM(colonia))");
    expect(sql).toContain("ageb = '0900700012475'");
    expect(sql).toContain("colonia IS NOT NULL");
    expect(sql).toContain("TRIM(colonia) != ''");
    // The v0.2.8 lesson: establecimientos.ageb IS the full 13-char cvegeo.
    // Don't try to concatenate area_geo + ageb.
    expect(sql).not.toMatch(/area_geo\s*\|\|\s*ageb/);
  });
});

// ---------------------------------------------------------------------------
// /analytics/airports-by-municipio (SCT/AFAC airport pivot, 2006-2026 March)
// ---------------------------------------------------------------------------

describe("GET /analytics/airports-by-municipio", () => {
  it("rejects missing cve_mun without invoking psql", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/airports-by-municipio", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects malformed cve_mun without invoking psql", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/airports-by-municipio?cve_mun=ABC",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns empty airports array for muni without an airport", async () => {
    mockExec.mockReturnValueOnce(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/airports-by-municipio?cve_mun=09007",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AirportsByMunicipioResult;
    expect(body.cve_mun).toBe("09007");
    expect(body.cve_ent).toBe("09");
    expect(body.airports).toEqual([]);
    expect(body.num_airports_active_2026).toBe(0);
    expect(body.mar_flights_recent_avg).toBe(0);
  });

  it("returns full per-airport breakdown with growth rate vs 2019", async () => {
    mockExec.mockReturnValueOnce(
      JSON.stringify([
        {
          airport_name: "CIUDAD DE MÉXICO/MEXICO CITY",
          mar_flights_2026: 25606,
          mar_flights_recent_avg: 26139,
          mar_flights_2019: 37671,
          pct_change_vs_2019: -32.0,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/airports-by-municipio?cve_mun=09017",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AirportsByMunicipioResult;
    expect(body.cve_mun).toBe("09017");
    expect(body.airports).toHaveLength(1);
    expect(body.airports[0]).toMatchObject({
      airport_name: "CIUDAD DE MÉXICO/MEXICO CITY",
      mar_flights_2026: 25606,
      mar_flights_recent_avg: 26139,
      mar_flights_2019: 37671,
      pct_change_vs_2019: -32.0,
    });
    expect(body.num_airports_active_2026).toBe(1);
    expect(body.mar_flights_recent_avg).toBe(26139);
  });

  it("handles new-airport case (no 2019 baseline) without dividing by zero", async () => {
    mockExec.mockReturnValueOnce(
      JSON.stringify([
        {
          airport_name: "SANTA LUCÍA",
          mar_flights_2026: 5925,
          mar_flights_recent_avg: 5493,
          mar_flights_2019: null,
          pct_change_vs_2019: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/airports-by-municipio?cve_mun=15120",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AirportsByMunicipioResult;
    expect(body.airports[0]?.mar_flights_2019).toBeNull();
    expect(body.airports[0]?.pct_change_vs_2019).toBeNull();
  });

  it("aggregates multi-airport munis (e.g. Monterrey + Del Norte)", async () => {
    mockExec.mockReturnValueOnce(
      JSON.stringify([
        {
          airport_name: "MONTERREY",
          mar_flights_2026: 10928,
          mar_flights_recent_avg: 9320,
          mar_flights_2019: 9058,
          pct_change_vs_2019: 20.6,
        },
        {
          airport_name: "DEL NORTE",
          mar_flights_2026: 3157,
          mar_flights_recent_avg: 3157,
          mar_flights_2019: null,
          pct_change_vs_2019: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/airports-by-municipio?cve_mun=19039",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AirportsByMunicipioResult;
    expect(body.airports).toHaveLength(2);
    expect(body.num_airports_active_2026).toBe(2);
    expect(body.mar_flights_recent_avg).toBe(12477);
  });

  it("composes SQL with ORDER BY recent_avg DESC + cve_mun literal interpolation", async () => {
    mockExec.mockReturnValueOnce(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request("/analytics/airports-by-municipio?cve_mun=23005", {
      headers: AUTH,
    });
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("FROM aeropuertos_movements_yearly");
    expect(sql).toContain("WHERE cve_mun = '23005'");
    expect(sql).toMatch(/ORDER BY r\.mar_flights_recent_avg DESC NULLS LAST/);
    // No SQL-injection escape — the cve_mun is gated by CVE_MUN_RE before SQL composition
    expect(sql).not.toMatch(/'23005';.*--/);
  });
});

// ---------------------------------------------------------------------------
// /analytics/localities-by-municipio  (v0.2.10)
// ---------------------------------------------------------------------------

describe("GET /analytics/localities-by-municipio (v0.2.10)", () => {
  it("rejects missing cve_mun", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/localities-by-municipio", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects malformed cve_mun (4 chars)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/localities-by-municipio?cve_mun=0900",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects bad order_by", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/localities-by-municipio?cve_mun=09007&order_by=religion",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects limit > 200", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/localities-by-municipio?cve_mun=09007&limit=201",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("returns localities with NULL preservation for INEGI-suppressed fields", async () => {
    mockExec.mockReturnValue(
      JSON.stringify({
        total_localities: 2,
        localities: [
          {
            cve_loc: "090070001",
            nom_loc: "Iztapalapa",
            tamloc: "14",
            altitud_m: "2239",
            pobtot: "1835486",
            tvivpar: "510244",
            vph_inter: "349103",
          },
          {
            cve_loc: "090070055",
            nom_loc: "El Tepito Chico",
            tamloc: "1",
            altitud_m: null,
            pobtot: "12",
            tvivpar: null,
            vph_inter: null,
          },
        ],
      }),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/localities-by-municipio?cve_mun=09007",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LocalitiesByMunicipioResult;
    expect(body.cve_mun).toBe("09007");
    expect(body.total_localities).toBe(2);
    expect(body.localities).toHaveLength(2);
    expect(body.localities[0]).toEqual({
      cve_loc: "090070001",
      nom_loc: "Iztapalapa",
      tamloc: 14,
      altitud_m: 2239,
      pobtot: 1835486,
      tvivpar: 510244,
      vph_inter: 349103,
    });
    // INEGI 'N/D' suppression must surface as NULL, not 0 — the latter
    // would silently inflate aggregations downstream.
    expect(body.localities[1].tvivpar).toBeNull();
    expect(body.localities[1].vph_inter).toBeNull();
    expect(body.localities[1].altitud_m).toBeNull();
  });

  it("returns empty localities array (not 404) when muni is empty", async () => {
    mockExec.mockReturnValue(
      JSON.stringify({ total_localities: 0, localities: [] }),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/localities-by-municipio?cve_mun=04001",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LocalitiesByMunicipioResult;
    expect(body.total_localities).toBe(0);
    expect(body.localities).toEqual([]);
  });

  it("emits FROM censo_localidades + DESC NULLS LAST on numeric order_by", async () => {
    mockExec.mockReturnValue(
      JSON.stringify({ total_localities: 0, localities: [] }),
    );
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/localities-by-municipio?cve_mun=09007&order_by=tvivpar",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("FROM censo_localidades");
    expect(sql).toContain("WHERE cve_mun = '09007'");
    // Position-pinned (audit pattern from v0.2.9 W4): ORDER BY directly
    // adjacent to LIMIT so a buggy `ORDER BY tvivpar DESC NULLS LAST, junk`
    // can't pass via substring.
    expect(sql).toMatch(
      /ORDER BY tvivpar DESC NULLS LAST, cve_loc ASC\s+LIMIT\b/,
    );
    // v0.2.10 audit W1: outer json_agg also has explicit ORDER BY so row
    // order isn't implementation-dependent on the aggregate. Inner +
    // outer ORDER BY are intentionally redundant — inner picks rows via
    // LIMIT, outer fixes emission order.
    expect(sql).toMatch(
      /json_agg\(row_to_json\(r\) ORDER BY r\.tvivpar DESC NULLS LAST, r\.cve_loc ASC\)/,
    );
  });

  it("echoes order_by in response shape (S1 audit)", async () => {
    mockExec.mockReturnValue(
      JSON.stringify({ total_localities: 0, localities: [] }),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/localities-by-municipio?cve_mun=09007&order_by=vph_inter",
      { headers: AUTH },
    );
    const body = (await res.json()) as LocalitiesByMunicipioResult;
    expect(body.order_by).toBe("vph_inter");
  });

  it("defaults order_by to pobtot when omitted", async () => {
    mockExec.mockReturnValue(
      JSON.stringify({ total_localities: 0, localities: [] }),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/localities-by-municipio?cve_mun=09007",
      { headers: AUTH },
    );
    const body = (await res.json()) as LocalitiesByMunicipioResult;
    expect(body.order_by).toBe("pobtot");
  });

  it("flips to ASC direction for nom_loc order_by (alphabetic browse)", async () => {
    mockExec.mockReturnValue(
      JSON.stringify({ total_localities: 0, localities: [] }),
    );
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/localities-by-municipio?cve_mun=09007&order_by=nom_loc",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toMatch(/ORDER BY nom_loc ASC NULLS LAST/);
    expect(sql).not.toMatch(/ORDER BY nom_loc DESC/);
  });

  it("emits Cache-Control + Vary headers", async () => {
    mockExec.mockReturnValue(
      JSON.stringify({ total_localities: 0, localities: [] }),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/localities-by-municipio?cve_mun=09007",
      { headers: AUTH },
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Vary")).toBe("X-Api-Key");
  });
});

// ---------------------------------------------------------------------------
// /analytics/locality-detail  (v0.2.10)
// ---------------------------------------------------------------------------

describe("GET /analytics/locality-detail (v0.2.10)", () => {
  it("rejects missing cve_loc", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/locality-detail", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects 8-char cve_loc (typo)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/locality-detail?cve_loc=09007001",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects letter-suffixed cve_loc (AGEB shape, wrong key)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/locality-detail?cve_loc=21114000A",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when locality not found", async () => {
    mockExec.mockReturnValue(JSON.stringify(null));
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/locality-detail?cve_loc=999999999",
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
  });

  it("returns full demographic surface with category nesting", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_loc: "090070001",
          cve_mun: "09007",
          entidad: "09",
          nom_loc: "Iztapalapa",
          nom_mun: "Iztapalapa",
          nom_ent: "Ciudad de México",
          tamloc: "14",
          altitud_m: "2239",
          pobtot: "1835486",
          pobfem: "950000",
          pobmas: "885486",
          p_60ymas: "210000",
          p_15ymas: "1500000",
          p_18ymas: "1300000",
          pea: "850000",
          pocupada: "820000",
          graproes: "10.5",
          tvivhab: "510000",
          tvivpar: "510244",
          pcatolica: "1384540",
          pro_crieva: "154092",
          potras_rel: "10000",
          psin_relig: "200000",
          p3ym_hli: "28716",
          p3hlinhe: "200",
          p3hli_he: "28000",
          phog_ind: "70000",
          pob_afro: "50000",
          pnacent: "1000000",
          pnacoe: "800000",
          pres2015: "1700000",
          presoe15: "100000",
          p15ym_an: "30000",
          p15ym_se: "20000",
          p18ym_pb: "400000",
          psinder: "300000",
          pder_ss: "1500000",
          pder_imss: "900000",
          pder_iste: "100000",
          pder_segp: "500000",
          pder_imssb: "0",
          pafil_ipriv: "20000",
          vph_inter: "349103",
          vph_autom: "200000",
          vph_refri: "490000",
          vph_lavad: "440000",
          vph_pc: "150000",
          vph_cel: "490000",
          vph_tv: "500000",
          vph_snbien: "5000",
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/locality-detail?cve_loc=090070001",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LocalityDetailResult;
    expect(body.cve_loc).toBe("090070001");
    expect(body.cve_mun).toBe("09007");
    expect(body.entidad).toBe("09");
    expect(body.nom_loc).toBe("Iztapalapa");
    expect(body.tamloc).toBe(14);
    expect(body.altitud_m).toBe(2239);
    expect(body.population.pobtot).toBe(1835486);
    expect(body.population.graproes).toBeCloseTo(10.5);
    expect(body.religion.pcatolica).toBe(1384540);
    expect(body.religion.pro_crieva).toBe(154092);
    expect(body.indigenous_afro.p3ym_hli).toBe(28716);
    expect(body.indigenous_afro.pob_afro).toBe(50000);
    expect(body.migration.pnacoe).toBe(800000);
    expect(body.education.p18ym_pb).toBe(400000);
    expect(body.health_coverage.psinder).toBe(300000);
    expect(body.assets.vph_inter).toBe(349103);
    expect(body.assets.vph_snbien).toBe(5000);
  });

  it("preserves NULLs across all categories for INEGI-suppressed locality", async () => {
    // Synthetic small-locality response: pobtot is always emitted but
    // every derived field is suppressed (LSNIEG art. 37 — n<50 households).
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_loc: "090079999",
          cve_mun: "09007",
          entidad: "09",
          nom_loc: "Rancho El Pequeño",
          nom_mun: "Iztapalapa",
          nom_ent: "Ciudad de México",
          tamloc: "1",
          altitud_m: "2400",
          pobtot: "12",
          pobfem: "6",
          pobmas: "6",
          p_60ymas: null,
          p_15ymas: null,
          p_18ymas: null,
          pea: null,
          pocupada: null,
          graproes: null,
          tvivhab: null,
          tvivpar: null,
          pcatolica: null,
          pro_crieva: null,
          potras_rel: null,
          psin_relig: null,
          p3ym_hli: null,
          p3hlinhe: null,
          p3hli_he: null,
          phog_ind: null,
          pob_afro: null,
          pnacent: null,
          pnacoe: null,
          pres2015: null,
          presoe15: null,
          p15ym_an: null,
          p15ym_se: null,
          p18ym_pb: null,
          psinder: null,
          pder_ss: null,
          pder_imss: null,
          pder_iste: null,
          pder_segp: null,
          pder_imssb: null,
          pafil_ipriv: null,
          vph_inter: null,
          vph_autom: null,
          vph_refri: null,
          vph_lavad: null,
          vph_pc: null,
          vph_cel: null,
          vph_tv: null,
          vph_snbien: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/locality-detail?cve_loc=090079999",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LocalityDetailResult;
    expect(body.population.pobtot).toBe(12);
    // Every suppressed derived field must be NULL (not 0). Operator
    // would silently double-count if 'N/D' surfaced as 0.
    expect(body.religion.pcatolica).toBeNull();
    expect(body.indigenous_afro.p3ym_hli).toBeNull();
    expect(body.migration.pnacoe).toBeNull();
    expect(body.education.p18ym_pb).toBeNull();
    expect(body.health_coverage.psinder).toBeNull();
    expect(body.assets.vph_inter).toBeNull();
  });

  it("emits FROM censo_localidades + literal cve_loc in WHERE", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    // 200 OK is impossible here (rows=[] → 404), but we only care about
    // the SQL composition; the handler still runs the query before the
    // 404 throw, so mockExec captures the call.
    const res = await app.request(
      "/analytics/locality-detail?cve_loc=220140001",
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("FROM censo_localidades");
    expect(sql).toContain("WHERE cve_loc = '220140001'");
  });

  it("emits Cache-Control + Vary headers on success", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_loc: "090070001",
          cve_mun: "09007",
          entidad: "09",
          nom_loc: "Iztapalapa",
          nom_mun: "Iztapalapa",
          nom_ent: "Ciudad de México",
          tamloc: "14",
          altitud_m: "2239",
          pobtot: "1835486",
          pobfem: null,
          pobmas: null,
          p_60ymas: null,
          p_15ymas: null,
          p_18ymas: null,
          pea: null,
          pocupada: null,
          graproes: null,
          tvivhab: null,
          tvivpar: null,
          pcatolica: null,
          pro_crieva: null,
          potras_rel: null,
          psin_relig: null,
          p3ym_hli: null,
          p3hlinhe: null,
          p3hli_he: null,
          phog_ind: null,
          pob_afro: null,
          pnacent: null,
          pnacoe: null,
          pres2015: null,
          presoe15: null,
          p15ym_an: null,
          p15ym_se: null,
          p18ym_pb: null,
          psinder: null,
          pder_ss: null,
          pder_imss: null,
          pder_iste: null,
          pder_segp: null,
          pder_imssb: null,
          pafil_ipriv: null,
          vph_inter: null,
          vph_autom: null,
          vph_refri: null,
          vph_lavad: null,
          vph_pc: null,
          vph_cel: null,
          vph_tv: null,
          vph_snbien: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/locality-detail?cve_loc=090070001",
      { headers: AUTH },
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Vary")).toBe("X-Api-Key");
  });
});

// ---------------------------------------------------------------------------
// SQL-injection contract — locality endpoints (v0.2.10)
// ---------------------------------------------------------------------------

describe("Locality endpoints — SQL-injection contract (v0.2.10)", () => {
  const INJECTION_VECTORS = [
    "09007'; DROP TABLE censo_iter--",
    "09007 OR 1=1",
    "09007;SELECT 1",
    "0'; DROP TABLE x--",
    "../../../../etc/passwd",
    "%27%20OR%201%3D1",
    // R1 (audit, 2026-05-09): letter chars must reject at the regex gate.
    // CVE_MUN_RE / CVE_LOC_RE are digits-only so 'A' shouldn't reach SQL,
    // but pinning the contract guards against a future regex relaxation.
    "0900a",
    "ABCDEFGHI",
  ];

  for (const v of INJECTION_VECTORS) {
    it(`localities-by-municipio rejects "${v}" before SQL composition`, async () => {
      const app = createServer(CONFIG);
      const res = await app.request(
        `/analytics/localities-by-municipio?cve_mun=${encodeURIComponent(v)}`,
        { headers: AUTH },
      );
      expect(res.status).toBe(400);
      // CVE_MUN_RE gates the literal interpolation — psql is never invoked.
      expect(mockExec).not.toHaveBeenCalled();
    });

    it(`locality-detail rejects "${v}" before SQL composition`, async () => {
      const app = createServer(CONFIG);
      const res = await app.request(
        `/analytics/locality-detail?cve_loc=${encodeURIComponent(v)}`,
        { headers: AUTH },
      );
      expect(res.status).toBe(400);
      expect(mockExec).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// /analytics/municipio-detail  (v0.2.10 muni-side, surfaces extended view cols)
// ---------------------------------------------------------------------------

describe("GET /analytics/municipio-detail (v0.2.10)", () => {
  it("rejects missing cve_mun", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects malformed cve_mun (4 chars)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=0900", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("rejects letter chars in cve_mun", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=09a07", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns 404 with structured code when municipio not found (R1 audit)", async () => {
    // 32999 — entidad 32 valid, muni 999 doesn't exist. Keeps the
    // CVE_MUN_RE digit-shape gate satisfied so we exercise the
    // empty-result-set 404 path instead of the validation 400 path.
    mockExec.mockReturnValue(JSON.stringify(null));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=32999", {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    // Pin the error.code so consumers / observability tooling that filter
    // on it don't break silently if the throw ever swaps strings. Mirrors
    // the codebase's <resource>.not_found convention.
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("municipio.not_found");
  });

  it("returns full muni demographic surface with all 9 categories nested", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_mun: "09015",
          entidad: "09",
          mun: "015",
          nom_mun: "Cuauhtémoc",
          nom_ent: "Ciudad de México",
          pobtot: "545884",
          pobfem: "292000",
          pobmas: "253884",
          p_60ymas: "100000",
          p_15ymas: "450000",
          p_18ymas: "420000",
          pea: "300000",
          pocupada: "290000",
          graproes: "12.8",
          tvivhab: "165000",
          tvivpar: "180000",
          pcatolica: "378996",
          pro_crieva: "40236",
          potras_rel: "8000",
          psin_relig: "100000",
          p3ym_hli: "9062",
          p3hlinhe: "100",
          p3hli_he: "8962",
          phog_ind: "20000",
          pob_afro: "12000",
          pnacent: "300000",
          pnacoe: "110598",
          pres2015: "510000",
          presoe15: "30000",
          p15ym_an: "5000",
          p15ym_se: "3000",
          p15pri_in: "20000",
          p15pri_co: "60000",
          p15sec_in: "15000",
          p15sec_co: "100000",
          p18ym_pb: "200000",
          p12ym_solt: "150000",
          p12ym_casa: "180000",
          p12ym_sepa: "60000",
          pcon_disc: "30000",
          pcon_limi: "50000",
          psind_lim: "460000",
          psinder: "153800",
          pder_ss: "390000",
          pder_imss: "240000",
          pder_iste: "30000",
          pder_segp: "100000",
          pder_imssb: "1000",
          pafil_ipriv: "20000",
          vph_inter: "157682",
          vph_autom: "80000",
          vph_refri: "170000",
          vph_lavad: "150000",
          vph_hmicro: "120000",
          vph_moto: "20000",
          vph_bici: "30000",
          vph_radio: "100000",
          vph_tv: "175000",
          vph_pc: "70000",
          vph_telef: "50000",
          vph_cel: "175000",
          vph_stvp: "60000",
          vph_spmvpi: "50000",
          vph_cvj: "30000",
          vph_snbien: "200",
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=09015", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MunicipioDetailResult;
    expect(body.cve_mun).toBe("09015");
    expect(body.entidad).toBe("09");
    expect(body.mun).toBe("015"); // W2 audit
    expect(body.nom_mun).toBe("Cuauhtémoc");
    expect(body.nom_ent).toBe("Ciudad de México"); // W1 audit
    // R2 audit: entidad must equal cve_mun first 2 chars. Defends against
    // a future view bug where entidad and cve_mun could drift apart.
    expect(body.entidad).toBe(body.cve_mun.slice(0, 2));
    // Pin one field per category to catch mis-nesting / typos.
    expect(body.population.pobtot).toBe(545884);
    expect(body.population.graproes).toBeCloseTo(12.8);
    expect(body.religion.pcatolica).toBe(378996);
    expect(body.indigenous_afro.p3ym_hli).toBe(9062);
    expect(body.migration.pnacoe).toBe(110598);
    // Education detail — the v0.2.10 cols not exposed at locality grain.
    expect(body.education.p15pri_in).toBe(20000);
    expect(body.education.p15sec_co).toBe(100000);
    // Civil status + disability — muni-only categories.
    expect(body.civil_status.p12ym_casa).toBe(180000);
    expect(body.disability.psind_lim).toBe(460000);
    expect(body.health_coverage.psinder).toBe(153800);
    // Asset detail beyond locality (microondas, moto, bici, etc.).
    expect(body.assets.vph_inter).toBe(157682);
    expect(body.assets.vph_hmicro).toBe(120000);
    expect(body.assets.vph_moto).toBe(20000);
    expect(body.assets.vph_cvj).toBe(30000);
  });

  it("preserves NULLs across all categories (defensive — muni rarely hits N/D)", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_mun: "31999",
          entidad: "31",
          mun: "999",
          nom_mun: "Test Muni",
          nom_ent: "Test Entidad",
          pobtot: "100",
          pobfem: null,
          pobmas: null,
          p_60ymas: null,
          p_15ymas: null,
          p_18ymas: null,
          pea: null,
          pocupada: null,
          graproes: null,
          tvivhab: null,
          tvivpar: null,
          pcatolica: null,
          pro_crieva: null,
          potras_rel: null,
          psin_relig: null,
          p3ym_hli: null,
          p3hlinhe: null,
          p3hli_he: null,
          phog_ind: null,
          pob_afro: null,
          pnacent: null,
          pnacoe: null,
          pres2015: null,
          presoe15: null,
          p15ym_an: null,
          p15ym_se: null,
          p15pri_in: null,
          p15pri_co: null,
          p15sec_in: null,
          p15sec_co: null,
          p18ym_pb: null,
          p12ym_solt: null,
          p12ym_casa: null,
          p12ym_sepa: null,
          pcon_disc: null,
          pcon_limi: null,
          psind_lim: null,
          psinder: null,
          pder_ss: null,
          pder_imss: null,
          pder_iste: null,
          pder_segp: null,
          pder_imssb: null,
          pafil_ipriv: null,
          vph_inter: null,
          vph_autom: null,
          vph_refri: null,
          vph_lavad: null,
          vph_hmicro: null,
          vph_moto: null,
          vph_bici: null,
          vph_radio: null,
          vph_tv: null,
          vph_pc: null,
          vph_telef: null,
          vph_cel: null,
          vph_stvp: null,
          vph_spmvpi: null,
          vph_cvj: null,
          vph_snbien: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=31999", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MunicipioDetailResult;
    expect(body.population.pobtot).toBe(100);
    expect(body.religion.pcatolica).toBeNull();
    expect(body.education.p15pri_in).toBeNull();
    expect(body.civil_status.p12ym_solt).toBeNull();
    expect(body.disability.pcon_disc).toBeNull();
    expect(body.assets.vph_hmicro).toBeNull();
  });

  it("emits FROM censo_municipios + literal cve_mun in WHERE", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=20067", {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("FROM censo_municipios cm");
    expect(sql).toContain("WHERE cm.cve_mun = '20067'");
    // Pin that the muni-only education detail cols are SELECTed (drift
    // guard: a future SELECT-list cleanup must not silently drop them).
    expect(sql).toContain("p15pri_in");
    expect(sql).toContain("p15sec_co");
    expect(sql).toContain("vph_hmicro");
  });

  it("emits Cache-Control + Vary headers on success", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_mun: "09015",
          entidad: "09",
          mun: "015",
          nom_mun: "Cuauhtémoc",
          nom_ent: "Ciudad de México",
          pobtot: "545884",
          pobfem: null,
          pobmas: null,
          p_60ymas: null,
          p_15ymas: null,
          p_18ymas: null,
          pea: null,
          pocupada: null,
          graproes: null,
          tvivhab: null,
          tvivpar: null,
          pcatolica: null,
          pro_crieva: null,
          potras_rel: null,
          psin_relig: null,
          p3ym_hli: null,
          p3hlinhe: null,
          p3hli_he: null,
          phog_ind: null,
          pob_afro: null,
          pnacent: null,
          pnacoe: null,
          pres2015: null,
          presoe15: null,
          p15ym_an: null,
          p15ym_se: null,
          p15pri_in: null,
          p15pri_co: null,
          p15sec_in: null,
          p15sec_co: null,
          p18ym_pb: null,
          p12ym_solt: null,
          p12ym_casa: null,
          p12ym_sepa: null,
          pcon_disc: null,
          pcon_limi: null,
          psind_lim: null,
          psinder: null,
          pder_ss: null,
          pder_imss: null,
          pder_iste: null,
          pder_segp: null,
          pder_imssb: null,
          pafil_ipriv: null,
          vph_inter: null,
          vph_autom: null,
          vph_refri: null,
          vph_lavad: null,
          vph_hmicro: null,
          vph_moto: null,
          vph_bici: null,
          vph_radio: null,
          vph_tv: null,
          vph_pc: null,
          vph_telef: null,
          vph_cel: null,
          vph_stvp: null,
          vph_spmvpi: null,
          vph_cvj: null,
          vph_snbien: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=09015", {
      headers: AUTH,
    });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Vary")).toBe("X-Api-Key");
  });

  // SQL-injection contract — keeps full parity with the locality vectors
  // (S2 audit). Two vectors added: short-prefix injection and the digits+
  // letter-suffix R1 letter pattern, both already pinned for locality.
  const INJECTION_VECTORS = [
    "09007'; DROP TABLE censo_iter--",
    "09007 OR 1=1",
    "09007;SELECT 1",
    "0'; DROP TABLE x--",
    "../../../../etc/passwd",
    "%27%20OR%201%3D1",
    "0900a",
    "ABCDE",
  ];
  for (const v of INJECTION_VECTORS) {
    it(`rejects "${v}" before SQL composition`, async () => {
      const app = createServer(CONFIG);
      const res = await app.request(
        `/analytics/municipio-detail?cve_mun=${encodeURIComponent(v)}`,
        { headers: AUTH },
      );
      expect(res.status).toBe(400);
      expect(mockExec).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// /analytics/entidad-detail  (v0.2.10 entidad-side, surfaces censo_entidades)
// ---------------------------------------------------------------------------

describe("GET /analytics/entidad-detail (v0.2.10)", () => {
  it("rejects missing cve_ent", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects national-rolled '00' (intentionally excluded from view)", async () => {
    // ENTIDAD_RE = /^(0[1-9]|[12][0-9]|3[0-2])$/ — '00' fails the regex
    // before SQL composition. The view also filters entidad <> '00' as a
    // defense-in-depth, but the regex catches it first.
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=00", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects entidad > 32", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=33", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("rejects single-digit cve_ent (must be zero-padded)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=9", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("rejects letter chars in cve_ent", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=AB", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 with structured code when entidad row missing", async () => {
    // Synthetic miss: ENTIDAD_RE allows '32' (Zacatecas) but mock returns
    // null to simulate a fresh DB without the migration applied.
    mockExec.mockReturnValue(JSON.stringify(null));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=32", {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("entidad.not_found");
  });

  it("returns full entidad demographic surface with all 9 categories nested", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_ent: "09",
          entidad: "09",
          nom_ent: "Ciudad de México",
          pobtot: "9209944",
          pobfem: "4805017",
          pobmas: "4404927",
          p_60ymas: "1485000",
          p_15ymas: "7600000",
          p_18ymas: "7100000",
          pea: "4900000",
          pocupada: "4750000",
          graproes: "11.5",
          tvivhab: "2700000",
          tvivpar: "2900000",
          pcatolica: "6988016",
          pro_crieva: "668246",
          potras_rel: "180000",
          psin_relig: "1300000",
          p3ym_hli: "125153",
          p3hlinhe: "1500",
          p3hli_he: "123653",
          phog_ind: "350000",
          pob_afro: "180000",
          pnacent: "5500000",
          pnacoe: "3500000",
          pres2015: "8800000",
          presoe15: "350000",
          p15ym_an: "100000",
          p15ym_se: "60000",
          p15pri_in: "350000",
          p15pri_co: "1100000",
          p15sec_in: "270000",
          p15sec_co: "1700000",
          p18ym_pb: "3700000",
          p12ym_solt: "2800000",
          p12ym_casa: "3200000",
          p12ym_sepa: "1100000",
          pcon_disc: "470000",
          pcon_limi: "850000",
          psind_lim: "7600000",
          psinder: "2300000",
          pder_ss: "6700000",
          pder_imss: "4200000",
          pder_iste: "850000",
          pder_segp: "1500000",
          pder_imssb: "20000",
          pafil_ipriv: "350000",
          vph_inter: "2084156",
          vph_autom: "1300000",
          vph_refri: "2700000",
          vph_lavad: "2400000",
          vph_hmicro: "1900000",
          vph_moto: "200000",
          vph_bici: "400000",
          vph_radio: "1700000",
          vph_tv: "2800000",
          vph_pc: "1100000",
          vph_telef: "850000",
          vph_cel: "2800000",
          vph_stvp: "1100000",
          vph_spmvpi: "950000",
          vph_cvj: "550000",
          vph_snbien: "3000",
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EntidadDetailResult;
    expect(body.cve_ent).toBe("09");
    expect(body.entidad).toBe("09");
    expect(body.nom_ent).toBe("Ciudad de México");
    // Identity invariant: cve_ent === entidad (sibling muni-detail
    // verifies entidad === cve_mun.slice(0,2); here they're equal).
    expect(body.entidad).toBe(body.cve_ent);
    // Pin one field per category to catch mis-nesting / typos.
    expect(body.population.pobtot).toBe(9209944);
    expect(body.population.graproes).toBeCloseTo(11.5);
    expect(body.religion.pcatolica).toBe(6988016);
    expect(body.religion.psin_relig).toBe(1300000);
    expect(body.indigenous_afro.p3ym_hli).toBe(125153);
    expect(body.migration.pnacoe).toBe(3500000);
    expect(body.education.p18ym_pb).toBe(3700000);
    expect(body.education.p15pri_co).toBe(1100000);
    expect(body.civil_status.p12ym_casa).toBe(3200000);
    expect(body.disability.pcon_disc).toBe(470000);
    expect(body.health_coverage.psinder).toBe(2300000);
    expect(body.health_coverage.pder_imss).toBe(4200000);
    expect(body.assets.vph_inter).toBe(2084156);
    expect(body.assets.vph_hmicro).toBe(1900000);
    expect(body.assets.vph_cvj).toBe(550000);
  });

  it("preserves NULLs across all categories (defensive — entidad rolls rarely hit N/D)", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_ent: "01",
          entidad: "01",
          nom_ent: "Aguascalientes",
          pobtot: "1425607",
          pobfem: null,
          pobmas: null,
          p_60ymas: null,
          p_15ymas: null,
          p_18ymas: null,
          pea: null,
          pocupada: null,
          graproes: null,
          tvivhab: null,
          tvivpar: null,
          pcatolica: null,
          pro_crieva: null,
          potras_rel: null,
          psin_relig: null,
          p3ym_hli: null,
          p3hlinhe: null,
          p3hli_he: null,
          phog_ind: null,
          pob_afro: null,
          pnacent: null,
          pnacoe: null,
          pres2015: null,
          presoe15: null,
          p15ym_an: null,
          p15ym_se: null,
          p15pri_in: null,
          p15pri_co: null,
          p15sec_in: null,
          p15sec_co: null,
          p18ym_pb: null,
          p12ym_solt: null,
          p12ym_casa: null,
          p12ym_sepa: null,
          pcon_disc: null,
          pcon_limi: null,
          psind_lim: null,
          psinder: null,
          pder_ss: null,
          pder_imss: null,
          pder_iste: null,
          pder_segp: null,
          pder_imssb: null,
          pafil_ipriv: null,
          vph_inter: null,
          vph_autom: null,
          vph_refri: null,
          vph_lavad: null,
          vph_hmicro: null,
          vph_moto: null,
          vph_bici: null,
          vph_radio: null,
          vph_tv: null,
          vph_pc: null,
          vph_telef: null,
          vph_cel: null,
          vph_stvp: null,
          vph_spmvpi: null,
          vph_cvj: null,
          vph_snbien: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=01", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EntidadDetailResult;
    expect(body.population.pobtot).toBe(1425607);
    expect(body.religion.pcatolica).toBeNull();
    expect(body.education.p15pri_in).toBeNull();
    expect(body.civil_status.p12ym_solt).toBeNull();
    expect(body.disability.pcon_disc).toBeNull();
    expect(body.assets.vph_hmicro).toBeNull();
  });

  it("emits FROM censo_entidades + literal cve_ent in WHERE + bienestar JOIN (v0.2.11)", async () => {
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=07", {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("FROM censo_entidades ce");
    expect(sql).toContain("WHERE ce.cve_ent = '07'");
    // v0.2.11: LEFT JOIN brings in latest-quarter bienestar metrics. LEFT
    // (not inner) so entidades without a matching panel row still resolve.
    expect(sql).toContain("LEFT JOIN bienestar_estatal_latest bl");
    expect(sql).toContain("ON bl.cve_ent = ce.cve_ent");
    expect(sql).toContain("bl.beneficiarios   AS bl_beneficiarios");
    expect(sql).toContain("bl.periodo_cve     AS bl_periodo_cve");
    // Drift guard: the entidad-only education + asset detail cols must
    // appear in the SELECT list. A future cleanup that drops them would
    // silently truncate the response surface.
    expect(sql).toContain("p15pri_in");
    expect(sql).toContain("p15sec_co");
    expect(sql).toContain("vph_hmicro");
  });

  it("emits Cache-Control + Vary headers on success", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cve_ent: "09",
          entidad: "09",
          nom_ent: "Ciudad de México",
          pobtot: "9209944",
          pobfem: null,
          pobmas: null,
          p_60ymas: null,
          p_15ymas: null,
          p_18ymas: null,
          pea: null,
          pocupada: null,
          graproes: null,
          tvivhab: null,
          tvivpar: null,
          pcatolica: null,
          pro_crieva: null,
          potras_rel: null,
          psin_relig: null,
          p3ym_hli: null,
          p3hlinhe: null,
          p3hli_he: null,
          phog_ind: null,
          pob_afro: null,
          pnacent: null,
          pnacoe: null,
          pres2015: null,
          presoe15: null,
          p15ym_an: null,
          p15ym_se: null,
          p15pri_in: null,
          p15pri_co: null,
          p15sec_in: null,
          p15sec_co: null,
          p18ym_pb: null,
          p12ym_solt: null,
          p12ym_casa: null,
          p12ym_sepa: null,
          pcon_disc: null,
          pcon_limi: null,
          psind_lim: null,
          psinder: null,
          pder_ss: null,
          pder_imss: null,
          pder_iste: null,
          pder_segp: null,
          pder_imssb: null,
          pafil_ipriv: null,
          vph_inter: null,
          vph_autom: null,
          vph_refri: null,
          vph_lavad: null,
          vph_hmicro: null,
          vph_moto: null,
          vph_bici: null,
          vph_radio: null,
          vph_tv: null,
          vph_pc: null,
          vph_telef: null,
          vph_cel: null,
          vph_stvp: null,
          vph_spmvpi: null,
          vph_cvj: null,
          vph_snbien: null,
        },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=09", {
      headers: AUTH,
    });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Vary")).toBe("X-Api-Key");
  });

  // SQL-injection contract — full parity with locality + muni vectors.
  // Vectors adapted to entidad shape (2 chars expected): the digit-only
  // ones get truncated/expanded, the letter/path/url-encoded forms reused
  // verbatim. ENTIDAD_RE is strict 01-32 so almost everything fails.
  const INJECTION_VECTORS = [
    "09'; DROP TABLE censo_iter--",
    "09 OR 1=1",
    "09;SELECT 1",
    "0'; DROP TABLE x--",
    "../../../../etc/passwd",
    "%27%20OR%201%3D1",
    "0a", // 1 digit + letter — covers the R1 letter-vector pattern
    "AB",
    "33", // out of 01-32 range
    "00", // national-rolled, intentionally rejected
  ];
  for (const v of INJECTION_VECTORS) {
    it(`rejects "${v}" before SQL composition`, async () => {
      const app = createServer(CONFIG);
      const res = await app.request(
        `/analytics/entidad-detail?cve_ent=${encodeURIComponent(v)}`,
        { headers: AUTH },
      );
      expect(res.status).toBe(400);
      expect(mockExec).not.toHaveBeenCalled();
    });
  }

  // -------------------------------------------------------------------------
  // v0.2.11: bienestar_latest nested category (Padrón Único de Bienestar)
  // -------------------------------------------------------------------------

  /**
   * Build a minimal mock row for entidad-detail with all censo fields null
   * and bienestar_latest fields filled to a plausible CDMX 2024Q3 shape.
   * Keeps tests focused on bienestar surface without re-asserting the entire
   * 60+ field censo surface (covered by tests above).
   */
  function bienestarMockRow(overrides: Record<string, unknown> = {}) {
    const censoNullFields = [
      "pobtot",
      "pobfem",
      "pobmas",
      "p_60ymas",
      "p_15ymas",
      "p_18ymas",
      "pea",
      "pocupada",
      "graproes",
      "tvivhab",
      "tvivpar",
      "pcatolica",
      "pro_crieva",
      "potras_rel",
      "psin_relig",
      "p3ym_hli",
      "p3hlinhe",
      "p3hli_he",
      "phog_ind",
      "pob_afro",
      "pnacent",
      "pnacoe",
      "pres2015",
      "presoe15",
      "p15ym_an",
      "p15ym_se",
      "p15pri_in",
      "p15pri_co",
      "p15sec_in",
      "p15sec_co",
      "p18ym_pb",
      "p12ym_solt",
      "p12ym_casa",
      "p12ym_sepa",
      "pcon_disc",
      "pcon_limi",
      "psind_lim",
      "psinder",
      "pder_ss",
      "pder_imss",
      "pder_iste",
      "pder_segp",
      "pder_imssb",
      "pafil_ipriv",
      "vph_inter",
      "vph_autom",
      "vph_refri",
      "vph_lavad",
      "vph_hmicro",
      "vph_moto",
      "vph_bici",
      "vph_radio",
      "vph_tv",
      "vph_pc",
      "vph_telef",
      "vph_cel",
      "vph_stvp",
      "vph_spmvpi",
      "vph_cvj",
      "vph_snbien",
    ];
    const base: Record<string, unknown> = {
      cve_ent: "09",
      entidad: "09",
      nom_ent: "Ciudad de México",
    };
    for (const f of censoNullFields) base[f] = null;
    base.bl_periodo_cve = "2024T3";
    base.bl_anio = "2024";
    base.bl_trimestre = "Julio-Septiembre";
    base.bl_fecha = "2024-09-30";
    base.bl_beneficiarios = "3500000";
    base.bl_intervenciones = "12500000";
    base.bl_dependencias = "11";
    base.bl_padrones = "27";
    base.bl_programas = "23";
    return { ...base, ...overrides };
  }

  it("returns bienestar_latest nested category with all 9 fields populated", async () => {
    mockExec.mockReturnValue(JSON.stringify([bienestarMockRow()]));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EntidadDetailResult;
    expect(body.bienestar_latest.periodo_cve).toBe("2024T3");
    expect(body.bienestar_latest.anio).toBe(2024);
    expect(body.bienestar_latest.trimestre).toBe("Julio-Septiembre");
    expect(body.bienestar_latest.fecha).toBe("2024-09-30");
    expect(body.bienestar_latest.beneficiarios).toBe(3500000);
    expect(body.bienestar_latest.intervenciones).toBe(12500000);
    expect(body.bienestar_latest.dependencias).toBe(11);
    expect(body.bienestar_latest.padrones).toBe(27);
    expect(body.bienestar_latest.programas).toBe(23);
  });

  it("preserves NULLs across all 9 bienestar_latest fields when LEFT JOIN misses", async () => {
    // LEFT JOIN ensures the entidad row still resolves when no bienestar
    // panel row exists (e.g. coverage gap, future entidad missing from
    // CSV refresh). All 9 fields surface as null — no 404, no exception.
    const overrides: Record<string, unknown> = {
      bl_periodo_cve: null,
      bl_anio: null,
      bl_trimestre: null,
      bl_fecha: null,
      bl_beneficiarios: null,
      bl_intervenciones: null,
      bl_dependencias: null,
      bl_padrones: null,
      bl_programas: null,
    };
    mockExec.mockReturnValue(JSON.stringify([bienestarMockRow(overrides)]));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EntidadDetailResult;
    expect(body.bienestar_latest.periodo_cve).toBeNull();
    expect(body.bienestar_latest.anio).toBeNull();
    expect(body.bienestar_latest.trimestre).toBeNull();
    expect(body.bienestar_latest.fecha).toBeNull();
    expect(body.bienestar_latest.beneficiarios).toBeNull();
    expect(body.bienestar_latest.intervenciones).toBeNull();
    expect(body.bienestar_latest.dependencias).toBeNull();
    expect(body.bienestar_latest.padrones).toBeNull();
    expect(body.bienestar_latest.programas).toBeNull();
  });

  it("preserves intervenciones decimal precision through JSON pipeline", async () => {
    // Source CSV ships intervenciones as `1851607.0`; the view casts via
    // ::numeric, which preserves the decimal type. JSON serialization
    // turns it back into a number — confirm fractional values round-trip.
    mockExec.mockReturnValue(
      JSON.stringify([
        bienestarMockRow({
          bl_intervenciones: "1851607.5", // synthetic fractional
        }),
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=09", {
      headers: AUTH,
    });
    const body = (await res.json()) as EntidadDetailResult;
    expect(body.bienestar_latest.intervenciones).toBeCloseTo(1851607.5);
  });

  it("emits all 9 bl_* aliases in SELECT list (drift guard)", async () => {
    // If a future refactor removes bienestar_latest fields from the SELECT
    // list, the type still includes them — the response would silently
    // surface all-null instead of erroring. Pin every column name.
    mockExec.mockReturnValue(JSON.stringify([]));
    const app = createServer(CONFIG);
    await app.request("/analytics/entidad-detail?cve_ent=09", {
      headers: AUTH,
    });
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    for (const col of [
      "bl_periodo_cve",
      "bl_anio",
      "bl_trimestre",
      "bl_fecha",
      "bl_beneficiarios",
      "bl_intervenciones",
      "bl_dependencias",
      "bl_padrones",
      "bl_programas",
    ]) {
      expect(sql).toContain(col);
    }
  });
});

// ===========================================================================
// v0.2.12: CNBV Panorama 2025 — inclusion_financiera nested category
// ===========================================================================

describe("/analytics/municipio-detail (v0.2.12 inclusion_financiera)", () => {
  /**
   * Build a muni-detail mock row with all censo fields null + the cp_-prefixed
   * CNBV cols filled to a CDMX Cuauhtémoc-shaped fingerprint. Mirrors the
   * `bienestarMockRow` helper from the entidad block above.
   */
  function cnbvMuniMockRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const censoNullFields = [
      "pobtot",
      "pobfem",
      "pobmas",
      "p_60ymas",
      "p_15ymas",
      "p_18ymas",
      "pea",
      "pocupada",
      "graproes",
      "tvivhab",
      "tvivpar",
      "pcatolica",
      "pro_crieva",
      "potras_rel",
      "psin_relig",
      "p3ym_hli",
      "p3hlinhe",
      "p3hli_he",
      "phog_ind",
      "pob_afro",
      "pnacent",
      "pnacoe",
      "pres2015",
      "presoe15",
      "p15ym_an",
      "p15ym_se",
      "p15pri_in",
      "p15pri_co",
      "p15sec_in",
      "p15sec_co",
      "p18ym_pb",
      "p12ym_solt",
      "p12ym_casa",
      "p12ym_sepa",
      "pcon_disc",
      "pcon_limi",
      "psind_lim",
      "psinder",
      "pder_ss",
      "pder_imss",
      "pder_iste",
      "pder_segp",
      "pder_imssb",
      "pafil_ipriv",
      "vph_inter",
      "vph_autom",
      "vph_refri",
      "vph_lavad",
      "vph_hmicro",
      "vph_moto",
      "vph_bici",
      "vph_radio",
      "vph_tv",
      "vph_pc",
      "vph_telef",
      "vph_cel",
      "vph_stvp",
      "vph_spmvpi",
      "vph_cvj",
      "vph_snbien",
    ];
    const base: Record<string, unknown> = {
      cve_mun: "09015",
      entidad: "09",
      mun: "015",
      nom_mun: "Cuauhtémoc",
      nom_ent: "Ciudad de México",
    };
    for (const f of censoNullFields) base[f] = null;
    // CNBV cp_-prefixed fields (CDMX Cuauhtémoc-shaped sample). Strings to
    // mirror json_agg behavior for numeric cols.
    base.cp_poblacion_total = "545884";
    base.cp_poblacion_adulta = "420000";
    base.cp_rezago_social = "Muy bajo";
    // Sucursales
    base.cp_sucursales_bm = "320";
    base.cp_sucursales_bd = "12";
    base.cp_sucursales_socap = "8";
    base.cp_sucursales_sofipo = "5";
    base.cp_sucursales_total = "345";
    base.cp_corresponsales_max = "210";
    // Cajeros
    base.cp_cajeros_bm = "1450";
    base.cp_cajeros_bd = "30";
    base.cp_cajeros_socap = "12";
    base.cp_cajeros_sofipo = "3";
    base.cp_cajeros_total = "1495";
    // TPV
    base.cp_tpv_bm = "85000";
    base.cp_tpv_bd = "0";
    base.cp_tpv_socap = "200";
    base.cp_tpv_sofipo = "100";
    base.cp_tpv_total_eacp = "85300";
    base.cp_tpv_agregadores = "120000";
    base.cp_tpv_adq_no_banc = "5000";
    base.cp_tpv_total_ag_adq = "125000";
    base.cp_tpv_total = "210300";
    base.cp_puntos_acceso_sca = "2050";
    // Cuentas
    base.cp_cuentas_bm = "1900000";
    base.cp_cuentas_bd = "120000";
    base.cp_cuentas_socap = "30000";
    base.cp_cuentas_sofipo = "10000";
    base.cp_cuentas_total = "2060000";
    // Créditos
    base.cp_creditos_bm = "850000";
    base.cp_creditos_bd = "8000";
    base.cp_creditos_socap = "9000";
    base.cp_creditos_sofipo = "7000";
    base.cp_creditos_total = "874000";
    // Tx TPV
    base.cp_tx_tpv_bm = "180000000";
    base.cp_tx_tpv_bd = "0";
    base.cp_tx_tpv_socap = "100000";
    base.cp_tx_tpv_sofipo = "50000";
    base.cp_tx_tpv_total = "180150000";
    // Remesas
    base.cp_remesas_mdd = "150.5";
    base.cp_remesas_per_capita = "275.6";
    // Brechas Cuentas (M, H, B for 5 institutions). Brecha is a percentage-
    // point delta computed as (h - m) / (h + m) * 100, range approx [-100, +100]:
    // positive = men-favored (more men than women), negative = women-favored.
    // Round-2 audit (2026-05-10) caught that earlier values used [-1, +1] fractions
    // by mistake; the live data range is -88..+93 percentage points.
    base.cp_g_cuentas_bm_m = "950000";
    base.cp_g_cuentas_bm_h = "950000";
    base.cp_g_cuentas_bm_b = "0";
    base.cp_g_cuentas_bd_m = "60000";
    base.cp_g_cuentas_bd_h = "60000";
    base.cp_g_cuentas_bd_b = "0";
    base.cp_g_cuentas_socap_m = "15000";
    base.cp_g_cuentas_socap_h = "15000";
    base.cp_g_cuentas_socap_b = "0";
    base.cp_g_cuentas_sofipo_m = "5500";
    base.cp_g_cuentas_sofipo_h = "4500";
    base.cp_g_cuentas_sofipo_b = "-10.0"; // (4500-5500)/(4500+5500)*100 = -10
    base.cp_g_cuentas_total_m = "1030500";
    base.cp_g_cuentas_total_h = "1029500";
    base.cp_g_cuentas_total_b = "-0.0485"; // (1029500-1030500)/2060000*100
    // Brechas Créditos
    base.cp_g_creditos_bm_m = "420000";
    base.cp_g_creditos_bm_h = "430000";
    base.cp_g_creditos_bm_b = "1.1765"; // (430000-420000)/850000*100 — men-favored
    base.cp_g_creditos_bd_m = "4000";
    base.cp_g_creditos_bd_h = "4000";
    base.cp_g_creditos_bd_b = "0";
    base.cp_g_creditos_socap_m = "4500";
    base.cp_g_creditos_socap_h = "4500";
    base.cp_g_creditos_socap_b = "0";
    base.cp_g_creditos_sofipo_m = "3500";
    base.cp_g_creditos_sofipo_h = "3500";
    base.cp_g_creditos_sofipo_b = "0";
    base.cp_g_creditos_total_m = "432000";
    base.cp_g_creditos_total_h = "442000";
    base.cp_g_creditos_total_b = "1.1442"; // (442000-432000)/874000*100
    base.cp_periodo = "panorama-2025";
    return { ...base, ...overrides };
  }

  it("returns inclusion_financiera with full muni shape populated", async () => {
    mockExec.mockReturnValue(JSON.stringify([cnbvMuniMockRow()]));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=09015", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MunicipioDetailResult;
    const i = body.inclusion_financiera;
    expect(i.poblacion_total).toBe(545884);
    expect(i.poblacion_adulta).toBe(420000);
    expect(i.rezago_social).toBe("Muy bajo");
    expect(i.infraestructura.sucursales.total).toBe(345);
    expect(i.infraestructura.corresponsales_max).toBe(210);
    expect(i.infraestructura.cajeros.total).toBe(1495);
    expect(i.infraestructura.tpv.total).toBe(210300);
    expect(i.infraestructura.tpv.total_eacp).toBe(85300);
    expect(i.infraestructura.tpv.agregadores).toBe(120000);
    expect(i.infraestructura.puntos_acceso_sca).toBe(2050);
    expect(i.productos.cuentas.total).toBe(2060000);
    expect(i.productos.creditos.total).toBe(874000);
    expect(i.productos.tx_tpv.total).toBe(180150000);
    expect(i.remesas.mdd).toBe(150.5);
    expect(i.remesas.per_capita).toBe(275.6);
    // muni grain → estado-only fields are null
    expect(i.productos.sar).toBeNull();
    expect(i.productos.seguros).toBeNull();
    expect(i.condusef).toBeNull();
    expect(i.acomodo).toBeNull();
    expect(i.periodo).toBe("panorama-2025");
  });

  it("populates genero brechas with M/H/B for all 5 institution slices x 2 product categories", async () => {
    mockExec.mockReturnValue(JSON.stringify([cnbvMuniMockRow()]));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=09015", {
      headers: AUTH,
    });
    const body = (await res.json()) as MunicipioDetailResult;
    expect(body.inclusion_financiera.genero).not.toBeNull();
    const g = body.inclusion_financiera.genero!;
    // Cuentas
    expect(g.cuentas.bm.m).toBe(950000);
    expect(g.cuentas.bm.h).toBe(950000);
    expect(g.cuentas.bm.brecha).toBe(0); // parity
    expect(g.cuentas.sofipo.brecha).toBeCloseTo(-10.0); // women-favored
    expect(g.cuentas.total.m).toBe(1030500);
    expect(g.cuentas.total.h).toBe(1029500);
    // Créditos — positive brecha sign means men-favored (more men than women)
    expect(g.creditos.bm.brecha).toBeCloseTo(1.1765);
    expect(g.creditos.total.brecha).toBeCloseTo(1.1442);
  });

  it("preserves NULLs across all inclusion_financiera leaves when LEFT JOIN misses", async () => {
    // Synthesize the all-null cp_ surface — every cnbv col absent. Mirrors
    // a muni present in censo but not in CNBV's catalog (e.g. recently
    // decretado post-Panorama-2025 cutoff).
    const overrides: Record<string, unknown> = {};
    const cpFields = [
      "cp_poblacion_total",
      "cp_poblacion_adulta",
      "cp_rezago_social",
      "cp_sucursales_bm",
      "cp_sucursales_bd",
      "cp_sucursales_socap",
      "cp_sucursales_sofipo",
      "cp_sucursales_total",
      "cp_corresponsales_max",
      "cp_cajeros_bm",
      "cp_cajeros_bd",
      "cp_cajeros_socap",
      "cp_cajeros_sofipo",
      "cp_cajeros_total",
      "cp_tpv_bm",
      "cp_tpv_bd",
      "cp_tpv_socap",
      "cp_tpv_sofipo",
      "cp_tpv_total_eacp",
      "cp_tpv_agregadores",
      "cp_tpv_adq_no_banc",
      "cp_tpv_total_ag_adq",
      "cp_tpv_total",
      "cp_puntos_acceso_sca",
      "cp_cuentas_bm",
      "cp_cuentas_bd",
      "cp_cuentas_socap",
      "cp_cuentas_sofipo",
      "cp_cuentas_total",
      "cp_creditos_bm",
      "cp_creditos_bd",
      "cp_creditos_socap",
      "cp_creditos_sofipo",
      "cp_creditos_total",
      "cp_tx_tpv_bm",
      "cp_tx_tpv_bd",
      "cp_tx_tpv_socap",
      "cp_tx_tpv_sofipo",
      "cp_tx_tpv_total",
      "cp_remesas_mdd",
      "cp_remesas_per_capita",
      "cp_g_cuentas_bm_m",
      "cp_g_cuentas_bm_h",
      "cp_g_cuentas_bm_b",
      "cp_g_cuentas_total_m",
      "cp_g_cuentas_total_h",
      "cp_g_cuentas_total_b",
      "cp_g_creditos_total_m",
      "cp_g_creditos_total_h",
      "cp_g_creditos_total_b",
      "cp_periodo",
    ];
    for (const f of cpFields) overrides[f] = null;
    mockExec.mockReturnValue(JSON.stringify([cnbvMuniMockRow(overrides)]));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=09015", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MunicipioDetailResult;
    const i = body.inclusion_financiera;
    expect(i.poblacion_total).toBeNull();
    expect(i.rezago_social).toBeNull();
    expect(i.infraestructura.sucursales.total).toBeNull();
    expect(i.infraestructura.cajeros.total).toBeNull();
    expect(i.infraestructura.tpv.total).toBeNull();
    expect(i.productos.cuentas.total).toBeNull();
    expect(i.productos.creditos.total).toBeNull();
    expect(i.remesas.mdd).toBeNull();
    expect(i.genero!.cuentas.bm.m).toBeNull();
    expect(i.genero!.creditos.total.brecha).toBeNull();
    // periodo falls back to default sentinel even on JOIN miss
    expect(i.periodo).toBe("panorama-2025");
  });

  it("emits LEFT JOIN cnbv_panorama_municipal in SQL (regression guard)", async () => {
    mockExec.mockReturnValue(JSON.stringify(null));
    const app = createServer(CONFIG);
    await app.request("/analytics/municipio-detail?cve_mun=20067", {
      headers: AUTH,
    });
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain(
      "LEFT JOIN cnbv_panorama_municipal cp ON cp.cve_mun = cm.cve_mun",
    );
    // Pin a representative cp_ alias from each family so a future SELECT-list
    // refactor doesn't silently drop a section of the surface.
    for (const col of [
      "cp_sucursales_total",
      "cp_corresponsales_max",
      "cp_cajeros_total",
      "cp_tpv_total",
      "cp_puntos_acceso_sca",
      "cp_cuentas_total",
      "cp_creditos_total",
      "cp_tx_tpv_total",
      "cp_remesas_mdd",
      "cp_remesas_per_capita",
      "cp_g_cuentas_total_b",
      "cp_g_creditos_total_b",
      "cp_periodo",
    ]) {
      expect(sql).toContain(col);
    }
  });
});

describe("/analytics/entidad-detail (v0.2.12 inclusion_financiera)", () => {
  /**
   * Build an entidad-detail mock row with all censo + bienestar fields null
   * and cp_-prefixed CNBV estado cols filled to a CDMX-shape fingerprint.
   */
  function cnbvEstadoMockRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const nullFields = [
      "pobtot",
      "pobfem",
      "pobmas",
      "p_60ymas",
      "p_15ymas",
      "p_18ymas",
      "pea",
      "pocupada",
      "graproes",
      "tvivhab",
      "tvivpar",
      "pcatolica",
      "pro_crieva",
      "potras_rel",
      "psin_relig",
      "p3ym_hli",
      "p3hlinhe",
      "p3hli_he",
      "phog_ind",
      "pob_afro",
      "pnacent",
      "pnacoe",
      "pres2015",
      "presoe15",
      "p15ym_an",
      "p15ym_se",
      "p15pri_in",
      "p15pri_co",
      "p15sec_in",
      "p15sec_co",
      "p18ym_pb",
      "p12ym_solt",
      "p12ym_casa",
      "p12ym_sepa",
      "pcon_disc",
      "pcon_limi",
      "psind_lim",
      "psinder",
      "pder_ss",
      "pder_imss",
      "pder_iste",
      "pder_segp",
      "pder_imssb",
      "pafil_ipriv",
      "vph_inter",
      "vph_autom",
      "vph_refri",
      "vph_lavad",
      "vph_hmicro",
      "vph_moto",
      "vph_bici",
      "vph_radio",
      "vph_tv",
      "vph_pc",
      "vph_telef",
      "vph_cel",
      "vph_stvp",
      "vph_spmvpi",
      "vph_cvj",
      "vph_snbien",
      "bl_periodo_cve",
      "bl_anio",
      "bl_trimestre",
      "bl_fecha",
      "bl_beneficiarios",
      "bl_intervenciones",
      "bl_dependencias",
      "bl_padrones",
      "bl_programas",
    ];
    const base: Record<string, unknown> = {
      cve_ent: "09",
      entidad: "09",
      nom_ent: "Ciudad de México",
    };
    for (const f of nullFields) base[f] = null;
    // Estado-grain CNBV fields (CDMX-shape).
    base.cp_poblacion_total = "9213395";
    base.cp_poblacion_adulta = "7400000";
    base.cp_sucursales_bm = "2480";
    base.cp_sucursales_bd = "85";
    base.cp_sucursales_socap = "60";
    base.cp_sucursales_sofipo = "30";
    base.cp_sucursales_total = "2655";
    base.cp_corresponsales_max = "9500";
    base.cp_cajeros_bm = "12000";
    base.cp_cajeros_bd = "120";
    base.cp_cajeros_socap = "70";
    base.cp_cajeros_sofipo = "10";
    base.cp_cajeros_total = "12200";
    base.cp_tpv_bm = "350000";
    base.cp_tpv_bd = "0";
    base.cp_tpv_socap = "1500";
    base.cp_tpv_sofipo = "500";
    base.cp_tpv_total_eacp = "352000";
    base.cp_tpv_agregadores = "850000";
    base.cp_tpv_adq_no_banc = "20000";
    base.cp_tpv_total_ag_adq = "870000";
    base.cp_tpv_total = "1222000";
    base.cp_cuentas_bm = "20000000";
    base.cp_cuentas_bd = "1000000";
    base.cp_cuentas_socap = "200000";
    base.cp_cuentas_sofipo = "100000";
    base.cp_cuentas_total = "21300000";
    base.cp_creditos_bm = "9500000";
    base.cp_creditos_bd = "60000";
    base.cp_creditos_socap = "60000";
    base.cp_creditos_sofipo = "40000";
    base.cp_creditos_total = "9660000";
    base.cp_sar_asignado = "2500000";
    base.cp_sar_registrado = "5400000";
    base.cp_sar_total = "7900000";
    base.cp_seg_vida = "44000";
    base.cp_seg_pensiones = "23000";
    base.cp_seg_accidentes = "29000";
    base.cp_seg_danos_sin_autos = "60000";
    base.cp_seg_automoviles = "31000";
    base.cp_seg_total = "187000";
    base.cp_tx_tpv_bm = "1500000000";
    base.cp_tx_tpv_bd = "0";
    base.cp_tx_tpv_socap = "1000000";
    base.cp_tx_tpv_sofipo = "500000";
    base.cp_tx_tpv_total = "1501500000";
    base.cp_remesas_mdd = "1850.0";
    base.cp_condusef_ubicacion = "150000";
    base.cp_condusef_reclamaciones = "60000";
    base.cp_ac_inf_sucursales = "1";
    base.cp_ac_inf_corresponsales = "1";
    base.cp_ac_inf_cajeros = "1";
    base.cp_ac_inf_tpv = "1";
    base.cp_ac_inf_total_ag_adq = "1";
    base.cp_ac_pf_captacion = "1";
    base.cp_ac_pf_credito = "1";
    base.cp_ac_pf_afore = "1";
    base.cp_ac_pf_vida = "1";
    base.cp_ac_pf_pensiones = "1";
    base.cp_ac_pf_accidentes = "1";
    base.cp_ac_pf_danos_sin_autos = "1";
    base.cp_ac_pf_automoviles = "1";
    base.cp_ac_mp_tx_tpv = "1";
    base.cp_ac_mp_remesas = "8";
    base.cp_ac_mp_ubicacion = "1";
    base.cp_ac_mp_reclamaciones = "1";
    base.cp_periodo = "panorama-2025";
    return { ...base, ...overrides };
  }

  it("returns inclusion_financiera with full estado shape populated", async () => {
    mockExec.mockReturnValue(JSON.stringify([cnbvEstadoMockRow()]));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EntidadDetailResult;
    const i = body.inclusion_financiera;
    expect(i.poblacion_total).toBe(9213395);
    expect(i.poblacion_adulta).toBe(7400000);
    // estado grain → muni-only fields are null
    expect(i.rezago_social).toBeNull();
    expect(i.infraestructura.puntos_acceso_sca).toBeNull();
    expect(i.remesas.per_capita).toBeNull();
    expect(i.genero).toBeNull();
    // estado-only populated
    expect(i.productos.sar).not.toBeNull();
    expect(i.productos.sar!.total).toBe(7900000);
    expect(i.productos.seguros).not.toBeNull();
    expect(i.productos.seguros!.total).toBe(187000);
    expect(i.productos.seguros!.vida).toBe(44000);
    expect(i.condusef).not.toBeNull();
    expect(i.condusef!.reclamaciones).toBe(60000);
    expect(i.acomodo).not.toBeNull();
    expect(i.acomodo!.infraestructura.sucursales).toBe(1);
    expect(i.acomodo!.medios_pago.remesas).toBe(8);
    expect(i.periodo).toBe("panorama-2025");
  });

  it("preserves NULLs across all inclusion_financiera leaves when LEFT JOIN misses", async () => {
    const cpFields = [
      "cp_poblacion_total",
      "cp_poblacion_adulta",
      "cp_sucursales_bm",
      "cp_sucursales_total",
      "cp_corresponsales_max",
      "cp_cajeros_total",
      "cp_tpv_total",
      "cp_cuentas_total",
      "cp_creditos_total",
      "cp_sar_asignado",
      "cp_sar_registrado",
      "cp_sar_total",
      "cp_seg_vida",
      "cp_seg_total",
      "cp_tx_tpv_total",
      "cp_remesas_mdd",
      "cp_condusef_ubicacion",
      "cp_condusef_reclamaciones",
      "cp_ac_inf_sucursales",
      "cp_ac_pf_captacion",
      "cp_ac_mp_tx_tpv",
      "cp_periodo",
    ];
    const overrides: Record<string, unknown> = {};
    for (const f of cpFields) overrides[f] = null;
    mockExec.mockReturnValue(JSON.stringify([cnbvEstadoMockRow(overrides)]));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/entidad-detail?cve_ent=09", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EntidadDetailResult;
    const i = body.inclusion_financiera;
    expect(i.poblacion_total).toBeNull();
    expect(i.infraestructura.sucursales.total).toBeNull();
    // sar/seguros/condusef/acomodo SUBTREES still constructed for shape
    // symmetry but their leaves are null
    expect(i.productos.sar).not.toBeNull();
    expect(i.productos.sar!.total).toBeNull();
    expect(i.productos.seguros!.total).toBeNull();
    expect(i.condusef!.reclamaciones).toBeNull();
    expect(i.acomodo!.infraestructura.sucursales).toBeNull();
    // periodo defaults even on JOIN miss
    expect(i.periodo).toBe("panorama-2025");
  });

  it("emits LEFT JOIN cnbv_panorama_estatal in SQL (regression guard)", async () => {
    mockExec.mockReturnValue(JSON.stringify(null));
    const app = createServer(CONFIG);
    await app.request("/analytics/entidad-detail?cve_ent=15", {
      headers: AUTH,
    });
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain(
      "LEFT JOIN cnbv_panorama_estatal cp ON cp.cve_ent = ce.cve_ent",
    );
    for (const col of [
      "cp_sucursales_total",
      "cp_cajeros_total",
      "cp_tpv_total",
      "cp_cuentas_total",
      "cp_creditos_total",
      "cp_sar_total",
      "cp_seg_total",
      "cp_tx_tpv_total",
      "cp_remesas_mdd",
      "cp_condusef_reclamaciones",
      "cp_ac_inf_sucursales",
      "cp_ac_pf_captacion",
      "cp_ac_mp_remesas",
      "cp_periodo",
    ]) {
      expect(sql).toContain(col);
    }
  });
});

describe("InclusionFinancieraResult shape symmetry (v0.2.12)", () => {
  /**
   * Both /analytics/municipio-detail and /analytics/entidad-detail expose
   * `inclusion_financiera` with the SAME nested-key shape. This pins that
   * symmetry: any future grain-specific addition must surface as null in the
   * other grain rather than diverge the type.
   */
  it("muni response includes the full key set with grain-specific nulls", async () => {
    // Build a minimal-but-complete muni mock row by reusing the helper from
    // the muni describe block. Since helpers are scoped to their describe()
    // we build a fresh minimal mock here to keep this independent.
    const row: Record<string, unknown> = {
      cve_mun: "09015",
      entidad: "09",
      mun: "015",
      nom_mun: "Cuauhtémoc",
      nom_ent: "Ciudad de México",
    };
    // null all non-cp fields
    for (const f of [
      "pobtot",
      "pobfem",
      "pobmas",
      "p_60ymas",
      "p_15ymas",
      "p_18ymas",
      "pea",
      "pocupada",
      "graproes",
      "tvivhab",
      "tvivpar",
      "pcatolica",
      "pro_crieva",
      "potras_rel",
      "psin_relig",
      "p3ym_hli",
      "p3hlinhe",
      "p3hli_he",
      "phog_ind",
      "pob_afro",
      "pnacent",
      "pnacoe",
      "pres2015",
      "presoe15",
      "p15ym_an",
      "p15ym_se",
      "p15pri_in",
      "p15pri_co",
      "p15sec_in",
      "p15sec_co",
      "p18ym_pb",
      "p12ym_solt",
      "p12ym_casa",
      "p12ym_sepa",
      "pcon_disc",
      "pcon_limi",
      "psind_lim",
      "psinder",
      "pder_ss",
      "pder_imss",
      "pder_iste",
      "pder_segp",
      "pder_imssb",
      "pafil_ipriv",
      "vph_inter",
      "vph_autom",
      "vph_refri",
      "vph_lavad",
      "vph_hmicro",
      "vph_moto",
      "vph_bici",
      "vph_radio",
      "vph_tv",
      "vph_pc",
      "vph_telef",
      "vph_cel",
      "vph_stvp",
      "vph_spmvpi",
      "vph_cvj",
      "vph_snbien",
    ]) {
      row[f] = null;
    }
    mockExec.mockReturnValue(JSON.stringify([row]));
    const app = createServer(CONFIG);
    const res = await app.request("/analytics/municipio-detail?cve_mun=09015", {
      headers: AUTH,
    });
    const body = (await res.json()) as MunicipioDetailResult;
    const i = body.inclusion_financiera;
    // Top-level keys
    expect(Object.keys(i).sort()).toEqual(
      [
        "acomodo",
        "condusef",
        "genero",
        "infraestructura",
        "periodo",
        "poblacion_adulta",
        "poblacion_total",
        "productos",
        "remesas",
        "rezago_social",
      ].sort(),
    );
    // muni grain → these should be present-keys-with-null
    expect(i.condusef).toBeNull();
    expect(i.acomodo).toBeNull();
    expect(i.productos.sar).toBeNull();
    expect(i.productos.seguros).toBeNull();
    // muni grain → these should be present-keys-with-non-null subtree
    expect(i.genero).not.toBeNull();
    expect(i.genero!.cuentas).toBeDefined();
    expect(i.genero!.creditos).toBeDefined();
  });
});
