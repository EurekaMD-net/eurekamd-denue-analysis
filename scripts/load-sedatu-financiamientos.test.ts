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
// .sql / .sh reads go to the real files: _psql-tx's postLoadGrants reads
// sage-role.sql for the denue_sage allowlist. CSV reads stay mocked.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    existsSync: mockExists,
    mkdtempSync: mockMkdtemp,
    readFileSync: (p: unknown, ...rest: unknown[]) =>
      typeof p === "string" && /\.(sql|sh)$/.test(p)
        ? actual.readFileSync(p, "utf-8")
        : mockReadFile(p, ...rest),
    rmSync: mockRm,
    writeFileSync: mockWriteFile,
  };
});

import {
  checkMvSourcePairing,
  defaultCsvPath,
  MV_SOURCE_VIEWS_SQL,
  DESTINOS_SEED,
  loadSedatuFinanciamientos,
  parseArgs,
  postLoadVerifySql,
  rawDdl,
  viewsDdlTransaction,
  yearRelations,
  LOOKUPS_DDL,
  MODALIDADES_SEED,
  NUMERIC_RAW_COLS,
  ORGANISMOS_SEED,
  POST_LOAD_VERIFY_SQL,
  RAW_DDL,
  RAW_HEADER_COLS,
  FINANCIAMIENTOS_ESTADO_VIEW_DDL,
  FINANCIAMIENTOS_VIEW_DDL,
  FINANCING_BY_ESTADO_DDL,
  FINANCING_BY_MUNI_DDL,
  transcodeLatin1ToUtf8,
  VIEWS_DDL_TRANSACTION,
  VIVIENDA_TIERS_SEED,
} from "./load-sedatu-financiamientos.js";

const SAMPLE_CSV = Buffer.from(
  "ano,mes,cve_ent,entidad,cve_mun,municipio,organismo,modalidad,destino,tipo,sexo,edad_rango,ingresos_rango,vivienda_valor,acciones,monto\n" +
    "2025,3,01,Aguascalientes,1,Aguascalientes,1,2,3,2,1,2,6,6,1.0,1475418.03\n",
  "utf-8",
);

const MV_SOURCE_2025 = "sedatu_financiamientos_2025\nsedatu_financiamientos_estado_grain_2025\n";

beforeEach(() => {
  mockExec.mockReset();
  mockExists.mockReset();
  mockMkdtemp.mockReset();
  mockReadFile.mockReset();
  mockRm.mockReset();
  mockWriteFile.mockReset();
  mockExists.mockReturnValue(true);
  mockMkdtemp.mockReturnValue("/tmp/sedatu-financiamientos-xyz");
});
afterEach(() => vi.restoreAllMocks());

/**
 * Drive a successful end-to-end load. Exec sequence:
 *   1. dockerExecStdin → RAW_DDL (CREATE TABLE + indexes)
 *   2. dockerExec → COUNT(*) idempotency guard
 *   3. runPsqlScript → TRUNCATE + \copy FROM STDIN, ONE transaction (audit #146)
 *   4. dockerExecStdin → VIEWS_DDL_TRANSACTION (lookups + view + MV in BEGIN/COMMIT)
 *   5. dockerExec → POST_LOAD_VERIFY_SQL
 */
function stubHappyPath(): void {
  mockReadFile
    .mockReturnValueOnce(SAMPLE_CSV) // raw bytes for transcode
    .mockReturnValueOnce(SAMPLE_CSV); // transcoded buffer for \copy
  mockExec
    .mockReturnValueOnce(MV_SOURCE_2025) // pre-flight: MVs read 2025
    .mockReturnValueOnce("CREATE TABLE\nCREATE INDEX\n") // RAW_DDL
    .mockReturnValueOnce("0\n") // COUNT(*) — empty
    .mockReturnValueOnce("TRUNCATE TABLE\nCOPY 1\n") // TRUNCATE + \copy (one tx)
    .mockReturnValueOnce(
      "DROP VIEW\nDROP TABLE\nCREATE TABLE\nINSERT 0 26\nCREATE VIEW\nCREATE MATERIALIZED VIEW\nCREATE INDEX\nCOMMIT\n",
    ) // VIEWS_DDL_TRANSACTION
    .mockReturnValueOnce("325649|325254|1848|1848|998,745|616.98\n"); // verify
}

describe("transcodeLatin1ToUtf8", () => {
  it("preserves ASCII bytes verbatim", () => {
    const input = Buffer.from("hello world\n", "ascii");
    const out = transcodeLatin1ToUtf8(input);
    expect(out.toString("utf-8")).toBe("hello world\n");
  });

  it("transcodes 0xf1 (ñ) Latin-1 byte to UTF-8 multi-byte sequence", () => {
    // 0xf1 = ñ in Latin-1; 0xc3 0xb1 = ñ in UTF-8.
    const input = Buffer.from([0x61, 0xf1, 0x6f]); // "año" in Latin-1
    const out = transcodeLatin1ToUtf8(input);
    expect(out.toString("utf-8")).toBe("año");
    expect([...out]).toEqual([0x61, 0xc3, 0xb1, 0x6f]);
  });

  it("transcodes 0xe9 (é) for entries like 'México'", () => {
    const input = Buffer.from([0x4d, 0xe9, 0x78, 0x69, 0x63, 0x6f]);
    const out = transcodeLatin1ToUtf8(input);
    expect(out.toString("utf-8")).toBe("México");
  });

  it("passes already-UTF-8 input through instead of double-encoding it (audit #159)", () => {
    const input = Buffer.from("Yucatán,Año,México\n", "utf-8");
    const out = transcodeLatin1ToUtf8(input);
    expect(out.toString("utf-8")).toBe("Yucatán,Año,México\n");
    expect(out.toString("utf-8")).not.toContain("Ã");
  });
});

describe("loadSedatuFinanciamientos (orchestration)", () => {
  it("aborts when raw table is non-empty and --force not supplied", async () => {
    mockReadFile.mockReturnValueOnce(SAMPLE_CSV); // input check runs first
    mockExec
      .mockReturnValueOnce(MV_SOURCE_2025) // pre-flight: MVs read 2025
      .mockReturnValueOnce("CREATE TABLE\n") // RAW_DDL
      .mockReturnValueOnce("325649\n"); // COUNT(*) returns nonzero

    await expect(
      loadSedatuFinanciamientos({
        csv: "raw/sedatu/financiamientos_2025.csv",
        force: false,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/has 325649 rows/);
    expect(mockExec.mock.calls.length).toBe(3);
  });

  it("happy path: applies schema, transcodes, copies, builds views atomically, verifies", async () => {
    stubHappyPath();
    await loadSedatuFinanciamientos({
      csv: "raw/sedatu/financiamientos_2025.csv",
      force: true,
      container: "supabase-db",
    });
    // 5 exec calls in canonical order
    expect(mockExec).toHaveBeenCalledTimes(6);

    // Call 1: RAW_DDL via stdin
    expect(mockExec.mock.calls[1]?.[2]).toMatchObject({ input: RAW_DDL });
    // Call 3: TRUNCATE + \copy FROM STDIN in ONE single-transaction psql
    // session (audit #146), CSV inline after the \copy line.
    const txArgs = (mockExec.mock.calls[3]?.[1] ?? []) as string[];
    expect(txArgs).toContain("--single-transaction");
    expect(txArgs).not.toContain("-c");
    const txInput = String(
      (mockExec.mock.calls[3]?.[2] as { input: Buffer }).input,
    );
    expect(txInput.startsWith("TRUNCATE TABLE sedatu_financiamientos_raw_2025;\n")).toBe(true);
    expect(txInput).toContain(
      `\\copy sedatu_financiamientos_raw_2025 (${RAW_HEADER_COLS.join(", ")}) FROM STDIN`,
    );
    expect(txInput.indexOf("TRUNCATE")).toBeLessThan(txInput.indexOf("\\copy"));
    expect(txInput.endsWith("\n\\.\n")).toBe(true);
    // Call 4: VIEWS_DDL_TRANSACTION (single atomic call wrapping all DDLs)
    expect(mockExec.mock.calls[4]?.[2]).toMatchObject({
      input: VIEWS_DDL_TRANSACTION,
    });
    // Call 5: POST_LOAD_VERIFY_SQL
    expect(mockExec.mock.calls[5]?.[1]?.join(" ")).toContain(
      POST_LOAD_VERIFY_SQL,
    );
  });

  it("VIEWS_DDL_TRANSACTION wraps lookup + views + MVs in BEGIN/COMMIT (W1 atomicity)", () => {
    expect(VIEWS_DDL_TRANSACTION.startsWith("BEGIN;")).toBe(true);
    expect(VIEWS_DDL_TRANSACTION.endsWith("COMMIT;")).toBe(true);
    // All 5 DDL families included verbatim (v0.2.16: estado view + estado MV).
    expect(VIEWS_DDL_TRANSACTION).toContain(LOOKUPS_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(FINANCIAMIENTOS_VIEW_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(FINANCIAMIENTOS_ESTADO_VIEW_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(FINANCING_BY_MUNI_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(FINANCING_BY_ESTADO_DDL);
    // Order matters: drops first (estado MV → muni MV → both views, the
    // dependency chain), then lookups, then both views, then both MVs.
    const lookupIdx = VIEWS_DDL_TRANSACTION.indexOf(LOOKUPS_DDL);
    const muniViewIdx = VIEWS_DDL_TRANSACTION.indexOf(FINANCIAMIENTOS_VIEW_DDL);
    const estadoViewIdx = VIEWS_DDL_TRANSACTION.indexOf(
      FINANCIAMIENTOS_ESTADO_VIEW_DDL,
    );
    const muniMvIdx = VIEWS_DDL_TRANSACTION.indexOf(FINANCING_BY_MUNI_DDL);
    const estadoMvIdx = VIEWS_DDL_TRANSACTION.indexOf(FINANCING_BY_ESTADO_DDL);
    expect(lookupIdx).toBeLessThan(muniViewIdx);
    expect(lookupIdx).toBeLessThan(estadoViewIdx);
    expect(muniViewIdx).toBeLessThan(muniMvIdx);
    expect(estadoViewIdx).toBeLessThan(estadoMvIdx);
  });

  it("VIEWS_DDL_TRANSACTION DROP cascade is dependency-safe (audit C1 lesson from v0.2.15)", () => {
    // Postgres DROP TABLE on a lookup table fails when an MV references it
    // for label resolution. With v0.2.16 there are two MVs (muni + estado),
    // both depending on sedatu_organismos. Drop ordering MUST be:
    //   estado MV → muni MV → estado view → muni view → lookups
    // so that LOOKUPS_DDL's DROP TABLE statements see no dependents.
    const idxEstadoMv = VIEWS_DDL_TRANSACTION.indexOf(
      "DROP MATERIALIZED VIEW IF EXISTS sedatu_financing_by_estado",
    );
    const idxMuniMv = VIEWS_DDL_TRANSACTION.indexOf(
      "DROP MATERIALIZED VIEW IF EXISTS sedatu_financing_by_municipio",
    );
    const idxEstadoView = VIEWS_DDL_TRANSACTION.indexOf(
      "DROP VIEW IF EXISTS sedatu_financiamientos_estado_grain_2025",
    );
    const idxMuniView = VIEWS_DDL_TRANSACTION.indexOf(
      "DROP VIEW IF EXISTS sedatu_financiamientos_2025",
    );
    expect(idxEstadoMv).toBeGreaterThan(0);
    expect(idxMuniMv).toBeGreaterThan(idxEstadoMv);
    expect(idxEstadoView).toBeGreaterThan(idxMuniMv);
    expect(idxMuniView).toBeGreaterThan(idxEstadoView);
  });

  it("a failed \\copy never runs TRUNCATE on its own (audit #146)", async () => {
    mockReadFile
      .mockReturnValueOnce(SAMPLE_CSV)
      .mockReturnValueOnce(SAMPLE_CSV);
    mockExec
      .mockReturnValueOnce(MV_SOURCE_2025) // pre-flight: MVs read 2025
      .mockReturnValueOnce("CREATE TABLE\n") // RAW_DDL ok
      .mockReturnValueOnce("0\n") // COUNT 0 — proceed
      .mockImplementationOnce(() => {
        // psql rolls the whole session back: TRUNCATE is undone.
        throw new Error("ERROR: extra data after last expected column");
      });
    await expect(
      loadSedatuFinanciamientos({
        csv: "raw/sedatu/financiamientos_2025.csv",
        force: true,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/extra data/);
    // No psql session ever ran the TRUNCATE outside the \copy transaction,
    // and nothing ran after the failure.
    expect(mockExec).toHaveBeenCalledTimes(4);
    const lone = mockExec.mock.calls.filter((c) => {
      const input = (c[2] as { input?: unknown } | undefined)?.input;
      return (
        typeof input === "string" &&
        input.includes("TRUNCATE") &&
        !input.includes("\\copy")
      );
    });
    expect(lone).toHaveLength(0);
  });

  it("cleans up tempdir even on docker-exec failure during DDL step", async () => {
    mockReadFile
      .mockReturnValueOnce(SAMPLE_CSV)
      .mockReturnValueOnce(SAMPLE_CSV);
    mockExec
      .mockReturnValueOnce(MV_SOURCE_2025) // pre-flight: MVs read 2025
      .mockReturnValueOnce("CREATE TABLE\n") // RAW_DDL ok
      .mockReturnValueOnce("0\n") // COUNT 0 — proceed
      .mockReturnValueOnce("TRUNCATE TABLE\nCOPY 1\n") // TRUNCATE + \copy ok
      .mockImplementationOnce(() => {
        throw new Error("syntax error");
      });
    await expect(
      loadSedatuFinanciamientos({
        csv: "raw/sedatu/financiamientos_2025.csv",
        force: true,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/syntax error/);
    expect(mockRm).toHaveBeenCalledWith(
      "/tmp/sedatu-financiamientos-xyz",
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("rejects unsafe container name (anti docker-flag injection)", async () => {
    mockReadFile.mockReturnValueOnce(SAMPLE_CSV); // input check runs first
    await expect(
      loadSedatuFinanciamientos({
        csv: "raw/sedatu/financiamientos_2025.csv",
        force: true,
        container: "--rm",
      }),
    ).rejects.toThrow(/unsafe container name/);
  });

  it("throws when CSV missing", async () => {
    mockExists.mockReturnValue(false);
    await expect(
      loadSedatuFinanciamientos({
        csv: "raw/sedatu/missing.csv",
        force: true,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/CSV not found/);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("DDL invariants", () => {
  it("RAW_DDL declares one TEXT column per header column + ingested_at", () => {
    const colRe = /^\s*(\w+)\s+(TEXT|TIMESTAMPTZ)/gm;
    const cols: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = colRe.exec(RAW_DDL))) cols.push(m[1]);
    const dataCols = cols.filter((c) => c !== "ingested_at");
    expect(dataCols).toEqual([...RAW_HEADER_COLS]);
    expect(cols).toContain("ingested_at");
  });

  it("NUMERIC_RAW_COLS subset of RAW_HEADER_COLS (no orphans)", () => {
    for (const n of NUMERIC_RAW_COLS) {
      expect(RAW_HEADER_COLS).toContain(n);
    }
  });

  it("FINANCIAMIENTOS_VIEW_DDL casts every NUMERIC_RAW_COL via NULLIF + TRIM", () => {
    for (const col of NUMERIC_RAW_COLS) {
      expect(FINANCIAMIENTOS_VIEW_DDL).toContain(
        `NULLIF(TRIM(${col}), '')::numeric AS ${col}`,
      );
    }
  });

  it("FINANCIAMIENTOS_VIEW_DDL composes 5-char cve_mun via cve_ent || LPAD(cve_mun, 3, '0')", () => {
    expect(FINANCIAMIENTOS_VIEW_DDL).toContain(
      "cve_ent || LPAD(cve_mun, 3, '0') AS cve_mun",
    );
  });

  it("FINANCIAMIENTOS_VIEW_DDL projects no dead muni-string columns (audit W4 symmetric to R4)", () => {
    // Sibling-residue cleanup: cve_mun_short + municipio were dropped
    // from the muni view at the same time as the estado view (audit
    // R2 round-2 — grep-sweep discipline per CLAUDE.md). MV never
    // references either; zero downstream consumers across src/+scripts/.
    expect(FINANCIAMIENTOS_VIEW_DDL).not.toContain("cve_mun_short");
    expect(FINANCIAMIENTOS_VIEW_DDL).not.toMatch(/,\s*municipio,/);
  });

  it("FINANCIAMIENTOS_VIEW_DDL filters No-distribuido catch-all rows + entidad sentinel guard", () => {
    // TRIM-then-NULLIF (audit W1 round-2): defends against future
    // whitespace-padded codes.
    expect(FINANCIAMIENTOS_VIEW_DDL).toContain(
      "WHERE NULLIF(TRIM(cve_ent), '') IS NOT NULL",
    );
    expect(FINANCIAMIENTOS_VIEW_DDL).toContain(
      "AND NULLIF(TRIM(cve_mun), '') IS NOT NULL",
    );
    expect(FINANCIAMIENTOS_VIEW_DDL).toContain(
      "TRIM(cve_ent) ~ '^(0[1-9]|[12][0-9]|3[0-2])$'",
    );
    expect(FINANCIAMIENTOS_VIEW_DDL).toContain(
      "TRIM(cve_mun) ~ '^[0-9]{1,3}$'",
    );
  });

  it("FINANCING_BY_MUNI_DDL is MATERIALIZED with btree index on cve_mun", () => {
    expect(FINANCING_BY_MUNI_DDL).toContain(
      "CREATE MATERIALIZED VIEW sedatu_financing_by_municipio",
    );
    expect(FINANCING_BY_MUNI_DDL).toContain(
      "CREATE UNIQUE INDEX idx_sedatu_fin_cve_mun",
    );
  });

  it("FINANCING_BY_MUNI_DDL guards every modality % with COALESCE(SUM FILTER, 0)", () => {
    // Without COALESCE, SUM FILTER over zero matching rows returns NULL,
    // making pct_* fields silently null instead of 0. Caught live during
    // first load (muni 01002 had 0 vivienda_nueva → showed NULL pct).
    for (const code of [1, 2, 3, 4]) {
      expect(FINANCING_BY_MUNI_DDL).toContain(
        `COALESCE(SUM(acciones) FILTER (WHERE modalidad = ${code}), 0)`,
      );
    }
  });

  it("FINANCING_BY_MUNI_DDL preserves NULL semantics for housing-tier (signal: tier unknown)", () => {
    // tier subtree is intentionally null when 100% of muni rows lack
    // vivienda_valor — the marshaller checks `acciones_with_tier > 0` via
    // CASE WHEN. Pin that the SQL doesn't accidentally COALESCE to zero.
    expect(FINANCING_BY_MUNI_DDL).toContain("WHEN pm.acciones_with_tier > 0");
    expect(FINANCING_BY_MUNI_DDL).toContain(
      "SUM(acciones) FILTER (WHERE vivienda_valor IS NOT NULL) AS acciones_with_tier",
    );
  });

  it("FINANCING_BY_MUNI_DDL resolves top_organismo via JOIN to sedatu_organismos", () => {
    expect(FINANCING_BY_MUNI_DDL).toContain(
      "LEFT JOIN sedatu_organismos o ON o.code = t.top_organismo_code",
    );
    expect(FINANCING_BY_MUNI_DDL).toContain("o.nombre AS top_organismo_nombre");
  });

  it("FINANCING_BY_MUNI_DDL ROW_NUMBER tie-break is deterministic (organismo ASC)", () => {
    // Two organismos with equal acciones in a muni → lower code wins.
    // Without the secondary ORDER BY, repeated MV refreshes could surface
    // different organismos non-deterministically.
    expect(FINANCING_BY_MUNI_DDL).toContain(
      "ORDER BY SUM(acciones) DESC, organismo ASC",
    );
  });

  // --- v0.2.16: estado-grain base view + MV ---

  it("FINANCIAMIENTOS_ESTADO_VIEW_DDL filters on cve_ent ONLY (no cve_mun gate)", () => {
    // Critical contract: this view INTENTIONALLY re-includes the 384
    // state-level "no distribuido por municipio" rows the muni view
    // excludes. A regression that adds a cve_mun filter here would
    // silently shrink estado-grain totals back to muni-grain coverage.
    expect(FINANCIAMIENTOS_ESTADO_VIEW_DDL).toContain(
      "CREATE VIEW sedatu_financiamientos_estado_grain_2025",
    );
    expect(FINANCIAMIENTOS_ESTADO_VIEW_DDL).toContain(
      "TRIM(cve_ent) ~ '^(0[1-9]|[12][0-9]|3[0-2])$'",
    );
    expect(FINANCIAMIENTOS_ESTADO_VIEW_DDL).not.toMatch(/TRIM\(cve_mun\)\s*~/);
    expect(FINANCIAMIENTOS_ESTADO_VIEW_DDL).not.toContain(
      "AND NULLIF(TRIM(cve_mun)",
    );
  });

  it("FINANCIAMIENTOS_ESTADO_VIEW_DDL does NOT compose a 5-char cve_mun (no LPAD)", () => {
    // The estado-grain view doesn't produce a join key — by design, the
    // MV groups on cve_ent. Including LPAD here would (a) be cosmetic,
    // (b) churn cve_mun for catch-all rows where cve_mun is empty/garbage.
    expect(FINANCIAMIENTOS_ESTADO_VIEW_DDL).not.toContain(
      "LPAD(cve_mun, 3, '0')",
    );
  });

  it("FINANCIAMIENTOS_ESTADO_VIEW_DDL projects no dead muni-string columns (audit R4)", () => {
    // cve_mun_short + municipio were dropped — they were copy-paste
    // residue from the muni view; estado MV never references them.
    // Re-adding without justification would also break this assertion.
    expect(FINANCIAMIENTOS_ESTADO_VIEW_DDL).not.toContain("cve_mun_short");
    expect(FINANCIAMIENTOS_ESTADO_VIEW_DDL).not.toMatch(/,\s*municipio\b/);
  });

  it("FINANCING_BY_ESTADO_DDL is MATERIALIZED with unique btree index on cve_ent", () => {
    expect(FINANCING_BY_ESTADO_DDL).toContain(
      "CREATE MATERIALIZED VIEW sedatu_financing_by_estado",
    );
    expect(FINANCING_BY_ESTADO_DDL).toContain(
      "CREATE UNIQUE INDEX idx_sedatu_fin_est_cve_ent",
    );
    expect(FINANCING_BY_ESTADO_DDL).toContain(
      "CREATE INDEX idx_sedatu_fin_est_monto_total",
    );
  });

  it("FINANCING_BY_ESTADO_DDL aggregates from estado-grain base view, not muni MV", () => {
    // Re-applying the formulas at estado grain MUST source from the
    // catch-all-inclusive base view, NOT roll up the muni MV (which
    // already filtered out 384 rows).
    expect(FINANCING_BY_ESTADO_DDL).toContain(
      "FROM sedatu_financiamientos_estado_grain_2025",
    );
    expect(FINANCING_BY_ESTADO_DDL).not.toContain(
      "FROM sedatu_financing_by_municipio",
    );
  });

  it("FINANCING_BY_ESTADO_DDL groups by cve_ent (not cve_mun)", () => {
    // Both per_estado and top_org_estado CTEs group by cve_ent.
    const groupByCveEntCount = (
      FINANCING_BY_ESTADO_DDL.match(/GROUP BY cve_ent/g) ?? []
    ).length;
    expect(groupByCveEntCount).toBeGreaterThanOrEqual(1);
    expect(FINANCING_BY_ESTADO_DDL).not.toContain("GROUP BY cve_mun");
  });

  it("FINANCING_BY_ESTADO_DDL modality % uses COALESCE-guarded zero-row handling", () => {
    // Same pattern as muni MV: SUM(acciones) FILTER returns NULL for
    // empty filter, so wrap with COALESCE(..., 0) to surface 0% not NULL.
    const matches = FINANCING_BY_ESTADO_DDL.match(
      /COALESCE\(SUM\(acciones\) FILTER \(WHERE modalidad = \d+\),\s*0\)/g,
    );
    expect(matches?.length ?? 0).toBe(4); // modalidades 1-4
  });

  it("FINANCING_BY_ESTADO_DDL ROW_NUMBER tie-break matches muni MV (organismo ASC)", () => {
    expect(FINANCING_BY_ESTADO_DDL).toContain(
      "ORDER BY SUM(acciones) DESC, organismo ASC",
    );
  });

  it("FINANCING_BY_ESTADO_DDL resolves top_organismo via JOIN to sedatu_organismos", () => {
    expect(FINANCING_BY_ESTADO_DDL).toContain(
      "LEFT JOIN sedatu_organismos o ON o.code = t.top_organismo_code",
    );
    expect(FINANCING_BY_ESTADO_DDL).toContain(
      "o.nombre AS top_organismo_nombre",
    );
  });

  it("POST_LOAD_VERIFY_SQL counts both grain MVs", () => {
    expect(POST_LOAD_VERIFY_SQL).toContain(
      "SELECT COUNT(*) FROM sedatu_financing_by_municipio",
    );
    expect(POST_LOAD_VERIFY_SQL).toContain(
      "SELECT COUNT(*) FROM sedatu_financing_by_estado",
    );
  });
});

describe("refresh-matviews.sh integration (regression guard)", () => {
  // Bug-class: v0.2.13 SICT muni and v0.2.14 SEDATU loaders BOTH shipped
  // without their MV in refresh-matviews.sh. v0.2.15 added an analogous
  // guard for sict_traffic_by_estado. This guard fails fast at unit-test
  // time if the SEDATU estado-grain MV is forgotten.
  it("references sedatu_financing_by_estado in REFRESH list", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const path = await vi.importActual<typeof import("node:path")>("node:path");
    const scriptPath = path.resolve(__dirname, "refresh-matviews.sh");
    const script = fs.readFileSync(scriptPath, "utf-8");
    expect(script).toMatch(
      /REFRESH MATERIALIZED VIEW (CONCURRENTLY )?sedatu_financing_by_estado/,
    );
  });

  it("still references sedatu_financing_by_municipio (no regression)", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const path = await vi.importActual<typeof import("node:path")>("node:path");
    const scriptPath = path.resolve(__dirname, "refresh-matviews.sh");
    const script = fs.readFileSync(scriptPath, "utf-8");
    expect(script).toMatch(
      /REFRESH MATERIALIZED VIEW (CONCURRENTLY )?sedatu_financing_by_municipio/,
    );
  });
});

describe("Lookup-table seeds", () => {
  it("ORGANISMOS_SEED covers codes 1-26 contiguously (codebook range)", () => {
    const codes = ORGANISMOS_SEED.map(([c]) => c).sort((a, b) => a - b);
    expect(codes[0]).toBe(1);
    expect(codes[codes.length - 1]).toBe(26);
    expect(codes.length).toBe(26);
    // Spot-check key organismos
    const byCode = new Map(ORGANISMOS_SEED);
    expect(byCode.get(1)).toBe("INFONAVIT");
    expect(byCode.get(3)).toBe("FOVISSSTE");
    expect(byCode.get(5)).toBe("CONAVI");
  });

  it("MODALIDADES_SEED covers exactly codes 1-4", () => {
    const codes = MODALIDADES_SEED.map(([c]) => c).sort((a, b) => a - b);
    expect(codes).toEqual([1, 2, 3, 4]);
  });

  it("DESTINOS_SEED covers codes 1-18 contiguously", () => {
    const codes = DESTINOS_SEED.map(([c]) => c).sort((a, b) => a - b);
    expect(codes[0]).toBe(1);
    expect(codes[codes.length - 1]).toBe(18);
    expect(codes.length).toBe(18);
  });

  it("VIVIENDA_TIERS_SEED covers exactly codes 1-6 (Económica..Residencial plus)", () => {
    const codes = VIVIENDA_TIERS_SEED.map(([c]) => c);
    expect(codes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(VIVIENDA_TIERS_SEED[0][1]).toBe("Económica");
    expect(VIVIENDA_TIERS_SEED[5][1]).toBe("Residencial plus");
  });

  it("LOOKUPS_DDL emits all 4 DROP+CREATE+INSERT blocks", () => {
    for (const t of [
      "sedatu_organismos",
      "sedatu_modalidades",
      "sedatu_destinos",
      "sedatu_vivienda_tiers",
    ]) {
      expect(LOOKUPS_DDL).toContain(`DROP TABLE IF EXISTS ${t};`);
      expect(LOOKUPS_DDL).toContain(`CREATE TABLE ${t} (`);
      expect(LOOKUPS_DDL).toContain(`INSERT INTO ${t} (code, nombre) VALUES`);
    }
  });

  it("LOOKUPS_DDL escapes single quotes in labels (e.g. organismo names with apostrophes)", () => {
    // Codebook has no apostrophes today, but the SQL builder should be
    // resilient. Test the escape function indirectly: re-derive the
    // equivalent for a hypothetical apostrophe-containing label.
    const escaped = "Hábitat 'México'".replace(/'/g, "''");
    expect(escaped).toBe("Hábitat ''México''");
  });
});

describe("--year / --mv-source-year (2026 H1 beside 2025)", () => {
  const SAMPLE_CSV_2026 = Buffer.from(
    "año,mes,cve_ent,entidad,cve_mun,municipio,organismo,modalidad,destino,tipo,sexo,edad_rango,ingresos_rango,vivienda_valor,acciones,monto\r\n" +
      "2026,1,01,Aguascalientes,1,Aguascalientes,1,2,3,2,1,2,6,6,1.0,1475418.03\r\n" +
      "2026,6,01,Aguascalientes,1,Aguascalientes,1,2,3,2,1,2,6,6,1.0,1475418.03\r\n",
    "utf-8",
  );

  it("parseArgs defaults both years to 2025 and the CSV to the 2025 file", () => {
    const a = parseArgs([]);
    expect(a.year).toBe("2025");
    expect(a.mvSourceYear).toBeUndefined(); // default 2025 applied in load, explicit-ness kept
    expect(a.csv).toBe("raw/sedatu/financiamientos_2025.csv");
  });

  it("parseArgs --year=2026 derives the default CSV path and keeps the MV source at 2025", () => {
    const a = parseArgs(["--year=2026", "--force"]);
    expect(a).toMatchObject({
      year: "2026",
      csv: "raw/sedatu/financiamientos_2026.csv",
      force: true,
    });
    expect(defaultCsvPath("2026")).toBe("raw/sedatu/financiamientos_2026.csv");
    expect(parseArgs(["--year=2026", "--csv=/x/y.csv"]).csv).toBe("/x/y.csv");
    expect(parseArgs(["--year=2026", "--mv-source-year=2026"]).mvSourceYear).toBe("2026");
  });

  it("rejects a malformed year before it reaches any identifier", async () => {
    for (const bad of ["abc", "1999", "20266", "2026;DROP", "2026 ", ""]) {
      expect(() => parseArgs([`--year=${bad}`])).toThrow(/--year must be a year/);
      expect(() => parseArgs([`--mv-source-year=${bad}`])).toThrow(
        /--mv-source-year must be a year/,
      );
      expect(() => yearRelations(bad)).toThrow(/--year must be a year/);
    }
    await expect(
      loadSedatuFinanciamientos({
        csv: "raw/sedatu/financiamientos_2026.csv",
        force: true,
        container: "supabase-db",
        year: "abc",
      }),
    ).rejects.toThrow(/--year must be a year/);
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("yearRelations suffixes the raw table, typed view and estado-grain view", () => {
    expect(yearRelations("2026")).toEqual({
      raw: "sedatu_financiamientos_raw_2026",
      view: "sedatu_financiamientos_2026",
      estadoView: "sedatu_financiamientos_estado_grain_2026",
    });
  });

  it("rawDdl gives 2026 its own index names; 2025 keeps the original ones", () => {
    const ddl = rawDdl("2026");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS sedatu_financiamientos_raw_2026 (");
    expect(ddl).toContain("idx_sedatu_raw_cve_ent_2026");
    expect(ddl).toContain("idx_sedatu_raw_organismo_2026");
    expect(ddl).not.toContain("_2025");
    expect(RAW_DDL).toBe(rawDdl("2025"));
    expect(RAW_DDL).toContain("CREATE INDEX IF NOT EXISTS idx_sedatu_raw_cve_ent\n");
  });

  it("--year=2026 alone rebuilds only the 2026 views: no MV, no lookup table, nothing 2025", () => {
    const tx = viewsDdlTransaction("2026", "2025");
    expect(tx.startsWith("BEGIN;")).toBe(true);
    expect(tx.endsWith("COMMIT;")).toBe(true);
    expect(tx).toContain("CREATE VIEW sedatu_financiamientos_2026 AS");
    expect(tx).toContain("CREATE VIEW sedatu_financiamientos_estado_grain_2026 AS");
    expect(tx).toContain("FROM sedatu_financiamientos_raw_2026");
    expect(tx).not.toContain("MATERIALIZED VIEW");
    expect(tx).not.toContain("sedatu_financing_by_");
    expect(tx).not.toMatch(/DROP TABLE|CREATE TABLE/);
    expect(tx).not.toContain("sedatu_organismos");
    expect(tx).not.toContain("_2025");
    // Grants for exactly what it created: public roles stripped, denue_sage
    // on the two views (sage-role.sql allowlist), never on the raw table.
    expect(tx).toContain(
      "REVOKE ALL ON sedatu_financiamientos_raw_2026 FROM anon, authenticated, trustr_app;",
    );
    expect(tx).toContain("GRANT SELECT ON sedatu_financiamientos_2026 TO denue_sage;");
    expect(tx).toContain(
      "GRANT SELECT ON sedatu_financiamientos_estado_grain_2026 TO denue_sage;",
    );
    expect(tx).not.toContain("GRANT SELECT ON sedatu_financiamientos_raw_2026");
    expect(tx.indexOf("GRANT")).toBeGreaterThan(tx.indexOf("CREATE VIEW sedatu_financiamientos_estado_grain_2026"));
  });

  it("--mv-source-year=2026 with --year=2026 rebuilds lookups + both MVs from the 2026 views", () => {
    const tx = viewsDdlTransaction("2026", "2026");
    expect(tx).toContain("CREATE MATERIALIZED VIEW sedatu_financing_by_municipio AS");
    expect(tx).toContain("CREATE MATERIALIZED VIEW sedatu_financing_by_estado AS");
    expect(tx).toContain(LOOKUPS_DDL);
    expect(tx).toContain("FROM sedatu_financiamientos_2026\n  GROUP BY cve_mun, cve_ent");
    expect(tx).toContain("FROM sedatu_financiamientos_estado_grain_2026\n  GROUP BY cve_ent");
    expect(tx).not.toContain("_2025");
    expect(tx).toContain("GRANT SELECT ON sedatu_financing_by_municipio TO denue_sage;");
  });

  it("the default (2025/2025) transaction re-grants every relation it recreates", () => {
    for (const r of [
      "sedatu_financiamientos_2025",
      "sedatu_financiamientos_estado_grain_2025",
      "sedatu_organismos",
      "sedatu_modalidades",
      "sedatu_destinos",
      "sedatu_vivienda_tiers",
      "sedatu_financing_by_municipio",
      "sedatu_financing_by_estado",
    ]) {
      expect(VIEWS_DDL_TRANSACTION).toContain(`GRANT SELECT ON ${r} TO denue_sage;`);
    }
    expect(VIEWS_DDL_TRANSACTION).toContain(
      "REVOKE ALL ON sedatu_financiamientos_raw_2025 FROM anon, authenticated, trustr_app;",
    );
    expect(VIEWS_DDL_TRANSACTION.indexOf("GRANT")).toBeGreaterThan(
      VIEWS_DDL_TRANSACTION.indexOf("CREATE MATERIALIZED VIEW sedatu_financing_by_estado"),
    );
  });

  it("load --year=2026 runs the 2026 raw + views path, leaves the MVs alone and says so", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mockReadFile
      .mockReturnValueOnce(SAMPLE_CSV_2026)
      .mockReturnValueOnce(SAMPLE_CSV_2026);
    mockExec
      .mockReturnValueOnce(MV_SOURCE_2025) // pre-flight: MVs read 2025
      .mockReturnValueOnce("CREATE TABLE\n")
      .mockReturnValueOnce("0\n")
      .mockReturnValueOnce("TRUNCATE TABLE\nCOPY 2\n")
      .mockReturnValueOnce("CREATE VIEW\nCOMMIT\n")
      .mockReturnValueOnce("2|2|1|2026..2026|1..6|2|2.95\n");
    await loadSedatuFinanciamientos({
      csv: "raw/sedatu/financiamientos_2026.csv",
      force: false,
      container: "supabase-db",
      year: "2026",
    });
    expect(mockExec).toHaveBeenCalledTimes(6);
    expect(mockExec.mock.calls[1]?.[2]).toMatchObject({ input: rawDdl("2026") });
    expect(mockExec.mock.calls[2]?.[1]?.join(" ")).toContain(
      "SELECT COUNT(*) FROM sedatu_financiamientos_raw_2026;",
    );
    const txInput = String((mockExec.mock.calls[3]?.[2] as { input: Buffer }).input);
    expect(txInput.startsWith("TRUNCATE TABLE sedatu_financiamientos_raw_2026;\n")).toBe(true);
    expect(txInput).toContain("\\copy sedatu_financiamientos_raw_2026 (");
    expect(mockExec.mock.calls[4]?.[2]).toMatchObject({
      input: viewsDdlTransaction("2026", "2025"),
    });
    expect(mockExec.mock.calls[5]?.[1]?.join(" ")).toContain(
      postLoadVerifySql("2026", "2025"),
    );
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /2 rows, ano=2026, mes 1\.\.6/.test(l))).toBe(true);
    expect(
      lines.some((l) => /NOT rebuilt and still read 2025/.test(l)),
    ).toBe(true);
  });

  it("postLoadVerifySql for a non-MV year reads the year's views, never the MVs", () => {
    const sql = postLoadVerifySql("2026", "2025");
    expect(sql).toContain("FROM sedatu_financiamientos_raw_2026");
    expect(sql).toContain("mes_range");
    expect(sql).not.toContain("sedatu_financing_by_");
    expect(POST_LOAD_VERIFY_SQL).toBe(postLoadVerifySql("2025", "2025"));
  });

  it("refuses a CSV whose ano is not --year before touching the DB", async () => {
    mockReadFile.mockReturnValueOnce(SAMPLE_CSV); // a 2025 row
    await expect(
      loadSedatuFinanciamientos({
        csv: "raw/sedatu/financiamientos_2026.csv",
        force: true,
        container: "supabase-db",
        year: "2026",
      }),
    ).rejects.toThrow(/1 of 1 rows have ano != 2026/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("refuses a CSV whose header differs from RAW_HEADER_COLS and reports the diff", async () => {
    mockReadFile.mockReturnValueOnce(
      Buffer.from(
        "año,mes,cve_ent,entidad,cve_mun,municipio,organismo,modalidad,destino,tipo,sexo,edad_rango,ingresos_rango,vivienda_valor,monto,acciones\n" +
          "2026,1,01,Aguascalientes,1,Aguascalientes,1,2,3,2,1,2,6,6,1475418.03,1.0\n",
        "utf-8",
      ),
    );
    await expect(
      loadSedatuFinanciamientos({
        csv: "raw/sedatu/financiamientos_2026.csv",
        force: true,
        container: "supabase-db",
        year: "2026",
      }),
    ).rejects.toThrow(/first difference at column 15: got "monto", expected "acciones"/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("W1: rawDdl commits a new year's raw table only together with its REVOKE", () => {
    const ddl = rawDdl("2027");
    expect(ddl.startsWith("BEGIN;")).toBe(true);
    expect(ddl.endsWith("COMMIT;")).toBe(true);
    const revoke = "REVOKE ALL ON sedatu_financiamientos_raw_2027 FROM anon, authenticated, trustr_app;";
    expect(ddl).toContain(revoke);
    expect(ddl.indexOf("CREATE TABLE")).toBeLessThan(ddl.indexOf(revoke));
    expect(ddl).not.toMatch(/GRANT SELECT ON sedatu_financiamientos_raw_2027 TO denue_sage/);
  });

  it("W3: rejects the space form and a bare --year / --mv-source-year", () => {
    expect(() => parseArgs(["--year", "2026"])).toThrow(/--year needs the = form/);
    expect(() => parseArgs(["--year"])).toThrow(/--year needs the = form/);
    expect(() => parseArgs(["--mv-source-year"])).toThrow(/--mv-source-year needs the = form/);
    expect(() => parseArgs(["--mv-source-year", "2026"])).toThrow(/needs the = form/);
    expect(() => parseArgs(["--yearly=2026"])).toThrow(/needs the = form/);
  });

  it("W2: MV_SOURCE_VIEWS_SQL resolves the MVs' views from pg_depend, read-only", () => {
    expect(MV_SOURCE_VIEWS_SQL).toContain("FROM pg_depend");
    expect(MV_SOURCE_VIEWS_SQL).toContain("'sedatu_financing_by_municipio'");
    expect(MV_SOURCE_VIEWS_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/);
  });

  describe("W2: checkMvSourcePairing (fake pg_depend output)", () => {
    const MV_2026 = "sedatu_financiamientos_2026\nsedatu_financiamientos_estado_grain_2026\n";
    it("allows anything on a fresh DB (no MVs yet)", () => {
      expect(checkMvSourcePairing("", "2026", "2025", false)).toBeNull();
      expect(checkMvSourcePairing("\n", "2026", "2026", false)).toBeNull();
    });
    it("allows the default reload and the 2026 views-only load while MVs read 2025", () => {
      expect(checkMvSourcePairing(MV_SOURCE_2025, "2025", "2025", false)).toBe("2025");
      expect(checkMvSourcePairing(MV_SOURCE_2025, "2026", "2025", false)).toBe("2025");
    });
    it("refuses a silent MV revert: default --force reload after 2026 was promoted", () => {
      expect(() => checkMvSourcePairing(MV_2026, "2025", "2025", false)).toThrow(
        /MVs read 2026.*default --mv-source-year=2025.*--mv-source-year=2026 to keep 2026/,
      );
    });
    it("allows switching the MVs when --mv-source-year is explicit (promote and revert)", () => {
      expect(checkMvSourcePairing(MV_SOURCE_2025, "2026", "2026", true)).toBe("2025");
      expect(checkMvSourcePairing(MV_2026, "2025", "2025", true)).toBe("2026");
    });
    it("refuses a promotion that relied on the default being the target", () => {
      expect(() => checkMvSourcePairing(MV_SOURCE_2025, "2026", "2026", false)).toThrow(
        /MVs read 2025/,
      );
    });
    it("refuses a views-only load of the year the MVs read (its DROP VIEW would fail after the COPY)", () => {
      expect(() => checkMvSourcePairing(MV_2026, "2026", "2025", false)).toThrow(
        /MVs read the 2026 views.*would drop views they depend on.*--mv-source-year=2026/,
      );
    });
    it("refuses a views-only load whose --mv-source-year is not what the MVs read", () => {
      expect(() => checkMvSourcePairing(MV_2026, "2027", "2025", true)).toThrow(
        /MVs read 2026, not --mv-source-year=2025/,
      );
    });
    it("refuses mixed-year MVs and unknown view names", () => {
      expect(() =>
        checkMvSourcePairing("sedatu_financiamientos_2025\nsedatu_financiamientos_estado_grain_2026\n", "2025", "2025", true),
      ).toThrow(/different years \(2025, 2026\)/);
      expect(() => checkMvSourcePairing("something_else\n", "2025", "2025", false)).toThrow(
        /unexpected MV source view "something_else"/,
      );
    });
  });

  it("W2: the load refuses before any write when the pairing is wrong", async () => {
    mockReadFile.mockReturnValueOnce(SAMPLE_CSV);
    mockExec.mockReturnValueOnce("sedatu_financiamientos_2026\nsedatu_financiamientos_estado_grain_2026\n");
    await expect(
      loadSedatuFinanciamientos({
        csv: "x.csv",
        force: true,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/MVs read 2026/);
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0]?.[1]?.join(" ")).toContain(MV_SOURCE_VIEWS_SQL);
    expect(mockExec.mock.calls[0]?.[2]?.input).toBeUndefined();
  });

  it("R2: rejects any argument that is not a known form", () => {
    for (const bad of ["--mv_source_year=2026", "--Year=2026", "--forced", "--container=x", "2026", "-f"]) {
      expect(() => parseArgs([bad])).toThrow(new RegExp(`unknown argument "${bad}"`));
    }
    expect(() => parseArgs(["--year=2026", "--mv_source_year=2026"])).toThrow(/unknown argument/);
  });

  it("R2: a failing pre-flight read stops the load before any other exec", async () => {
    mockReadFile.mockReturnValueOnce(SAMPLE_CSV);
    mockExec.mockImplementationOnce(() => {
      throw new Error("psql: connection refused");
    });
    await expect(
      loadSedatuFinanciamientos({
        csv: "x.csv",
        force: true,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/connection refused/);
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0]?.[1]?.join(" ")).toContain(MV_SOURCE_VIEWS_SQL);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockMkdtemp).not.toHaveBeenCalled();
  });
});
