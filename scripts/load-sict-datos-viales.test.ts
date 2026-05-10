import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));

const { mockExists, mockMkdtemp, mockReadFile, mockRm, mockWriteFile } =
  vi.hoisted(() => ({
    mockExists: vi.fn(),
    mockMkdtemp: vi.fn(),
    mockReadFile: vi.fn(),
    mockRm: vi.fn(),
    mockWriteFile: vi.fn(),
  }));
vi.mock("node:fs", () => ({
  existsSync: mockExists,
  mkdtempSync: mockMkdtemp,
  readFileSync: mockReadFile,
  rmSync: mockRm,
  writeFileSync: mockWriteFile,
}));

import {
  loadSictDatosViales,
  NUMERIC_RAW_COLS,
  POST_LOAD_VERIFY_SQL,
  RAW_DDL,
  RAW_HEADER_COLS,
  STATIONS_VIEW_DDL,
  TRAFFIC_BY_ESTADO_DDL,
  TRAFFIC_BY_MUNI_DDL,
  VIEWS_DDL_TRANSACTION,
  rewriteHeader,
} from "./load-sict-datos-viales.js";

const CANONICAL_HEADER =
  "periodo,estado,carretera,clave,ruta,punto_generador,km,te,sc,tdpa,m,a,b,c2,c3,t3s2,t3s3,t3s2r4,otros,a1,b1,c,k',d,latitud,longitud";

const SAMPLE_CSV =
  CANONICAL_HEADER +
  "\nEnero-diciembre 2024,Aguascalientes,Acceso a Pabellon de Arteaga,1113.0,MEX-045,T. C. Aguascalientes - Zacatecas (Alta),0.0,3.0,1.0,6827.0,6.1,90.0,0.6,1.8,0.6,0.4,0.1,0.3,0.1,96.1,0.6,3.3,0.071,0.52,22.146662,-102.290244\n";

beforeEach(() => {
  mockExec.mockReset();
  mockExists.mockReset();
  mockMkdtemp.mockReset();
  mockReadFile.mockReset();
  mockRm.mockReset();
  mockWriteFile.mockReset();
  mockExists.mockReturnValue(true);
  mockMkdtemp.mockReturnValue("/tmp/sict-datos-viales-xyz");
});
afterEach(() => vi.restoreAllMocks());

/**
 * Drive a successful end-to-end load. Exec sequence (W1 fix: views combined):
 *   1. dockerExecStdin → RAW_DDL (CREATE TABLE)
 *   2. dockerExec → COUNT(*) idempotency guard
 *   3. dockerExecStdin → TRUNCATE
 *   4. execFileSync (no helper) → \copy
 *   5. dockerExecStdin → VIEWS_DDL_TRANSACTION (atomic BEGIN/COMMIT block)
 *   6. dockerExec → POST_LOAD_VERIFY_SQL
 *
 * `mockReadFile` returns the CSV TWICE: once for `rewriteHeader` and once
 * for the `\copy` STDIN buffer (we read the CLEANED tempfile back in).
 */
function stubHappyPath(): void {
  mockReadFile
    .mockReturnValueOnce(SAMPLE_CSV) // utf-8 read for rewriteHeader
    .mockReturnValueOnce(Buffer.from(SAMPLE_CSV.replace(",k',", ",k_prime,"))); // buffer for \copy
  mockExec
    .mockReturnValueOnce("CREATE TABLE\nCREATE INDEX\n") // RAW_DDL
    .mockReturnValueOnce("0\n") // COUNT(*) — empty
    .mockReturnValueOnce("TRUNCATE TABLE\n") // TRUNCATE
    .mockReturnValueOnce("COPY 1\n") // \copy
    .mockReturnValueOnce(
      "CREATE VIEW\nCREATE MATERIALIZED VIEW\nCREATE INDEX\nCOMMIT\n",
    ) // VIEWS_DDL_TRANSACTION
    .mockReturnValueOnce("10326|6827|1153|1153\n"); // verify
}

describe("rewriteHeader", () => {
  it("renames k' → k_prime and preserves body bytes", () => {
    const out = rewriteHeader(SAMPLE_CSV);
    expect(out.split("\n")[0]).toContain(",k_prime,");
    expect(out.split("\n")[0]).not.toContain(",k',");
    // Body row preserved verbatim
    expect(out.split("\n")[1]).toBe(SAMPLE_CSV.split("\n")[1]);
  });

  it("tolerates CRLF line endings", () => {
    const crlf = SAMPLE_CSV.replace("\n", "\r\n");
    const out = rewriteHeader(crlf);
    expect(out.split("\r\n")[0]).toContain(",k_prime,");
  });

  it("rejects unexpected header (schema drift early-warning)", () => {
    const drifted = CANONICAL_HEADER.replace(",ruta,", ",route,") + "\nx\n";
    expect(() => rewriteHeader(drifted)).toThrow(/Unexpected CSV header/);
  });

  it("rejects empty input", () => {
    expect(() => rewriteHeader("")).toThrow(/no newline/);
  });
});

describe("loadSictDatosViales (orchestration)", () => {
  it("aborts when raw table is non-empty and --force not supplied", async () => {
    mockExec
      .mockReturnValueOnce("CREATE TABLE\n") // RAW_DDL
      .mockReturnValueOnce("10326\n"); // COUNT(*) returns nonzero

    await expect(
      loadSictDatosViales({
        csv: "raw/sict/datos_viales_2024.csv",
        force: false,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/has 10326 rows/);
    // Should NOT have proceeded to truncate / copy / view DDL
    expect(mockExec.mock.calls.length).toBe(2);
  });

  it("happy path: applies schema, rewrites header, copies, builds views atomically, verifies", async () => {
    stubHappyPath();
    await loadSictDatosViales({
      csv: "raw/sict/datos_viales_2024.csv",
      force: true,
      container: "supabase-db",
    });
    // 6 exec calls in canonical order (W1: views merged into 1 transaction)
    expect(mockExec).toHaveBeenCalledTimes(6);

    // Call 1: RAW_DDL via stdin
    expect(mockExec.mock.calls[0]?.[2]).toMatchObject({ input: RAW_DDL });
    // Call 4: \copy command — args contain STDIN copy invocation
    const copyArgs = (mockExec.mock.calls[3]?.[1] ?? []) as string[];
    expect(copyArgs.join(" ")).toContain(
      `\\copy sict_estaciones_viales_raw_2024 (${RAW_HEADER_COLS.join(", ")}) FROM STDIN`,
    );
    // Call 5: VIEWS_DDL_TRANSACTION (single atomic call wrapping both DDLs)
    expect(mockExec.mock.calls[4]?.[2]).toMatchObject({
      input: VIEWS_DDL_TRANSACTION,
    });
    // Call 6: POST_LOAD_VERIFY_SQL
    expect(mockExec.mock.calls[5]?.[1]?.join(" ")).toContain(
      POST_LOAD_VERIFY_SQL,
    );
  });

  it("VIEWS_DDL_TRANSACTION wraps both DDLs in BEGIN/COMMIT (W1 atomicity)", () => {
    expect(VIEWS_DDL_TRANSACTION.startsWith("BEGIN;")).toBe(true);
    expect(VIEWS_DDL_TRANSACTION.endsWith("COMMIT;")).toBe(true);
    // Both view DDLs included verbatim
    expect(VIEWS_DDL_TRANSACTION).toContain(STATIONS_VIEW_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(TRAFFIC_BY_MUNI_DDL);
    // STATIONS view DDL appears BEFORE the MV DDL (the MV CTE references it)
    const statIdx = VIEWS_DDL_TRANSACTION.indexOf(STATIONS_VIEW_DDL);
    const mvIdx = VIEWS_DDL_TRANSACTION.indexOf(TRAFFIC_BY_MUNI_DDL);
    expect(statIdx).toBeLessThan(mvIdx);
    // Round-3 audit R1: pin the BEGIN ... DROP ... COMMIT shape so a future
    // refactor that inserts foreign statements (e.g. `\connect`) between
    // the markers and the DDL is caught. Allows `\echo` markers AND a
    // header comment block between them (the C1 fix adds explanatory
    // comments before the DROP cascade).
    expect(VIEWS_DDL_TRANSACTION).toMatch(
      /^BEGIN;\s+(\\echo[^\n]*\n\s*)?(--[^\n]*\n\s*)*DROP MATERIALIZED VIEW IF EXISTS sict_traffic_by_estado;\s*DROP MATERIALIZED VIEW IF EXISTS sict_traffic_by_municipio;[\s\S]*COMMIT;$/,
    );
    // Both \echo markers present for operator-facing failure localization.
    expect(VIEWS_DDL_TRANSACTION).toContain(
      "\\echo [load-sict] building stations view",
    );
    expect(VIEWS_DDL_TRANSACTION).toContain(
      "\\echo [load-sict] building traffic-by-municipio MV",
    );
    expect(VIEWS_DDL_TRANSACTION).toContain(
      "\\echo [load-sict] building traffic-by-estado MV",
    );
  });

  it("cleans up tempdir even on docker-exec failure during DDL step", async () => {
    // Round-3 audit C1: this test exercises the FINALLY-block tempdir
    // cleanup path when the Node-side `docker exec` invocation throws.
    // Postgres ROLLBACK semantics for the BEGIN/COMMIT block are NOT
    // exercised here — those rely on `ON_ERROR_STOP=1` at the psql layer
    // and are a Postgres responsibility, not the loader's. The mock
    // throws BEFORE psql receives SQL.
    mockReadFile
      .mockReturnValueOnce(SAMPLE_CSV)
      .mockReturnValueOnce(Buffer.from(SAMPLE_CSV));
    mockExec
      .mockReturnValueOnce("CREATE TABLE\n") // RAW_DDL ok
      .mockReturnValueOnce("0\n") // COUNT 0 — proceed
      .mockReturnValueOnce("TRUNCATE\n") // TRUNCATE ok
      .mockReturnValueOnce("COPY 1\n") // \copy ok
      .mockImplementationOnce(() => {
        // Simulate `docker exec` itself failing (container died, network
        // partition, etc.) at the VIEWS_DDL_TRANSACTION step.
        throw new Error("syntax error");
      });
    await expect(
      loadSictDatosViales({
        csv: "raw/sict/datos_viales_2024.csv",
        force: true,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/syntax error/);
    expect(mockRm).toHaveBeenCalledWith(
      "/tmp/sict-datos-viales-xyz",
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("rejects unsafe container name (anti docker-flag injection)", async () => {
    await expect(
      loadSictDatosViales({
        csv: "raw/sict/datos_viales_2024.csv",
        force: true,
        container: "--rm",
      }),
    ).rejects.toThrow(/unsafe container name/);
  });

  it("throws when CSV missing", async () => {
    mockExists.mockReturnValue(false);
    await expect(
      loadSictDatosViales({
        csv: "raw/sict/missing.csv",
        force: true,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/CSV not found/);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("DDL invariants", () => {
  it("RAW_DDL declares one TEXT column for every header column + ingested_at", () => {
    // Extract column declarations from RAW_DDL: lines like `<name> TEXT,` or `<name> TIMESTAMPTZ`
    const colRe = /^\s*(\w+)\s+(TEXT|TIMESTAMPTZ)/gm;
    const cols: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = colRe.exec(RAW_DDL))) cols.push(m[1]);
    // Drop "ingested_at" — meta col not in CSV
    const dataCols = cols.filter((c) => c !== "ingested_at");
    expect(dataCols).toEqual([...RAW_HEADER_COLS]);
    expect(cols).toContain("ingested_at");
  });

  it("NUMERIC_RAW_COLS subset of RAW_HEADER_COLS (no orphans)", () => {
    for (const n of NUMERIC_RAW_COLS) {
      expect(RAW_HEADER_COLS).toContain(n);
    }
  });

  it("STATIONS_VIEW_DDL casts every NUMERIC_RAW_COL via NULLIF (sentinel handling)", () => {
    for (const col of NUMERIC_RAW_COLS) {
      expect(STATIONS_VIEW_DDL).toContain(
        `NULLIF(NULLIF(NULLIF(${col}, ''), 'sin dato'), '*')::numeric AS ${col}`,
      );
    }
  });

  it("STATIONS_VIEW_DDL drops border duplicates via DISTINCT ON natural key", () => {
    expect(STATIONS_VIEW_DDL).toMatch(
      /DISTINCT ON \(latitud, longitud, clave, punto_generador, km, te, sc\)/,
    );
  });

  it("STATIONS_VIEW_DDL filters NULL lat/lon/tdpa rows", () => {
    expect(STATIONS_VIEW_DDL).toContain(
      "WHERE NULLIF(latitud, '') IS NOT NULL",
    );
    expect(STATIONS_VIEW_DDL).toContain("AND NULLIF(longitud, '') IS NOT NULL");
    expect(STATIONS_VIEW_DDL).toContain("AND NULLIF(tdpa, '') IS NOT NULL");
  });

  it("STATIONS_VIEW_DDL drops dependent MVs (estado, then muni) BEFORE the base view (audit C1)", () => {
    // Postgres DROP VIEW does not cascade. After v0.2.15 ships, a second
    // --force reload would fail with "cannot drop view sict_estaciones_viales
    // because other objects depend on it" if the estado MV isn't dropped
    // first. Pin the ordering so a future regression aborts at unit-test time.
    const dropEstado = STATIONS_VIEW_DDL.indexOf(
      "DROP MATERIALIZED VIEW IF EXISTS sict_traffic_by_estado",
    );
    const dropMuni = STATIONS_VIEW_DDL.indexOf(
      "DROP MATERIALIZED VIEW IF EXISTS sict_traffic_by_municipio",
    );
    const dropView = STATIONS_VIEW_DDL.indexOf(
      "DROP VIEW IF EXISTS sict_estaciones_viales",
    );
    expect(dropEstado).toBeGreaterThan(0);
    expect(dropMuni).toBeGreaterThan(dropEstado);
    expect(dropView).toBeGreaterThan(dropMuni);
  });

  it("STATIONS_VIEW_DDL spatial-joins via ST_Contains with SRID 4326", () => {
    expect(STATIONS_VIEW_DDL).toContain("ST_Contains(mp.geom");
    expect(STATIONS_VIEW_DDL).toContain(
      "ST_SetSRID(ST_MakePoint(d.longitud, d.latitud), 4326)",
    );
    // Lon comes BEFORE lat in PostGIS Point construction (X=lon, Y=lat).
    expect(STATIONS_VIEW_DDL).toMatch(
      /ST_MakePoint\(d\.longitud,\s*d\.latitud\)/,
    );
  });

  it("TRAFFIC_BY_MUNI_DDL is MATERIALIZED with btree index on cve_mun", () => {
    expect(TRAFFIC_BY_MUNI_DDL).toContain(
      "CREATE MATERIALIZED VIEW sict_traffic_by_municipio",
    );
    expect(TRAFFIC_BY_MUNI_DDL).toContain(
      "CREATE UNIQUE INDEX idx_sict_tbm_cve_mun",
    );
  });

  it("TRAFFIC_BY_MUNI_DDL camiones aggregates ALL 5 truck-axle classes", () => {
    // pct_camiones = c2 + c3 + t3s2 + t3s3 + t3s2r4 (TDPA-weighted)
    expect(TRAFFIC_BY_MUNI_DDL).toContain(
      "(c2 + c3 + t3s2 + t3s3 + t3s2r4) * tdpa",
    );
  });

  it("TRAFFIC_BY_MUNI_DDL guards weighted-avg division-by-zero", () => {
    // Every TDPA-weighted aggregate must use NULLIF(SUM(tdpa), 0)
    const matches = TRAFFIC_BY_MUNI_DDL.match(/NULLIF\(SUM\(tdpa\),\s*0\)/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(5); // 5 composition pcts
  });

  it("TRAFFIC_BY_MUNI_DDL returns empty array (not NULL) for routes_top fallback", () => {
    expect(TRAFFIC_BY_MUNI_DDL).toContain(
      "COALESCE(tr.routes_top, ARRAY[]::TEXT[]) AS routes_top",
    );
  });

  it("TRAFFIC_BY_MUNI_DDL ARRAY_AGG tie-breaker matches inner ROW_NUMBER (audit W1)", () => {
    // Without the secondary `ruta ASC`, ARRAY_AGG output order is
    // nondeterministic on count ties — REFRESH cycles can reshuffle
    // routes_top even with no underlying data change. Pinned in the
    // estado MV from day-one; backported here in the same bundle.
    expect(TRAFFIC_BY_MUNI_DDL).toContain(
      "ARRAY_AGG(ruta ORDER BY n DESC, ruta ASC)",
    );
  });

  // --- v0.2.15: estado-grain MV ---

  it("TRAFFIC_BY_ESTADO_DDL is MATERIALIZED with unique btree index on cve_ent", () => {
    expect(TRAFFIC_BY_ESTADO_DDL).toContain(
      "CREATE MATERIALIZED VIEW sict_traffic_by_estado",
    );
    expect(TRAFFIC_BY_ESTADO_DDL).toContain(
      "CREATE UNIQUE INDEX idx_sict_tbe_cve_ent",
    );
    expect(TRAFFIC_BY_ESTADO_DDL).toContain(
      "CREATE INDEX idx_sict_tbe_tdpa_total",
    );
  });

  it("TRAFFIC_BY_ESTADO_DDL aggregates from station-level dedupe view, not muni MV", () => {
    // Critical correctness invariant: re-applying TDPA-weighted formula at
    // estado grain MUST use station-level rows. Aggregating from
    // sict_traffic_by_municipio would give percentage-of-percentages drift.
    expect(TRAFFIC_BY_ESTADO_DDL).toContain("FROM sict_estaciones_viales");
    expect(TRAFFIC_BY_ESTADO_DDL).not.toContain("sict_traffic_by_municipio");
  });

  it("TRAFFIC_BY_ESTADO_DDL groups by SUBSTRING(cve_mun, 1, 2) for spatial-join attribution", () => {
    // Estado attribution derives from spatially-joined cve_mun, not the
    // CSV-published estado column — keeps semantics aligned with muni MV.
    expect(TRAFFIC_BY_ESTADO_DDL).toContain(
      "GROUP BY SUBSTRING(cve_mun, 1, 2)",
    );
  });

  it("TRAFFIC_BY_ESTADO_DDL camiones aggregates ALL 5 truck-axle classes", () => {
    expect(TRAFFIC_BY_ESTADO_DDL).toContain(
      "(c2 + c3 + t3s2 + t3s3 + t3s2r4) * tdpa",
    );
  });

  it("TRAFFIC_BY_ESTADO_DDL guards weighted-avg division-by-zero on every pct", () => {
    const matches = TRAFFIC_BY_ESTADO_DDL.match(/NULLIF\(SUM\(tdpa\),\s*0\)/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("TRAFFIC_BY_ESTADO_DDL returns empty array (not NULL) for routes_top fallback", () => {
    expect(TRAFFIC_BY_ESTADO_DDL).toContain(
      "COALESCE(tr.routes_top, ARRAY[]::TEXT[]) AS routes_top",
    );
  });

  it("TRAFFIC_BY_ESTADO_DDL ROW_NUMBER + ARRAY_AGG tie-breakers symmetric (audit R2/R3)", () => {
    // Two layers must match: which routes survive the rk<=3 cut (inner
    // ROW_NUMBER) AND the order they appear in routes_top (outer ARRAY_AGG).
    // Both must use COUNT(*) DESC, ruta ASC — otherwise REFRESH cycles
    // can shuffle either WHO makes the top-3 OR the top-3's order on ties.
    expect(TRAFFIC_BY_ESTADO_DDL).toContain(
      "ARRAY_AGG(ruta ORDER BY n DESC, ruta ASC)",
    );
    expect(TRAFFIC_BY_ESTADO_DDL).toContain("ORDER BY COUNT(*) DESC, ruta ASC");
  });

  it("VIEWS_DDL_TRANSACTION embeds estado MV between muni MV and COMMIT", () => {
    const idxMuni = VIEWS_DDL_TRANSACTION.indexOf(
      "sict_traffic_by_municipio AS",
    );
    const idxEstado = VIEWS_DDL_TRANSACTION.indexOf(
      "sict_traffic_by_estado AS",
    );
    const idxCommit = VIEWS_DDL_TRANSACTION.lastIndexOf("COMMIT;");
    expect(idxMuni).toBeGreaterThan(0);
    expect(idxEstado).toBeGreaterThan(idxMuni);
    expect(idxCommit).toBeGreaterThan(idxEstado);
  });

  it("POST_LOAD_VERIFY_SQL counts both grain MVs", () => {
    expect(POST_LOAD_VERIFY_SQL).toContain(
      "SELECT COUNT(*) FROM sict_traffic_by_municipio",
    );
    expect(POST_LOAD_VERIFY_SQL).toContain(
      "SELECT COUNT(*) FROM sict_traffic_by_estado",
    );
  });
});

describe("refresh-matviews.sh integration (regression guard)", () => {
  // Bug-class: v0.2.13 SICT muni and v0.2.14 SEDATU loaders BOTH shipped
  // without their MV listed in refresh-matviews.sh. Both caught as audit C1.
  // This guard makes the regression a unit-test failure, not an audit find.
  it("references sict_traffic_by_estado in REFRESH list", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const path = await vi.importActual<typeof import("node:path")>("node:path");
    const scriptPath = path.resolve(__dirname, "refresh-matviews.sh");
    const script = fs.readFileSync(scriptPath, "utf-8");
    expect(script).toMatch(/REFRESH MATERIALIZED VIEW sict_traffic_by_estado/);
  });

  it("still references sict_traffic_by_municipio (no regression)", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const path = await vi.importActual<typeof import("node:path")>("node:path");
    const scriptPath = path.resolve(__dirname, "refresh-matviews.sh");
    const script = fs.readFileSync(scriptPath, "utf-8");
    expect(script).toMatch(
      /REFRESH MATERIALIZED VIEW sict_traffic_by_municipio/,
    );
  });
});
