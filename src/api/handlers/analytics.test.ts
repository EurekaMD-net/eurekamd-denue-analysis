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
  ApiServerConfig,
  ColoniasByAgebResult,
  ColoniasByMunicipioResult,
  LicensedPharmaciesByAgebResult,
  LicensedPharmaciesByMunicipioResult,
  ManzanasByAgebResult,
  MortalitySummaryResult,
  MortalityTrendResult,
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
