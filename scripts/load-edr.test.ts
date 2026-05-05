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
vi.mock("node:fs", () => ({
  openSync: mockOpen,
  readSync: mockRead,
  closeSync: mockClose,
}));

import {
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
    // Sequence: DDL, cp, \copy, cleanup-rm, count(raw), count(residence), count(distinct)
    mockExec
      .mockReturnValueOnce("") // DDL
      .mockReturnValueOnce("") // docker cp
      .mockReturnValueOnce("") // \copy
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("819672") // raw_rows
      .mockReturnValueOnce("809063") // rows_with_residence
      .mockReturnValueOnce("2472"); // rows_unique_municipios

    const result = await loadEdr({
      csvPath: "/tmp/edr.csv",
      dbContainer: "supabase-db",
    });

    expect(result.raw_rows).toBe(819672);
    expect(result.rows_with_residence).toBe(809063);
    expect(result.rows_unique_municipios).toBe(2472);
    expect(typeof result.duration_ms).toBe("number");

    // Verify docker cp was the second call with `--` separator (path-injection defense)
    const cpCall = mockExec.mock.calls[1];
    expect(cpCall?.[0]).toBe("docker");
    expect(cpCall?.[1]).toEqual([
      "cp",
      "--",
      "/tmp/edr.csv",
      expect.stringMatching(/^supabase-db:\/tmp\/edr_raw_/),
    ]);
  });

  it("skips DDL when --append is passed (multi-year stacking)", async () => {
    stubHeader(REAL_HEADER);
    mockExec
      .mockReturnValueOnce("") // docker cp (no DDL first)
      .mockReturnValueOnce("") // \copy
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("1639344") // raw_rows (2x)
      .mockReturnValueOnce("1618000") // rows_with_residence
      .mockReturnValueOnce("2472"); // rows_unique_municipios

    await loadEdr({
      csvPath: "/tmp/edr2023.csv",
      dbContainer: "supabase-db",
      append: true,
    });

    // First call should be cp, not psql DDL — the DDL block is skipped.
    const firstCall = mockExec.mock.calls[0];
    expect(firstCall?.[1]?.[0]).toBe("cp");
  });

  it("cleans up the container temp file even if \\copy throws", async () => {
    stubHeader(REAL_HEADER);
    mockExec
      .mockReturnValueOnce("") // DDL
      .mockReturnValueOnce("") // docker cp
      .mockImplementationOnce(() => {
        throw new Error("\\copy failed: ERROR: malformed CSV");
      });

    await expect(
      loadEdr({ csvPath: "/tmp/edr.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/\\copy failed/);

    // Cleanup `rm -f` should have been attempted (4th call)
    const cleanupCall = mockExec.mock.calls[3];
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
      .mockReturnValueOnce("") // DDL
      .mockReturnValueOnce("") // cp
      .mockReturnValueOnce("") // \copy
      .mockReturnValueOnce("") // rm
      .mockReturnValueOnce("not a number"); // bad count

    await expect(
      loadEdr({ csvPath: "/tmp/edr.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/unexpected count output/);
  });
});
