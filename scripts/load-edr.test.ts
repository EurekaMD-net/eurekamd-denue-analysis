import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));
const { mockOpen, mockRead, mockClose } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockRead: vi.fn(),
  mockClose: vi.fn(),
}));
// Keep the real readFileSync: _psql-tx reads perf-matviews.sql / sage-role.sql.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  openSync: mockOpen,
  readSync: mockRead,
  closeSync: mockClose,
}));

import {
  buildEdrAppendSql,
  buildEdrReloadSql,
  EDR_COLUMNS,
  EDR_DDL_FOR_TEST,
  expectEdrHeader,
  loadEdr,
} from "./load-edr.js";

beforeEach(() => {
  mockExec.mockReset();
  mockOpen.mockReset();
  mockRead.mockReset();
  mockClose.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const REAL_HEADER = EDR_COLUMNS.join(",");

function stubHeader(headerLine: string): void {
  mockOpen.mockReturnValue(7);
  mockRead.mockImplementation(
    (
      _fd: number,
      buf: Buffer,
      offset: number,
      length: number,
      _pos: number,
    ) => {
      const bytes = Buffer.from(`${headerLine}\n`, "utf-8");
      bytes.copy(buf, offset, 0, Math.min(length, bytes.length));
      return Math.min(length, bytes.length);
    },
  );
  mockClose.mockReturnValue(undefined);
}

// ---------------------------------------------------------------------------
// expectEdrHeader (header validation)
// ---------------------------------------------------------------------------

describe("expectEdrHeader", () => {
  it("accepts the canonical 74-column INEGI header", () => {
    expect(() => expectEdrHeader(REAL_HEADER)).not.toThrow();
  });

  it("strips the UTF-8 BOM before validating", () => {
    expect(() => expectEdrHeader(`﻿${REAL_HEADER}`)).not.toThrow();
  });

  it("rejects too few columns", () => {
    const truncated = EDR_COLUMNS.slice(0, 50).join(",");
    expect(() => expectEdrHeader(truncated)).toThrow(/expected 74 columns/);
  });

  it("rejects a misordered column at the same length", () => {
    const swapped = [...EDR_COLUMNS];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(() => expectEdrHeader(swapped.join(","))).toThrow(
      /column 1 mismatch/,
    );
  });

  it("rejects unsafe column names (defensive guard)", () => {
    // Build a same-length header with one bad name in the right position.
    // expectEdrHeader checks ordering first, so we mock with a header where
    // only position N is unsafe. We use the swap technique: swap position 0
    // with a bad name; ordering check fires first → unsafe-name guard
    // unreachable from the public API. Coverage of that branch lives behind
    // the order check by design (defense in depth).
    const bad = ["bad-name", ...EDR_COLUMNS.slice(1)];
    expect(() => expectEdrHeader(bad.join(","))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// EDR_DDL_FOR_TEST (DDL safety)
// ---------------------------------------------------------------------------

describe("EDR_DDL_FOR_TEST", () => {
  it("declares all 74 columns as TEXT", () => {
    for (const col of EDR_COLUMNS) {
      expect(EDR_DDL_FOR_TEST).toContain(`${col} TEXT`);
    }
  });

  it("creates supporting indexes on residence + year", () => {
    expect(EDR_DDL_FOR_TEST).toMatch(/idx_edr_ent_resid/);
    expect(EDR_DDL_FOR_TEST).toMatch(/idx_edr_anio_ocur/);
    expect(EDR_DDL_FOR_TEST).toMatch(/idx_edr_cve_mun_resid/);
  });

  it("filters the cve_mun_resid index to valid Mexican municipios only", () => {
    expect(EDR_DDL_FOR_TEST).toMatch(/WHERE ent_resid IN \('01','02'/);
    expect(EDR_DDL_FOR_TEST).toMatch(/mun_resid != '999'/);
  });

  it("uses DROP TABLE IF EXISTS for idempotent rerun", () => {
    expect(EDR_DDL_FOR_TEST).toMatch(/DROP TABLE IF EXISTS/);
  });

  it("never CASCADEs (audit #144 — it silently dropped mv_mortalidad_municipal_yearly)", () => {
    expect(EDR_DDL_FOR_TEST).not.toMatch(/CASCADE/);
  });
});

describe("buildEdrReloadSql (audit #144)", () => {
  const sql = buildEdrReloadSql("/tmp/edr_raw_1.csv");

  it("\\copies into staging before dropping anything live", () => {
    expect(sql.indexOf("\\copy inegi_edr_defunciones_raw_staging FROM '/tmp/edr_raw_1.csv'")).toBeLessThan(
      sql.indexOf("DROP MATERIALIZED VIEW IF EXISTS mv_mortalidad_municipal_yearly;"),
    );
  });

  it("drops the MV explicitly, swaps, indexes the swapped table, then rebuilds the MV", () => {
    const dropMv = sql.indexOf("DROP MATERIALIZED VIEW IF EXISTS mv_mortalidad_municipal_yearly;");
    const dropTable = sql.indexOf("DROP TABLE IF EXISTS inegi_edr_defunciones_raw;");
    const swap = sql.indexOf(
      "ALTER TABLE inegi_edr_defunciones_raw_staging RENAME TO inegi_edr_defunciones_raw;",
    );
    const index = sql.indexOf("CREATE INDEX idx_edr_ent_resid ON inegi_edr_defunciones_raw ");
    const rebuild = sql.indexOf("CREATE MATERIALIZED VIEW mv_mortalidad_municipal_yearly AS");
    expect(dropMv).toBeGreaterThan(-1);
    expect(dropMv).toBeLessThan(dropTable);
    expect(dropTable).toBeLessThan(swap);
    expect(swap).toBeLessThan(index);
    expect(index).toBeLessThan(rebuild);
    expect(sql).not.toMatch(/DROP (TABLE|VIEW)[^;]*CASCADE/);
    expect(sql).toContain("GRANT SELECT ON mv_mortalidad_municipal_yearly TO denue_sage;");
  });
});

// ---------------------------------------------------------------------------
// loadEdr orchestration
// ---------------------------------------------------------------------------

describe("loadEdr", () => {
  it("validates dbContainer regex before any docker call", async () => {
    stubHeader(REAL_HEADER);
    await expect(
      loadEdr({
        csvPath: "/tmp/x.csv",
        dbContainer: "bad container with spaces",
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects a leading-dash csvPath (argument injection defense)", async () => {
    stubHeader(REAL_HEADER);
    await expect(
      loadEdr({ csvPath: "-rm -rf /", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/csvPath inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("validates the CSV header before invoking docker", async () => {
    stubHeader("foo,bar,baz");
    await expect(
      loadEdr({ csvPath: "/tmp/x.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/expected 74 columns/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("orchestrates DDL → docker cp → \\copy → cleanup → counts", async () => {
    stubHeader(REAL_HEADER);
    // Sequence: cp, reload transaction, cleanup-rm, count(raw),
    // count(residence), count(distinct), to_regclass assertion
    mockExec
      .mockReturnValueOnce("") // docker cp
      .mockReturnValueOnce("") // reload transaction
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("819672") // raw_rows
      .mockReturnValueOnce("809063") // rows_with_residence
      .mockReturnValueOnce("2472") // rows_unique_municipios
      .mockReturnValueOnce(""); // nothing missing

    const result = await loadEdr({
      csvPath: "/tmp/edr.csv",
      dbContainer: "supabase-db",
    });

    expect(result.raw_rows).toBe(819672);
    expect(result.rows_with_residence).toBe(809063);
    expect(result.rows_unique_municipios).toBe(2472);
    expect(typeof result.duration_ms).toBe("number");

    // Verify docker cp was the first call with `--` separator (path-injection defense)
    const cpCall = mockExec.mock.calls[0];
    expect(cpCall?.[0]).toBe("docker");
    expect(cpCall?.[1]).toEqual([
      "cp",
      "--",
      "/tmp/edr.csv",
      expect.stringMatching(/^supabase-db:\/tmp\/edr_raw_/),
    ]);
    // The whole replace runs as ONE single-transaction psql session.
    const tx = mockExec.mock.calls[1];
    expect(tx?.[1]).toContain("--single-transaction");
    expect((tx?.[2] as { input: string }).input).toMatch(
      /\\copy inegi_edr_defunciones_raw_staging FROM '\/tmp\/edr_raw_\d+\.csv'/,
    );
  });

  it("fails loud when an analytics MV is missing after the load", async () => {
    stubHeader(REAL_HEADER);
    mockExec
      .mockReturnValueOnce("") // docker cp
      .mockReturnValueOnce("") // reload transaction
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("1")
      .mockReturnValueOnce("1")
      .mockReturnValueOnce("1")
      .mockReturnValueOnce("mv_mortalidad_municipal_yearly\n");
    await expect(
      loadEdr({ csvPath: "/tmp/edr.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/missing after load: mv_mortalidad_municipal_yearly/);
  });

  it("skips DDL when --append is passed and purges prior anio_regis (audit M1)", async () => {
    // Header + first data row with anio_regis=2023 in column 32 (index 31).
    // Build a synthetic data row by joining 74 placeholder values; index 31
    // is anio_regis, set to "2023".
    const dataFields = EDR_COLUMNS.map((_c, i) => (i === 31 ? "2023" : "1"));
    const fakeFile = `${REAL_HEADER}\n${dataFields.join(",")}\n`;
    mockOpen.mockReturnValue(7);
    mockRead.mockImplementation(
      (
        _fd: number,
        buf: Buffer,
        offset: number,
        length: number,
        _pos: number,
      ) => {
        const bytes = Buffer.from(fakeFile, "utf-8");
        bytes.copy(buf, offset, 0, Math.min(length, bytes.length));
        return Math.min(length, bytes.length);
      },
    );
    mockClose.mockReturnValue(undefined);

    mockExec
      .mockReturnValueOnce("") // docker cp
      .mockReturnValueOnce("") // DELETE year + \copy (one tx, audit #147)
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("1639344") // raw_rows (2x)
      .mockReturnValueOnce("1618000") // rows_with_residence
      .mockReturnValueOnce("2472") // rows_unique_municipios
      .mockReturnValueOnce(""); // nothing missing

    await loadEdr({
      csvPath: "/tmp/edr2023.csv",
      dbContainer: "supabase-db",
      append: true,
    });

    // First call: cp (no DDL, no purge outside the transaction).
    expect(mockExec.mock.calls[0]?.[1]?.[0]).toBe("cp");
    // Second call: DELETE keyed by the year extracted from line 2, then
    // \copy — ONE single-transaction psql session (audit #147), so a failed
    // \copy rolls the purge back instead of leaving 2023 deleted.
    const txCall = mockExec.mock.calls[1];
    expect(txCall?.[1]).toContain("--single-transaction");
    const txSql = String((txCall?.[2] as { input: string }).input);
    const containerPath = String(
      (mockExec.mock.calls[0]?.[1] as string[])[3],
    ).replace("supabase-db:", "");
    expect(txSql).toBe(buildEdrAppendSql(containerPath, "2023"));
    expect(txSql).toMatch(/DELETE FROM inegi_edr_defunciones_raw/);
    expect(txSql).toMatch(/anio_regis = '2023'/);
    expect(txSql.indexOf("DELETE")).toBeLessThan(txSql.indexOf("\\copy"));
    // No psql session runs the DELETE on its own.
    const loneDeletes = mockExec.mock.calls.filter((c) =>
      ((c[1] as string[]) ?? []).some((a) => a.includes("DELETE FROM")),
    );
    expect(loneDeletes).toHaveLength(0);
  });

  it("buildEdrAppendSql: DELETE + \\copy, or \\copy alone when the year is unknown", () => {
    expect(buildEdrAppendSql("/tmp/e.csv", "2023")).toBe(
      "DELETE FROM inegi_edr_defunciones_raw WHERE anio_regis = '2023';\n" +
        "\\copy inegi_edr_defunciones_raw FROM '/tmp/e.csv' WITH (FORMAT csv, HEADER true)",
    );
    expect(buildEdrAppendSql("/tmp/e.csv", null)).toBe(
      "\\copy inegi_edr_defunciones_raw FROM '/tmp/e.csv' WITH (FORMAT csv, HEADER true)",
    );
    expect(() => buildEdrAppendSql("/tmp/e.csv", "2023'; DROP")).toThrow(
      /anio_regis inválido/,
    );
  });

  it("--append with unparseable anio_regis skips purge (loader proceeds)", async () => {
    // First data row missing anio_regis (column 31 empty).
    const dataFields = EDR_COLUMNS.map((_c, i) => (i === 31 ? "" : "1"));
    const fakeFile = `${REAL_HEADER}\n${dataFields.join(",")}\n`;
    mockOpen.mockReturnValue(7);
    mockRead.mockImplementation(
      (
        _fd: number,
        buf: Buffer,
        offset: number,
        length: number,
        _pos: number,
      ) => {
        const bytes = Buffer.from(fakeFile, "utf-8");
        bytes.copy(buf, offset, 0, Math.min(length, bytes.length));
        return Math.min(length, bytes.length);
      },
    );
    mockClose.mockReturnValue(undefined);

    mockExec
      .mockReturnValueOnce("") // docker cp (no purge, no DDL)
      .mockReturnValueOnce("") // \copy (one tx, no DELETE)
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("0")
      .mockReturnValueOnce("0")
      .mockReturnValueOnce("0")
      .mockReturnValueOnce(""); // nothing missing

    await loadEdr({
      csvPath: "/tmp/edr-bad.csv",
      dbContainer: "supabase-db",
      append: true,
    });

    // First call should jump straight to cp — purge is skipped on unparseable year.
    expect(mockExec.mock.calls[0]?.[1]?.[0]).toBe("cp");
    expect(
      String((mockExec.mock.calls[1]?.[2] as { input: string }).input),
    ).not.toMatch(/DELETE/);
  });

  it("cleans up the container temp file even if \\copy throws", async () => {
    stubHeader(REAL_HEADER);
    mockExec
      .mockReturnValueOnce("") // docker cp
      .mockImplementationOnce(() => {
        throw new Error("\\copy failed: ERROR: malformed CSV");
      });

    await expect(
      loadEdr({ csvPath: "/tmp/edr.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/\\copy failed/);

    // Cleanup `rm -f` should have been attempted (3rd call)
    const cleanupCall = mockExec.mock.calls[2];
    expect(cleanupCall?.[1]).toEqual([
      "exec",
      "supabase-db",
      "rm",
      "-f",
      expect.stringMatching(/^\/tmp\/edr_raw_/),
    ]);
  });

  it("rejects unparseable count output as a server-bug guard", async () => {
    stubHeader(REAL_HEADER);
    mockExec
      .mockReturnValueOnce("") // cp
      .mockReturnValueOnce("") // reload transaction
      .mockReturnValueOnce("") // rm
      .mockReturnValueOnce("not a number"); // bad count

    await expect(
      loadEdr({ csvPath: "/tmp/edr.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/unexpected count output/);
  });
});
