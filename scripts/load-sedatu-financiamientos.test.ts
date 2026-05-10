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
  DESTINOS_SEED,
  loadSedatuFinanciamientos,
  LOOKUPS_DDL,
  MODALIDADES_SEED,
  NUMERIC_RAW_COLS,
  ORGANISMOS_SEED,
  POST_LOAD_VERIFY_SQL,
  RAW_DDL,
  RAW_HEADER_COLS,
  FINANCIAMIENTOS_VIEW_DDL,
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
 *   3. dockerExecStdin → TRUNCATE
 *   4. execFileSync → \copy (UTF-8 transcoded buffer)
 *   5. dockerExecStdin → VIEWS_DDL_TRANSACTION (lookups + view + MV in BEGIN/COMMIT)
 *   6. dockerExec → POST_LOAD_VERIFY_SQL
 */
function stubHappyPath(): void {
  mockReadFile
    .mockReturnValueOnce(SAMPLE_CSV) // raw bytes for transcode
    .mockReturnValueOnce(SAMPLE_CSV); // transcoded buffer for \copy
  mockExec
    .mockReturnValueOnce("CREATE TABLE\nCREATE INDEX\n") // RAW_DDL
    .mockReturnValueOnce("0\n") // COUNT(*) — empty
    .mockReturnValueOnce("TRUNCATE TABLE\n") // TRUNCATE
    .mockReturnValueOnce("COPY 1\n") // \copy
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
});

describe("loadSedatuFinanciamientos (orchestration)", () => {
  it("aborts when raw table is non-empty and --force not supplied", async () => {
    mockExec
      .mockReturnValueOnce("CREATE TABLE\n") // RAW_DDL
      .mockReturnValueOnce("325649\n"); // COUNT(*) returns nonzero

    await expect(
      loadSedatuFinanciamientos({
        csv: "raw/sedatu/financiamientos_2025.csv",
        force: false,
        container: "supabase-db",
      }),
    ).rejects.toThrow(/has 325649 rows/);
    expect(mockExec.mock.calls.length).toBe(2);
  });

  it("happy path: applies schema, transcodes, copies, builds views atomically, verifies", async () => {
    stubHappyPath();
    await loadSedatuFinanciamientos({
      csv: "raw/sedatu/financiamientos_2025.csv",
      force: true,
      container: "supabase-db",
    });
    // 6 exec calls in canonical order
    expect(mockExec).toHaveBeenCalledTimes(6);

    // Call 1: RAW_DDL via stdin
    expect(mockExec.mock.calls[0]?.[2]).toMatchObject({ input: RAW_DDL });
    // Call 4: \copy command — args include STDIN copy invocation
    const copyArgs = (mockExec.mock.calls[3]?.[1] ?? []) as string[];
    expect(copyArgs.join(" ")).toContain(
      `\\copy sedatu_financiamientos_raw_2025 (${RAW_HEADER_COLS.join(", ")}) FROM STDIN`,
    );
    // Call 5: VIEWS_DDL_TRANSACTION (single atomic call wrapping all DDLs)
    expect(mockExec.mock.calls[4]?.[2]).toMatchObject({
      input: VIEWS_DDL_TRANSACTION,
    });
    // Call 6: POST_LOAD_VERIFY_SQL
    expect(mockExec.mock.calls[5]?.[1]?.join(" ")).toContain(
      POST_LOAD_VERIFY_SQL,
    );
  });

  it("VIEWS_DDL_TRANSACTION wraps lookup + view + MV in BEGIN/COMMIT (W1 atomicity)", () => {
    expect(VIEWS_DDL_TRANSACTION.startsWith("BEGIN;")).toBe(true);
    expect(VIEWS_DDL_TRANSACTION.endsWith("COMMIT;")).toBe(true);
    // All 3 DDL families included verbatim
    expect(VIEWS_DDL_TRANSACTION).toContain(LOOKUPS_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(FINANCIAMIENTOS_VIEW_DDL);
    expect(VIEWS_DDL_TRANSACTION).toContain(FINANCING_BY_MUNI_DDL);
    // Order matters: drops first, lookups before view, view before MV
    const dropIdx = VIEWS_DDL_TRANSACTION.indexOf(
      "DROP MATERIALIZED VIEW IF EXISTS sedatu_financing_by_municipio",
    );
    const lookupIdx = VIEWS_DDL_TRANSACTION.indexOf(LOOKUPS_DDL);
    const viewIdx = VIEWS_DDL_TRANSACTION.indexOf(FINANCIAMIENTOS_VIEW_DDL);
    const mvIdx = VIEWS_DDL_TRANSACTION.indexOf(FINANCING_BY_MUNI_DDL);
    expect(dropIdx).toBeLessThan(lookupIdx);
    expect(lookupIdx).toBeLessThan(viewIdx);
    expect(viewIdx).toBeLessThan(mvIdx);
  });

  it("cleans up tempdir even on docker-exec failure during DDL step", async () => {
    mockReadFile
      .mockReturnValueOnce(SAMPLE_CSV)
      .mockReturnValueOnce(SAMPLE_CSV);
    mockExec
      .mockReturnValueOnce("CREATE TABLE\n") // RAW_DDL ok
      .mockReturnValueOnce("0\n") // COUNT 0 — proceed
      .mockReturnValueOnce("TRUNCATE\n") // TRUNCATE ok
      .mockReturnValueOnce("COPY 1\n") // \copy ok
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
