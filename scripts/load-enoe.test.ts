import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));

import {
  ENOE_RAW_DDL_FOR_TEST,
  ENOE_SDEM_COL_INDEX,
  calibratorsDdlForTest,
  loadEnoe,
} from "./load-enoe.js";

beforeEach(() => mockExec.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("ENOE_SDEM_COL_INDEX", () => {
  it("declares stable column positions across the 2025 schema rename", () => {
    // Q1+Q2 named these `ent`/`mun`/etc; Q3+Q4 renamed to `cve_ent`/`cve_mun`/etc.
    // The position-based loader sidesteps the rename — these indices are
    // load-bearing and should not drift without operator review.
    expect(ENOE_SDEM_COL_INDEX.ent).toBe(11);
    expect(ENOE_SDEM_COL_INDEX.eda).toBe(25);
    expect(ENOE_SDEM_COL_INDEX.fac_tri).toBe(53);
    expect(ENOE_SDEM_COL_INDEX.clase1).toBe(55);
    expect(ENOE_SDEM_COL_INDEX.clase2).toBe(56);
    expect(ENOE_SDEM_COL_INDEX.ingocup).toBe(97);
    expect(ENOE_SDEM_COL_INDEX.emp_ppal).toBe(107);
  });
});

describe("ENOE_RAW_DDL_FOR_TEST", () => {
  it("declares the 7 calibration cols + trimestre tag as TEXT/INT", () => {
    expect(ENOE_RAW_DDL_FOR_TEST).toMatch(/trimestre INT NOT NULL/);
    for (const col of [
      "ent",
      "fac_tri",
      "clase1",
      "clase2",
      "eda",
      "ingocup",
      "emp_ppal",
    ]) {
      expect(ENOE_RAW_DDL_FOR_TEST).toContain(`${col} TEXT`);
    }
  });

  it("indexes by ent + trimestre", () => {
    expect(ENOE_RAW_DDL_FOR_TEST).toMatch(/idx_enoe_sdem_ent/);
    expect(ENOE_RAW_DDL_FOR_TEST).toMatch(/idx_enoe_sdem_trim/);
  });

  it("uses DROP TABLE IF EXISTS for idempotent rerun", () => {
    expect(ENOE_RAW_DDL_FOR_TEST).toMatch(/DROP TABLE IF EXISTS/);
  });
});

describe("calibratorsDdlForTest", () => {
  it("inlines the year as integer literal in DELETE + INSERT", () => {
    const sql = calibratorsDdlForTest(2025);
    expect(sql).toMatch(
      /DELETE FROM calibrators_enoe_state WHERE ano_levantamiento = 2025/,
    );
    expect(sql).toMatch(/2025\s+AS ano_levantamiento/);
  });

  it("uses CREATE TABLE IF NOT EXISTS so multi-wave loads stack", () => {
    const sql = calibratorsDdlForTest(2025);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS calibrators_enoe_state/);
  });

  it("filters parsed rows to valid Mexican entidades + non-zero factor", () => {
    const sql = calibratorsDdlForTest(2025);
    expect(sql).toMatch(
      /LPAD\(TRIM\(ent\), 2, '0'\) ~ '\^\(0\[1-9\]\|\[12\]\[0-9\]\|3\[0-2\]\)\$'/,
    );
    expect(sql).toMatch(/NULLIF\(TRIM\(fac_tri\), ''\)::numeric > 0/);
  });

  it("trims whitespace before NULLIF (INEGI ' ' sentinel)", () => {
    const sql = calibratorsDdlForTest(2025);
    // INEGI ships single-space ' ' in eda/ingocup/etc as "no aplica".
    // NULLIF(' ','') doesn't strip it; need TRIM first.
    expect(sql).toMatch(/NULLIF\(TRIM\(eda\), ''\)/);
    expect(sql).toMatch(/NULLIF\(TRIM\(ingocup\), ''\)/);
  });

  it("divides absolute counts by trimestres_cargados (per-quarter avg)", () => {
    const sql = calibratorsDdlForTest(2025);
    // Without this, summing factor across 4 quarters inflates abs counts 4×.
    // Rates (numerator/denom both summed) cancel the inflation; absolute
    // pop / pea / ocupada / desocupada / informal need the divide.
    expect(sql).toMatch(
      /NULLIF\(COUNT\(DISTINCT trimestre\), 0\)\)::bigint\s+AS poblacion_15_mas/,
    );
    expect(sql).toMatch(
      /NULLIF\(COUNT\(DISTINCT trimestre\), 0\)\)::bigint\s+AS pea/,
    );
    expect(sql).toMatch(
      /NULLIF\(COUNT\(DISTINCT trimestre\), 0\)\)::bigint\s+AS desocupada/,
    );
  });

  it("computes the 3 INEGI rates with correct numerator/denominator", () => {
    const sql = calibratorsDdlForTest(2025);
    // tasa_participacion = PEA / pob_15_mas
    expect(sql).toMatch(
      /SUM\(w\) FILTER \(WHERE clase1 = '1'\)::numeric \* 100\s+\/ NULLIF\(SUM\(w\) FILTER \(WHERE edad >= 15\), 0\)/,
    );
    // tasa_desocupacion = desocupada / PEA
    expect(sql).toMatch(
      /SUM\(w\) FILTER \(WHERE clase2 = '2'\)::numeric \* 100\s+\/ NULLIF\(SUM\(w\) FILTER \(WHERE clase1 = '1'\), 0\)/,
    );
    // tasa_informalidad = informal / ocupada
    expect(sql).toMatch(
      /SUM\(w\) FILTER \(WHERE emp_ppal = '1'\)::numeric \* 100\s+\/ NULLIF\(SUM\(w\) FILTER \(WHERE clase2 = '1'\), 0\)/,
    );
  });
});

describe("loadEnoe", () => {
  it("validates dbContainer regex before any docker call", async () => {
    await expect(
      loadEnoe({
        quarters: [{ trimestre: 1, csvPath: "/tmp/x.csv" }],
        dbContainer: "bad container",
        year: 2025,
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects out-of-range year", async () => {
    await expect(
      loadEnoe({
        quarters: [{ trimestre: 1, csvPath: "/tmp/x.csv" }],
        dbContainer: "supabase-db",
        year: 1850,
      }),
    ).rejects.toThrow(/year inválido/);
  });

  it("rejects empty quarters list", async () => {
    await expect(
      loadEnoe({ quarters: [], dbContainer: "supabase-db", year: 2025 }),
    ).rejects.toThrow(/at least one quarter/);
  });

  it("rejects out-of-range trimestre", async () => {
    await expect(
      loadEnoe({
        quarters: [{ trimestre: 5, csvPath: "/tmp/x.csv" }],
        dbContainer: "supabase-db",
        year: 2025,
      }),
    ).rejects.toThrow(/trimestre inválido/);
  });

  it("rejects leading-dash csvPath in any quarter (arg-injection defense)", async () => {
    await expect(
      loadEnoe({
        quarters: [{ trimestre: 1, csvPath: "-rm" }],
        dbContainer: "supabase-db",
        year: 2025,
      }),
    ).rejects.toThrow(/csvPath\[Q1\] inválido/);
  });

  it("orchestrates DDL → per-quarter (cp + awk + \\copy + cleanup) → calib DDL → counts", async () => {
    // 1 raw DDL + per-quarter (cp + awk + \copy + rm) ×2 quarters + calib DDL + 2 counts = 1 + 8 + 1 + 2 = 12 calls
    mockExec
      .mockReturnValueOnce("") // raw DDL
      .mockReturnValueOnce("") // Q1 cp
      .mockReturnValueOnce("") // Q1 awk projection
      .mockReturnValueOnce("") // Q1 \copy
      .mockReturnValueOnce("") // Q1 rm cleanup
      .mockReturnValueOnce("") // Q2 cp
      .mockReturnValueOnce("") // Q2 awk projection
      .mockReturnValueOnce("") // Q2 \copy
      .mockReturnValueOnce("") // Q2 rm cleanup
      .mockReturnValueOnce("") // calibrators DDL
      .mockReturnValueOnce("840000") // raw_rows count
      .mockReturnValueOnce("32"); // calibrators count

    const result = await loadEnoe({
      quarters: [
        { trimestre: 1, csvPath: "/tmp/sdem_1.csv" },
        { trimestre: 2, csvPath: "/tmp/sdem_2.csv" },
      ],
      dbContainer: "supabase-db",
      year: 2025,
    });

    expect(result.raw_rows).toBe(840000);
    expect(result.calibrators_rows).toBe(32);
    expect(result.trimestres_cargados).toEqual([1, 2]);

    // Q1 awk projection should reference the canonical column indices.
    const awkCall = mockExec.mock.calls[2];
    expect(awkCall?.[1]).toEqual([
      "exec",
      "supabase-db",
      "sh",
      "-c",
      expect.stringContaining(`$${ENOE_SDEM_COL_INDEX.ent}`),
    ]);
    // Awk script is at args[4] (after "exec","container","sh","-c"); it
    // should tag trimestre=1 in the output.
    expect(awkCall?.[1]?.[4]).toMatch(/print 1, /);
  });

  it("cleans up container temp files even if \\copy throws", async () => {
    mockExec
      .mockReturnValueOnce("") // raw DDL
      .mockReturnValueOnce("") // Q1 cp
      .mockReturnValueOnce("") // Q1 awk
      .mockImplementationOnce(() => {
        throw new Error("\\copy failed: ERROR: malformed CSV");
      });

    await expect(
      loadEnoe({
        quarters: [{ trimestre: 1, csvPath: "/tmp/sdem.csv" }],
        dbContainer: "supabase-db",
        year: 2025,
      }),
    ).rejects.toThrow(/\\copy failed/);

    // 5th call should be the rm cleanup with both temp filenames
    const cleanupCall = mockExec.mock.calls[4];
    expect(cleanupCall?.[1]?.[0]).toBe("exec");
    expect(cleanupCall?.[1]?.[2]).toBe("rm");
    expect(cleanupCall?.[1]?.[3]).toBe("-f");
    // Two paths passed to rm — src and proj
    expect(cleanupCall?.[1]?.length).toBeGreaterThanOrEqual(6);
  });
});
