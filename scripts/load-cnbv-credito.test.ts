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
  CREDITO_BY_ESTADO_DDL,
  CREDITO_BY_MUNI_DDL,
  CREDITO_ESTADO_VIEW_DDL,
  CREDITO_VIEW_DDL,
  INTERMEDIARIOS_SEED,
  loadCnbvCredito,
  LOOKUPS_DDL,
  MODALIDADES_SEED,
  NUMERIC_RAW_COLS,
  POST_LOAD_VERIFY_SQL,
  RAW_DDL,
  RAW_HEADER_COLS,
  transcodeLatin1ToUtf8,
  VIEWS_DDL_TRANSACTION,
  VIVIENDA_TIERS_SEED,
} from "./load-cnbv-credito.js";

const SAMPLE_CSV = Buffer.from(
  "ano,mes,cve_ent,entidad,cve_mun,municipio,modalidad,linea_credito,esquema,intermediario_financiero,sexo,edad_rango,ingresos_rango,vivienda_valor,poblacion_indigena,zona,monto,acciones\n" +
    "2025,1,01,Aguascalientes,001,Aguascalientes,1,3,7,040021,1,2,6,5,3,1,2400000.0,1\n",
  "utf-8",
);

beforeEach(() => {
  mockExec.mockReset();
  mockExists.mockReset();
  mockMkdtemp.mockReset();
  mockReadFile.mockReset();
  mockRm.mockReset();
  mockWriteFile.mockReset();
  mockExists.mockReturnValue(true);
  mockMkdtemp.mockReturnValue("/tmp/cnbv-credito-xyz");
});
afterEach(() => vi.restoreAllMocks());

function stubHappyPath(): void {
  mockReadFile.mockReturnValueOnce(SAMPLE_CSV).mockReturnValueOnce(SAMPLE_CSV);
  mockExec
    .mockReturnValueOnce("CREATE TABLE\nCREATE INDEX\n") // RAW_DDL
    .mockReturnValueOnce("0\n") // COUNT(*) — empty
    .mockReturnValueOnce("TRUNCATE TABLE\n") // TRUNCATE
    .mockReturnValueOnce("COPY 1\n") // \copy
    .mockReturnValueOnce(
      "DROP VIEW\nDROP TABLE\nCREATE TABLE\nINSERT 0 18\nCREATE VIEW\nCREATE MATERIALIZED VIEW\nCREATE INDEX\nCOMMIT\n",
    ) // VIEWS_DDL_TRANSACTION
    .mockReturnValueOnce("94763|94763|1230|1230|94,763|18.34|18\n"); // verify
}

describe("transcodeLatin1ToUtf8", () => {
  it("preserves ASCII bytes verbatim", () => {
    const input = Buffer.from("hello world\n", "ascii");
    const out = transcodeLatin1ToUtf8(input);
    expect(out.toString("utf-8")).toBe("hello world\n");
  });

  it("transcodes 0xf1 (ñ) Latin-1 byte to UTF-8 multi-byte sequence", () => {
    const input = Buffer.from([0x61, 0xf1, 0x6f]); // "año" in Latin-1
    const out = transcodeLatin1ToUtf8(input);
    expect(out.toString("utf-8")).toBe("año");
    expect([...out]).toEqual([0x61, 0xc3, 0xb1, 0x6f]);
  });
});

describe("loadCnbvCredito (orchestration)", () => {
  it("aborts when raw table is non-empty and --force not supplied", async () => {
    mockExec
      .mockReturnValueOnce("CREATE TABLE\n")
      .mockReturnValueOnce("94763\n");

    await expect(
      loadCnbvCredito({
        csv: "raw/cnbv/credito_2025.csv",
        force: false,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/has 94763 rows/);
    expect(mockExec.mock.calls.length).toBe(2);
  });

  it("happy path: applies schema, transcodes, copies, builds views atomically, verifies", async () => {
    stubHappyPath();
    await loadCnbvCredito({
      csv: "raw/cnbv/credito_2025.csv",
      force: true,
      container: "supabase-db",
    });
    expect(mockExec).toHaveBeenCalledTimes(6);
    expect(mockExec.mock.calls[0]?.[2]).toMatchObject({ input: RAW_DDL });
    const copyArgs = (mockExec.mock.calls[3]?.[1] ?? []) as string[];
    expect(copyArgs.join(" ")).toContain(
      `\\copy cnbv_credito_raw_2025 (${RAW_HEADER_COLS.join(", ")}) FROM STDIN`,
    );
    expect(mockExec.mock.calls[4]?.[2]).toMatchObject({
      input: VIEWS_DDL_TRANSACTION,
    });
    expect(mockExec.mock.calls[5]?.[1]?.join(" ")).toContain(
      POST_LOAD_VERIFY_SQL,
    );
  });

  it("VIEWS_DDL_TRANSACTION wraps all DDLs in BEGIN/COMMIT (atomicity)", () => {
    expect(VIEWS_DDL_TRANSACTION.startsWith("BEGIN;")).toBe(true);
    expect(VIEWS_DDL_TRANSACTION.endsWith("COMMIT;")).toBe(true);
    expect(VIEWS_DDL_TRANSACTION).toContain(LOOKUPS_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(CREDITO_VIEW_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(CREDITO_ESTADO_VIEW_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(CREDITO_BY_MUNI_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(CREDITO_BY_ESTADO_DDL);
    const lookupIdx = VIEWS_DDL_TRANSACTION.indexOf(LOOKUPS_DDL);
    const muniViewIdx = VIEWS_DDL_TRANSACTION.indexOf(CREDITO_VIEW_DDL);
    const estadoViewIdx = VIEWS_DDL_TRANSACTION.indexOf(
      CREDITO_ESTADO_VIEW_DDL,
    );
    const muniMvIdx = VIEWS_DDL_TRANSACTION.indexOf(CREDITO_BY_MUNI_DDL);
    const estadoMvIdx = VIEWS_DDL_TRANSACTION.indexOf(CREDITO_BY_ESTADO_DDL);
    expect(lookupIdx).toBeLessThan(muniViewIdx);
    expect(lookupIdx).toBeLessThan(estadoViewIdx);
    expect(muniViewIdx).toBeLessThan(muniMvIdx);
    expect(estadoViewIdx).toBeLessThan(estadoMvIdx);
  });

  it("VIEWS_DDL_TRANSACTION DROP cascade is dependency-safe (per estado-grain-sibling pattern)", () => {
    // Drop ordering MUST be: estado MV → muni MV → estado view → muni view
    // → lookups, otherwise a second --force reload errors with "cannot
    // drop table cnbv_intermediarios because materialized view ... depends
    // on it". v0.2.15 SICT C1 + v0.2.16 SEDATU — same lesson.
    const idxEstadoMv = VIEWS_DDL_TRANSACTION.indexOf(
      "DROP MATERIALIZED VIEW IF EXISTS cnbv_credito_by_estado",
    );
    const idxMuniMv = VIEWS_DDL_TRANSACTION.indexOf(
      "DROP MATERIALIZED VIEW IF EXISTS cnbv_credito_by_municipio",
    );
    const idxEstadoView = VIEWS_DDL_TRANSACTION.indexOf(
      "DROP VIEW IF EXISTS cnbv_credito_estado_grain_2025",
    );
    const idxMuniView = VIEWS_DDL_TRANSACTION.indexOf(
      "DROP VIEW IF EXISTS cnbv_credito_2025",
    );
    expect(idxEstadoMv).toBeGreaterThan(0);
    expect(idxMuniMv).toBeGreaterThan(idxEstadoMv);
    expect(idxEstadoView).toBeGreaterThan(idxMuniMv);
    expect(idxMuniView).toBeGreaterThan(idxEstadoView);
  });

  it("cleans up tempdir even on docker-exec failure during DDL step", async () => {
    mockReadFile
      .mockReturnValueOnce(SAMPLE_CSV)
      .mockReturnValueOnce(SAMPLE_CSV);
    mockExec
      .mockReturnValueOnce("CREATE TABLE\n")
      .mockReturnValueOnce("0\n")
      .mockReturnValueOnce("TRUNCATE\n")
      .mockReturnValueOnce("COPY 1\n")
      .mockImplementationOnce(() => {
        throw new Error("syntax error");
      });
    await expect(
      loadCnbvCredito({
        csv: "raw/cnbv/credito_2025.csv",
        force: true,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/syntax error/);
    expect(mockRm).toHaveBeenCalledWith(
      "/tmp/cnbv-credito-xyz",
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("rejects unsafe container name (anti docker-flag injection)", async () => {
    await expect(
      loadCnbvCredito({
        csv: "raw/cnbv/credito_2025.csv",
        force: true,
        container: "--rm",
      }),
    ).rejects.toThrow(/unsafe container name/);
  });

  it("throws when CSV missing", async () => {
    mockExists.mockReturnValue(false);
    await expect(
      loadCnbvCredito({
        csv: "raw/cnbv/missing.csv",
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

  it("RAW_HEADER_COLS pins CNBV column order: monto BEFORE acciones (NOT SEDATU's reverse)", () => {
    // Pin guards against a future ingest mistakenly reusing SEDATU's
    // (acciones, monto) order. CNBV CSV ships (monto, acciones) — \copy
    // is positional, swapping these would silently load 1.0 into monto
    // and $2.4M into acciones (catastrophic data corruption).
    const montoIdx = RAW_HEADER_COLS.indexOf("monto");
    const accionesIdx = RAW_HEADER_COLS.indexOf("acciones");
    expect(montoIdx).toBeGreaterThan(0);
    expect(accionesIdx).toBeGreaterThan(montoIdx);
  });

  it("NUMERIC_RAW_COLS subset of RAW_HEADER_COLS (no orphans)", () => {
    for (const n of NUMERIC_RAW_COLS) {
      expect(RAW_HEADER_COLS).toContain(n);
    }
  });

  it("NUMERIC_RAW_COLS excludes intermediario_financiero (TEXT, leading zero)", () => {
    // 040002 → int cast would lose leading zero → break FK to lookup.
    expect(NUMERIC_RAW_COLS).not.toContain("intermediario_financiero");
    expect(RAW_HEADER_COLS).toContain("intermediario_financiero");
  });

  it("CREDITO_VIEW_DDL casts every NUMERIC_RAW_COL via NULLIF + TRIM", () => {
    for (const col of NUMERIC_RAW_COLS) {
      expect(CREDITO_VIEW_DDL).toContain(
        `NULLIF(TRIM(${col}), '')::numeric AS ${col}`,
      );
    }
  });

  it("CREDITO_VIEW_DDL preserves intermediario_financiero as TEXT (no cast)", () => {
    // Should appear in the SELECT projection list verbatim, NOT inside a
    // numericCast pattern.
    expect(CREDITO_VIEW_DDL).toContain("intermediario_financiero");
    expect(CREDITO_VIEW_DDL).not.toContain(
      "NULLIF(TRIM(intermediario_financiero), '')::numeric",
    );
  });

  it("CREDITO_VIEW_DDL composes 5-char cve_mun via cve_ent || LPAD(cve_mun, 3, '0')", () => {
    expect(CREDITO_VIEW_DDL).toContain(
      "cve_ent || LPAD(cve_mun, 3, '0') AS cve_mun",
    );
  });

  it("CREDITO_VIEW_DDL filters with INEGI sentinel guards (cve_ent 01-32 + cve_mun 1-3 digits)", () => {
    expect(CREDITO_VIEW_DDL).toContain(
      "WHERE NULLIF(TRIM(cve_ent), '') IS NOT NULL",
    );
    expect(CREDITO_VIEW_DDL).toContain(
      "AND NULLIF(TRIM(cve_mun), '') IS NOT NULL",
    );
    expect(CREDITO_VIEW_DDL).toContain(
      "TRIM(cve_ent) ~ '^(0[1-9]|[12][0-9]|3[0-2])$'",
    );
    expect(CREDITO_VIEW_DDL).toContain("TRIM(cve_mun) ~ '^[0-9]{1,3}$'");
  });

  it("CREDITO_BY_MUNI_DDL is MATERIALIZED with btree index on cve_mun", () => {
    expect(CREDITO_BY_MUNI_DDL).toContain(
      "CREATE MATERIALIZED VIEW cnbv_credito_by_municipio",
    );
    expect(CREDITO_BY_MUNI_DDL).toContain(
      "CREATE UNIQUE INDEX idx_cnbv_credito_cve_mun",
    );
  });

  it("CREDITO_BY_MUNI_DDL guards every modality % with COALESCE(SUM FILTER, 0)", () => {
    for (const code of [1, 2, 3, 4]) {
      expect(CREDITO_BY_MUNI_DDL).toContain(
        `COALESCE(SUM(acciones) FILTER (WHERE modalidad = ${code}), 0)`,
      );
    }
  });

  it("CREDITO_BY_MUNI_DDL pct_indigena uses code 1 numerator (Sí) over IN (1,2) denominator", () => {
    // Verified empirically (live load 2026-05-10): poblacion_indigena
    // code 1 = Sí (indígena), 2 = No, 3 = No especificado. Chiapas PI=1
    // share = 9.48% (matches indigenous concentration); flipping to code
    // 2 produced 99.99% (the "No" share masquerading as indigenous).
    // Pin both numerator code AND denominator IN-set to catch any future
    // semantic flip during loader edits.
    expect(CREDITO_BY_MUNI_DDL).toContain(
      "FILTER (WHERE poblacion_indigena IN (1, 2))",
    );
    expect(CREDITO_BY_MUNI_DDL).toContain(
      "COALESCE(SUM(acciones) FILTER (WHERE poblacion_indigena = 1), 0)",
    );
    // Negative pin (audit R1 round-1): historic `= 2 ... IN (1,2)` formula
    // must not return. Regex is whitespace-tolerant so future prettier
    // reformats can't sneak the bug back via line/indentation changes.
    expect(CREDITO_BY_MUNI_DDL).not.toMatch(
      /FILTER\s*\(\s*WHERE\s+poblacion_indigena\s*=\s*2\s*\)\s*,\s*0\s*\)\s*\*\s*100\.0\s*\/\s*NULLIF\(\s*SUM\(\s*acciones\s*\)\s*FILTER\s*\(\s*WHERE\s+poblacion_indigena\s+IN\s*\(\s*1\s*,\s*2\s*\)/,
    );
  });

  it("CREDITO_BY_MUNI_DDL preserves NULL semantics for housing-tier (signal: tier unknown)", () => {
    expect(CREDITO_BY_MUNI_DDL).toContain("WHEN pm.acciones_with_tier > 0");
    expect(CREDITO_BY_MUNI_DDL).toContain(
      "SUM(acciones) FILTER (WHERE vivienda_valor IS NOT NULL) AS acciones_with_tier",
    );
  });

  it("CREDITO_BY_MUNI_DDL resolves top_intermediario via JOIN to cnbv_intermediarios", () => {
    expect(CREDITO_BY_MUNI_DDL).toContain(
      "LEFT JOIN cnbv_intermediarios i ON i.code = ti.top_intermediario_code",
    );
    expect(CREDITO_BY_MUNI_DDL).toContain(
      "i.nombre AS top_intermediario_nombre",
    );
  });

  it("CREDITO_BY_MUNI_DDL ROW_NUMBER tie-break is deterministic (intermediario ASC)", () => {
    expect(CREDITO_BY_MUNI_DDL).toContain(
      "ORDER BY SUM(acciones) DESC, intermediario_financiero ASC",
    );
  });

  it("CREDITO_BY_MUNI_DDL surfaces top_linea_credito_code and top_esquema_code (codebook gap)", () => {
    // Without operator-supplied codebook for linea/esquema, expose the
    // numeric code only. When codebook lands, add JOIN to label table.
    expect(CREDITO_BY_MUNI_DDL).toContain("top_linea_credito_code");
    expect(CREDITO_BY_MUNI_DDL).toContain("top_esquema_code");
    // Should NOT ship a fabricated label JOIN.
    expect(CREDITO_BY_MUNI_DDL).not.toMatch(/top_linea_credito_nombre/);
    expect(CREDITO_BY_MUNI_DDL).not.toMatch(/top_esquema_nombre/);
  });

  // --- estado-grain base view + MV ---

  it("CREDITO_ESTADO_VIEW_DDL filters on cve_ent ONLY (no cve_mun gate — sibling-not-rollup)", () => {
    expect(CREDITO_ESTADO_VIEW_DDL).toContain(
      "CREATE VIEW cnbv_credito_estado_grain_2025",
    );
    expect(CREDITO_ESTADO_VIEW_DDL).toContain(
      "TRIM(cve_ent) ~ '^(0[1-9]|[12][0-9]|3[0-2])$'",
    );
    expect(CREDITO_ESTADO_VIEW_DDL).not.toMatch(/TRIM\(cve_mun\)\s*~/);
    expect(CREDITO_ESTADO_VIEW_DDL).not.toContain("AND NULLIF(TRIM(cve_mun)");
  });

  it("CREDITO_ESTADO_VIEW_DDL does NOT compose a 5-char cve_mun (no LPAD)", () => {
    expect(CREDITO_ESTADO_VIEW_DDL).not.toContain("LPAD(cve_mun, 3, '0')");
  });

  it("CREDITO_ESTADO_VIEW_DDL projects no dead muni-string columns", () => {
    expect(CREDITO_ESTADO_VIEW_DDL).not.toContain("cve_mun_short");
    expect(CREDITO_ESTADO_VIEW_DDL).not.toMatch(/,\s*municipio\b/);
  });

  it("CREDITO_BY_ESTADO_DDL is MATERIALIZED with unique btree index on cve_ent", () => {
    expect(CREDITO_BY_ESTADO_DDL).toContain(
      "CREATE MATERIALIZED VIEW cnbv_credito_by_estado",
    );
    expect(CREDITO_BY_ESTADO_DDL).toContain(
      "CREATE UNIQUE INDEX idx_cnbv_credito_est_cve_ent",
    );
    expect(CREDITO_BY_ESTADO_DDL).toContain(
      "CREATE INDEX idx_cnbv_credito_est_monto_total",
    );
  });

  it("CREDITO_BY_ESTADO_DDL aggregates from estado-grain base view, not muni MV", () => {
    expect(CREDITO_BY_ESTADO_DDL).toContain(
      "FROM cnbv_credito_estado_grain_2025",
    );
    expect(CREDITO_BY_ESTADO_DDL).not.toContain(
      "FROM cnbv_credito_by_municipio",
    );
  });

  it("CREDITO_BY_ESTADO_DDL groups by cve_ent (not cve_mun)", () => {
    const groupByCveEntCount = (
      CREDITO_BY_ESTADO_DDL.match(/GROUP BY cve_ent/g) ?? []
    ).length;
    expect(groupByCveEntCount).toBeGreaterThanOrEqual(1);
    expect(CREDITO_BY_ESTADO_DDL).not.toContain("GROUP BY cve_mun");
  });

  it("CREDITO_BY_ESTADO_DDL modality % uses COALESCE-guarded zero-row handling (4 modalidades)", () => {
    const matches = CREDITO_BY_ESTADO_DDL.match(
      /COALESCE\(SUM\(acciones\) FILTER \(WHERE modalidad = \d+\),\s*0\)/g,
    );
    expect(matches?.length ?? 0).toBe(4);
  });

  it("CREDITO_BY_ESTADO_DDL pct_indigena symmetric with muni MV (numerator = 1, denominator IN (1, 2))", () => {
    // Both grains compute the same rate; semantic flip in either MV
    // would surface as a 99% indigenous false-positive in production
    // (caught live during v0.2.17 development).
    expect(CREDITO_BY_ESTADO_DDL).toContain(
      "FILTER (WHERE poblacion_indigena IN (1, 2))",
    );
    expect(CREDITO_BY_ESTADO_DDL).toContain(
      "COALESCE(SUM(acciones) FILTER (WHERE poblacion_indigena = 1), 0)",
    );
    // Negative pin parallel to muni MV (audit R2 round-1): historic
    // `= 2 ... IN (1, 2)` formula must not regress at the estado grain
    // either. Same whitespace-tolerant regex.
    expect(CREDITO_BY_ESTADO_DDL).not.toMatch(
      /FILTER\s*\(\s*WHERE\s+poblacion_indigena\s*=\s*2\s*\)\s*,\s*0\s*\)\s*\*\s*100\.0\s*\/\s*NULLIF\(\s*SUM\(\s*acciones\s*\)\s*FILTER\s*\(\s*WHERE\s+poblacion_indigena\s+IN\s*\(\s*1\s*,\s*2\s*\)/,
    );
  });

  it("CREDITO_BY_ESTADO_DDL ROW_NUMBER tie-break matches muni MV (intermediario ASC)", () => {
    expect(CREDITO_BY_ESTADO_DDL).toContain(
      "ORDER BY SUM(acciones) DESC, intermediario_financiero ASC",
    );
  });

  it("CREDITO_BY_ESTADO_DDL resolves top_intermediario via JOIN to cnbv_intermediarios", () => {
    expect(CREDITO_BY_ESTADO_DDL).toContain(
      "LEFT JOIN cnbv_intermediarios i ON i.code = ti.top_intermediario_code",
    );
    expect(CREDITO_BY_ESTADO_DDL).toContain(
      "i.nombre AS top_intermediario_nombre",
    );
  });

  it("POST_LOAD_VERIFY_SQL counts both grain MVs + intermediario distinct", () => {
    expect(POST_LOAD_VERIFY_SQL).toContain(
      "SELECT COUNT(*) FROM cnbv_credito_by_municipio",
    );
    expect(POST_LOAD_VERIFY_SQL).toContain(
      "SELECT COUNT(*) FROM cnbv_credito_by_estado",
    );
    expect(POST_LOAD_VERIFY_SQL).toContain(
      "SELECT COUNT(DISTINCT intermediario_financiero) FROM cnbv_credito_2025",
    );
  });

  it("POST_LOAD_VERIFY_SQL surfaces sum-invariant deltas (audit W1 round-2)", () => {
    // The estado-grain sibling MV reads from a catch-all-inclusive base
    // view; CNBV 2025 has 0 catch-alls so deltas are 0. A future year
    // with state-level no-distribuido rows would surface non-zero
    // deltas at load time — the operator sees the divergence and can
    // escalate to a guard if the delta is unexpected.
    expect(POST_LOAD_VERIFY_SQL).toContain("muni_acciones");
    expect(POST_LOAD_VERIFY_SQL).toContain("estado_acciones");
    expect(POST_LOAD_VERIFY_SQL).toContain("acciones_delta");
    expect(POST_LOAD_VERIFY_SQL).toContain("monto_delta_b_mxn");
  });
});

describe("refresh-matviews.sh integration (regression guard)", () => {
  // Bug-class: every prior MV bundle (v0.2.13 SICT, v0.2.14 SEDATU,
  // v0.2.15 SICT estado, v0.2.16 SEDATU estado) shipped with audit
  // catching missing entries. Pin both new MVs.
  it("references cnbv_credito_by_estado in REFRESH list", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const path = await vi.importActual<typeof import("node:path")>("node:path");
    const scriptPath = path.resolve(__dirname, "refresh-matviews.sh");
    const script = fs.readFileSync(scriptPath, "utf-8");
    expect(script).toMatch(/REFRESH MATERIALIZED VIEW cnbv_credito_by_estado/);
  });

  it("references cnbv_credito_by_municipio in REFRESH list", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const path = await vi.importActual<typeof import("node:path")>("node:path");
    const scriptPath = path.resolve(__dirname, "refresh-matviews.sh");
    const script = fs.readFileSync(scriptPath, "utf-8");
    expect(script).toMatch(
      /REFRESH MATERIALIZED VIEW cnbv_credito_by_municipio/,
    );
  });
});

describe("Lookup-table seeds", () => {
  it("INTERMEDIARIOS_SEED covers all 18 banks empirically present in 2025 CSV", () => {
    expect(INTERMEDIARIOS_SEED).toHaveLength(18);
    const codes = INTERMEDIARIOS_SEED.map(([c]) => c);
    // Pin presence of major banks (verified empirically in raw probe).
    expect(codes).toContain("040002"); // BANAMEX
    expect(codes).toContain("040012"); // BBVA
    expect(codes).toContain("040014"); // SANTANDER
    expect(codes).toContain("040044"); // SCOTIABANK
    expect(codes).toContain("040072"); // BANORTE
  });

  it("INTERMEDIARIOS_SEED codes preserve leading zero (TEXT, not int)", () => {
    // Critical: all codes must be 6-char strings starting with "0".
    for (const [code] of INTERMEDIARIOS_SEED) {
      expect(typeof code).toBe("string");
      expect(code).toMatch(/^0\d{5}$/);
    }
  });

  it("MODALIDADES_SEED covers exactly codes 1-4 (mirrors SEDATU dictionary)", () => {
    const codes = MODALIDADES_SEED.map(([c]) => c).sort((a, b) => a - b);
    expect(codes).toEqual([1, 2, 3, 4]);
    expect(MODALIDADES_SEED[0][1]).toBe("Vivienda nueva");
  });

  it("VIVIENDA_TIERS_SEED covers exactly codes 1-6 (Económica..Residencial plus)", () => {
    const codes = VIVIENDA_TIERS_SEED.map(([c]) => c);
    expect(codes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(VIVIENDA_TIERS_SEED[0][1]).toBe("Económica");
    expect(VIVIENDA_TIERS_SEED[5][1]).toBe("Residencial plus");
  });

  it("LOOKUPS_DDL emits all 3 DROP+CREATE+INSERT blocks", () => {
    for (const t of [
      "cnbv_intermediarios",
      "cnbv_modalidades",
      "cnbv_vivienda_tiers",
    ]) {
      expect(LOOKUPS_DDL).toContain(`DROP TABLE IF EXISTS ${t};`);
      expect(LOOKUPS_DDL).toContain(`CREATE TABLE ${t} (`);
      expect(LOOKUPS_DDL).toContain(`INSERT INTO ${t} (code, nombre) VALUES`);
    }
  });

  it("cnbv_intermediarios uses TEXT primary key (preserves 040xxx leading zero)", () => {
    // The intermediarios block must be `code TEXT PRIMARY KEY`, not INTEGER.
    // Anchor by the CREATE TABLE block specifically.
    const block =
      LOOKUPS_DDL.split("CREATE TABLE cnbv_intermediarios")[1] ?? "";
    expect(block).toContain("code TEXT PRIMARY KEY");
  });

  it("cnbv_modalidades + cnbv_vivienda_tiers use INTEGER primary key", () => {
    for (const t of ["cnbv_modalidades", "cnbv_vivienda_tiers"]) {
      const block = LOOKUPS_DDL.split(`CREATE TABLE ${t}`)[1] ?? "";
      expect(block).toContain("code INTEGER PRIMARY KEY");
    }
  });
});
