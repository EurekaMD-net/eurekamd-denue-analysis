import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));
const { mockMkdtemp, mockWriteFile, mockRm } = vi.hoisted(() => ({
  mockMkdtemp: vi.fn(),
  mockWriteFile: vi.fn(),
  mockRm: vi.fn(),
}));
vi.mock("node:fs", () => ({
  mkdtempSync: mockMkdtemp,
  writeFileSync: mockWriteFile,
  rmSync: mockRm,
}));

import {
  loadCnbvPanorama,
  POST_LOAD_SQL_FOR_TEST,
  MUNI_RAW_DDL,
  ESTADO_RAW_DDL,
  tableLeadingCols,
} from "./load-cnbv-panorama.js";

beforeEach(() => {
  mockExec.mockReset();
  mockMkdtemp.mockReset();
  mockWriteFile.mockReset();
  mockRm.mockReset();
  mockMkdtemp.mockReturnValue("/tmp/cnbv-panorama-xyz");
});
afterEach(() => vi.restoreAllMocks());

/**
 * Drive a successful end-to-end loadCnbvPanorama with the canonical happy-path
 * exec sequence:
 *   1. python3 cnbv-panorama-xlsx-to-csv.py --sheet=muni
 *   2. python3 cnbv-panorama-xlsx-to-csv.py --sheet=estado
 *   3. psql DROP/CREATE muni raw
 *   4. psql DROP/CREATE estado raw
 *   5. docker cp muni csv
 *   6. \copy muni
 *   7. rm muni csv inside container
 *   8. docker cp estado csv
 *   9. \copy estado
 *   10. rm estado csv inside container
 *   11. psql DROP/CREATE muni view
 *   12. psql DROP/CREATE estado view
 *   13-16. count(muni view) / count(estado view) / muni dup guard / estado dup guard
 */
function stubHappyPath(
  opts: {
    muniRows?: number;
    estadoRows?: number;
    muniDups?: number;
    estadoDups?: number;
  } = {},
): void {
  const muniRows = opts.muniRows ?? 2469;
  const estadoRows = opts.estadoRows ?? 32;
  const muniDups = opts.muniDups ?? 0;
  const estadoDups = opts.estadoDups ?? 0;
  mockExec
    .mockReturnValueOnce("clave_municipio_num,cve_mun,...\n1001,01001,...\n") // py muni
    .mockReturnValueOnce("cve_estado_num,nom_ent,...\n1,Aguascalientes,...\n") // py estado
    .mockReturnValueOnce("DROP TABLE\nCREATE TABLE\n") // muni raw DDL
    .mockReturnValueOnce("DROP TABLE\nCREATE TABLE\n") // estado raw DDL
    .mockReturnValueOnce("") // docker cp muni
    .mockReturnValueOnce("COPY 2469\n") // \copy muni
    .mockReturnValueOnce("") // rm muni
    .mockReturnValueOnce("") // docker cp estado
    .mockReturnValueOnce("COPY 32\n") // \copy estado
    .mockReturnValueOnce("") // rm estado
    .mockReturnValueOnce("DROP VIEW\nCREATE VIEW\n") // muni view
    .mockReturnValueOnce("DROP VIEW\nCREATE VIEW\n") // estado view
    .mockReturnValueOnce("CREATE INDEX\nCREATE INDEX\n") // index DDL (SV1)
    .mockReturnValueOnce(`${muniRows}\n`) // muni count
    .mockReturnValueOnce(`${estadoRows}\n`) // estado count
    .mockReturnValueOnce(`${muniDups}\n`) // muni dup guard
    .mockReturnValueOnce(`${estadoDups}\n`); // estado dup guard
}

describe("loadCnbvPanorama (orchestration)", () => {
  it("rejects malformed dbContainer (anti docker-flag injection)", async () => {
    await expect(
      loadCnbvPanorama({
        xlsxPath: "/p.xlsx",
        dbContainer: "--rm",
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    await expect(
      loadCnbvPanorama({
        xlsxPath: "/p.xlsx",
        dbContainer: "",
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects xlsxPath beginning with '-'", async () => {
    await expect(
      loadCnbvPanorama({
        xlsxPath: "--rm-volumes",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/xlsxPath inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("invokes python converter twice (--sheet=muni then --sheet=estado)", async () => {
    stubHappyPath();
    await loadCnbvPanorama({
      xlsxPath: "raw/cnbv/Anexo_Panorama_2025.xlsx",
      dbContainer: "supabase-db",
    });
    // First two exec calls are the python converter invocations
    const py0 = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const py1 = mockExec.mock.calls[1]?.[1] as string[] | undefined;
    expect(py0).toEqual([
      "scripts/cnbv-panorama-xlsx-to-csv.py",
      "--sheet=muni",
      "raw/cnbv/Anexo_Panorama_2025.xlsx",
    ]);
    expect(py1).toEqual([
      "scripts/cnbv-panorama-xlsx-to-csv.py",
      "--sheet=estado",
      "raw/cnbv/Anexo_Panorama_2025.xlsx",
    ]);
    // Both python stdout payloads written to tmpfiles in the work dir
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
  });

  it("issues \\copy with NULL '*' so the converter sentinel maps to NULL", async () => {
    stubHappyPath();
    await loadCnbvPanorama({
      xlsxPath: "/x.xlsx",
      dbContainer: "supabase-db",
    });
    // \copy invocations are at exec calls 5 and 8 (0-indexed). Both should
    // include FORMAT csv, HEADER true, NULL '*'.
    const call5 = mockExec.mock.calls[5]?.[1] as string[];
    const call8 = mockExec.mock.calls[8]?.[1] as string[];
    expect(call5.join(" ")).toContain("FORMAT csv, HEADER true, NULL '*'");
    expect(call5.join(" ")).toContain("cnbv_panorama_municipal_raw");
    expect(call8.join(" ")).toContain("FORMAT csv, HEADER true, NULL '*'");
    expect(call8.join(" ")).toContain("cnbv_panorama_estatal_raw");
  });

  it("returns counts from psql and tracks duration", async () => {
    stubHappyPath({ muniRows: 2469, estadoRows: 32 });
    const result = await loadCnbvPanorama({
      xlsxPath: "/x.xlsx",
      dbContainer: "supabase-db",
    });
    expect(result.muni_rows).toBe(2469);
    expect(result.estado_rows).toBe(32);
    expect(typeof result.duration_ms).toBe("number");
  });

  it("hard-fails when muni view has duplicate cve_mun groups", async () => {
    stubHappyPath({ muniDups: 3 });
    await expect(
      loadCnbvPanorama({
        xlsxPath: "/x.xlsx",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/3 cve_mun groups have >1 row/);
  });

  it("hard-fails when estado view has duplicate cve_ent groups", async () => {
    stubHappyPath({ estadoDups: 1 });
    await expect(
      loadCnbvPanorama({
        xlsxPath: "/x.xlsx",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/1 cve_ent groups have >1 row/);
  });

  it("hard-fails on non-numeric count output (psql producing garbage)", async () => {
    mockExec
      .mockReturnValueOnce("hdr\n") // py muni
      .mockReturnValueOnce("hdr\n") // py estado
      .mockReturnValueOnce("") // muni raw DDL
      .mockReturnValueOnce("") // estado raw DDL
      .mockReturnValueOnce("") // docker cp muni
      .mockReturnValueOnce("COPY\n") // \copy muni
      .mockReturnValueOnce("") // rm muni
      .mockReturnValueOnce("") // docker cp estado
      .mockReturnValueOnce("COPY\n") // \copy estado
      .mockReturnValueOnce("") // rm estado
      .mockReturnValueOnce("") // muni view
      .mockReturnValueOnce("") // estado view
      .mockReturnValueOnce("") // index DDL (SV1)
      .mockReturnValueOnce("not-a-number\n"); // muni count → garbage
    await expect(
      loadCnbvPanorama({
        xlsxPath: "/x.xlsx",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/unexpected count output/);
  });

  it("cleans up tempdir on success", async () => {
    stubHappyPath();
    await loadCnbvPanorama({
      xlsxPath: "/x.xlsx",
      dbContainer: "supabase-db",
    });
    expect(mockRm).toHaveBeenCalledTimes(1);
    const rmArgs = mockRm.mock.calls[0];
    expect(rmArgs?.[0]).toBe("/tmp/cnbv-panorama-xyz");
    expect(rmArgs?.[1]).toEqual({ recursive: true, force: true });
  });

  it("cleans up tempdir even when load fails partway", async () => {
    mockExec.mockReturnValueOnce("hdr\n").mockImplementationOnce(() => {
      throw new Error("python converter failed");
    });
    await expect(
      loadCnbvPanorama({
        xlsxPath: "/x.xlsx",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/python converter failed/);
    expect(mockRm).toHaveBeenCalledTimes(1);
    expect(mockRm.mock.calls[0]?.[0]).toBe("/tmp/cnbv-panorama-xyz");
    // W1 audit follow-up: assert recursive cleanup is symmetric with the
    // happy-path test. Without this, a future refactor could downgrade
    // the cleanup to a non-recursive rmSync and the test would still pass
    // even though the tempdir would leak its csv contents on failure.
    expect(mockRm.mock.calls[0]?.[1]).toEqual({
      recursive: true,
      force: true,
    });
  });

  it("aborts and cleans up tempdir when raw-table DDL fails", async () => {
    // W2 audit follow-up: parallel to "python converter failed" but at the
    // psql DDL step (call #3). If a future schema migration breaks the
    // muni raw DDL, the loader must NOT leak the tempdir or the python
    // CSV outputs. This test pins the finally-block invariant at the
    // first psql call rather than the python converter call.
    mockExec
      .mockReturnValueOnce("hdr\n") // py muni
      .mockReturnValueOnce("hdr\n") // py estado
      .mockImplementationOnce(() => {
        throw new Error("psql: ERROR — relation already exists");
      });
    await expect(
      loadCnbvPanorama({
        xlsxPath: "/x.xlsx",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/relation already exists/);
    expect(mockRm).toHaveBeenCalledTimes(1);
    expect(mockRm.mock.calls[0]?.[1]).toEqual({
      recursive: true,
      force: true,
    });
  });
});

describe("POST_LOAD_SQL_FOR_TEST (view contract)", () => {
  it("creates both panorama views", () => {
    expect(POST_LOAD_SQL_FOR_TEST).toContain(
      "DROP VIEW IF EXISTS cnbv_panorama_municipal CASCADE",
    );
    expect(POST_LOAD_SQL_FOR_TEST).toContain(
      "CREATE VIEW cnbv_panorama_municipal",
    );
    expect(POST_LOAD_SQL_FOR_TEST).toContain(
      "DROP VIEW IF EXISTS cnbv_panorama_estatal CASCADE",
    );
    expect(POST_LOAD_SQL_FOR_TEST).toContain(
      "CREATE VIEW cnbv_panorama_estatal",
    );
  });

  it("filters muni catch-all sentinel (cve_mun=99999)", () => {
    // The 99999 row from CNBV's "No identificado" catch-all must NOT
    // surface via the view — defense-in-depth even though the converter
    // already drops it.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/cve_mun\s*<>\s*'99999'/);
  });

  it("filters estado catch-all sentinel (cve_estado_num=99)", () => {
    // BETWEEN 1 AND 32 is a tighter guard than `<> 99` — also rejects 0 / 33+.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /cve_estado_num::int\s+BETWEEN\s+1\s+AND\s+32/,
    );
  });

  it("LPADs cve_estado_num to canonical 2-char cve_ent (matches censo_entidades convention)", () => {
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /LPAD\(cve_estado_num,\s*2,\s*'0'\)\s+AS\s+cve_ent/,
    );
  });

  it("applies NULLIF '*' + cast to every numeric column on the muni view", () => {
    // Sample 5 representative cols across families. If view definition swaps
    // the sentinel character or drops the cast for one col, this catches it.
    for (const col of [
      "sucursales_total",
      "cuentas_total",
      "creditos_total",
      "remesas_mdd",
      "g_creditos_total_b",
    ]) {
      expect(POST_LOAD_SQL_FOR_TEST).toContain(
        `NULLIF(${col}, '*')::numeric AS ${col}`,
      );
    }
  });

  it("applies NULLIF '*' + cast to every numeric column on the estado view", () => {
    for (const col of [
      "sucursales_total",
      "sar_total",
      "seg_total",
      "remesas_mdd",
      "ac_inf_sucursales",
    ]) {
      expect(POST_LOAD_SQL_FOR_TEST).toContain(
        `NULLIF(${col}, '*')::numeric AS ${col}`,
      );
    }
  });

  it("requires cve_mun to be 5 digits (regex anchor)", () => {
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/cve_mun\s+~\s+'\^\[0-9\]\{5\}\$'/);
  });

  it("preserves rezago_social as TEXT (NULLIF '*' but no ::numeric)", () => {
    // Audit guard: rezago_social is a 5-level ordinal label, not a number.
    expect(POST_LOAD_SQL_FOR_TEST).toContain(
      "NULLIF(rezago_social, '*') AS rezago_social",
    );
    expect(POST_LOAD_SQL_FOR_TEST).not.toContain(
      "NULLIF(rezago_social, '*')::numeric",
    );
  });

  it("preserves periodo column on both views (canonical default 'panorama-2025')", () => {
    // periodo is exposed on both views so consumer can label results
    // without a separate query against the raw table.
    const muniViewBlock = POST_LOAD_SQL_FOR_TEST.split(
      "DROP VIEW IF EXISTS cnbv_panorama_estatal CASCADE",
    )[0]!;
    const estadoViewBlock = POST_LOAD_SQL_FOR_TEST.split(
      "DROP VIEW IF EXISTS cnbv_panorama_estatal CASCADE",
    )[1]!;
    expect(muniViewBlock).toContain("periodo");
    expect(estadoViewBlock).toContain("periodo");
  });
});

/**
 * R10 (round-2 audit follow-up) — drift guard for the cross-source column-list
 * invariant. The same set of columns must be encoded in:
 *   1. The Python converter HEADER list (lives in cnbv-panorama-xlsx-to-csv.py)
 *   2. The CREATE TABLE DDL (MUNI_RAW_DDL / ESTADO_RAW_DDL)
 *   3. The \copy column list (tableLeadingCols)
 *   4. The view's NUMERIC_*_COLS NULLIF projections
 *
 * #2 ↔ #3 are TS-side and the most likely to drift between commits (an
 * operator adding a col to the DDL must remember to add it to tableLeadingCols
 * in the same patch). This test parses the DDL string, extracts the column
 * names, and asserts equality with tableLeadingCols() minus the two DEFAULT
 * cols (periodo, ingested_at) which are not loaded via \copy.
 *
 * If a future Panorama-2026 ingest adds a column to ONE side without the
 * other, this test fires before commit. Cheap insurance.
 */
describe("R10 drift guard — DDL columns vs tableLeadingCols", () => {
  /** Extract column names from a CREATE TABLE DDL block (TEXT or TIMESTAMPTZ). */
  function extractDdlCols(ddl: string): string[] {
    const lines = ddl.split("\n");
    const cols: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("CREATE")) continue;
      if (line.startsWith("DROP")) continue;
      if (line.startsWith(")")) continue;
      // Match `colname TEXT` or `colname TIMESTAMPTZ`, optionally with
      // DEFAULT clause and trailing comma. Anchored to start-of-line for
      // identifier safety (skips inline column-list usage).
      const m = /^([a-z_][a-z0-9_]*)\s+(TEXT|TIMESTAMPTZ)\b/.exec(line);
      if (m) cols.push(m[1]!);
    }
    return cols;
  }

  it("muni DDL columns match tableLeadingCols + (periodo, ingested_at)", () => {
    const ddlCols = extractDdlCols(MUNI_RAW_DDL);
    const leading = tableLeadingCols("cnbv_panorama_municipal_raw");
    // tableLeadingCols excludes the two DEFAULT cols; the DDL has them at the end
    expect(ddlCols).toEqual([...leading, "periodo", "ingested_at"]);
    // 76 data cols + 2 DEFAULT = 78 total in DDL
    expect(ddlCols.length).toBe(78);
  });

  it("estado DDL columns match tableLeadingCols + (periodo, ingested_at)", () => {
    const ddlCols = extractDdlCols(ESTADO_RAW_DDL);
    const leading = tableLeadingCols("cnbv_panorama_estatal_raw");
    expect(ddlCols).toEqual([...leading, "periodo", "ingested_at"]);
    // 72 data cols + 2 DEFAULT = 74 total in DDL
    expect(ddlCols.length).toBe(74);
  });

  it("tableLeadingCols throws on unknown table", () => {
    expect(() => tableLeadingCols("not_a_real_table")).toThrow(/unknown table/);
  });

  it("muni leading cols start with the 5 ID cols in canonical order", () => {
    const leading = tableLeadingCols("cnbv_panorama_municipal_raw");
    expect(leading.slice(0, 5)).toEqual([
      "clave_municipio_num",
      "cve_mun",
      "nom_ent",
      "nom_mun",
      "nom_ent_mun",
    ]);
  });

  it("estado leading cols start with the 4 ID cols in canonical order", () => {
    const leading = tableLeadingCols("cnbv_panorama_estatal_raw");
    expect(leading.slice(0, 4)).toEqual([
      "cve_estado_num",
      "nom_ent",
      "poblacion_total",
      "poblacion_adulta",
    ]);
  });
});
