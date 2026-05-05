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
  ENIGH_CONCENTRADOHOGAR_COLUMNS,
  ENIGH_RAW_DDL_FOR_TEST,
  calibratorsDdlForTest,
  expectEnighHeader,
  loadEnigh,
} from "./load-enigh.js";

beforeEach(() => {
  mockExec.mockReset();
  mockOpen.mockReset();
  mockRead.mockReset();
  mockClose.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const REAL_HEADER = ENIGH_CONCENTRADOHOGAR_COLUMNS.join(",");

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

describe("expectEnighHeader", () => {
  it("accepts the canonical 126-column ENIGH concentradohogar header", () => {
    expect(() => expectEnighHeader(REAL_HEADER)).not.toThrow();
  });

  it("strips the UTF-8 BOM before validating", () => {
    expect(() => expectEnighHeader(`﻿${REAL_HEADER}`)).not.toThrow();
  });

  it("rejects too few columns", () => {
    const truncated = ENIGH_CONCENTRADOHOGAR_COLUMNS.slice(0, 50).join(",");
    expect(() => expectEnighHeader(truncated)).toThrow(/expected 126 columns/);
  });

  it("rejects a misordered column at the same length", () => {
    const swapped = [...ENIGH_CONCENTRADOHOGAR_COLUMNS];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(() => expectEnighHeader(swapped.join(","))).toThrow(
      /column 1 mismatch/,
    );
  });
});

describe("ENIGH_RAW_DDL_FOR_TEST", () => {
  it("declares all 126 columns as TEXT", () => {
    for (const col of ENIGH_CONCENTRADOHOGAR_COLUMNS) {
      expect(ENIGH_RAW_DDL_FOR_TEST).toContain(`${col} TEXT`);
    }
  });

  it("indexes by entidad (LEFT(ubica_geo, 2))", () => {
    expect(ENIGH_RAW_DDL_FOR_TEST).toMatch(/idx_enigh_ubica_geo/);
    expect(ENIGH_RAW_DDL_FOR_TEST).toMatch(/LEFT\(ubica_geo, 2\)/);
  });

  it("uses DROP TABLE IF EXISTS for idempotent rerun", () => {
    expect(ENIGH_RAW_DDL_FOR_TEST).toMatch(/DROP TABLE IF EXISTS/);
  });
});

describe("calibratorsDdlForTest", () => {
  it("inlines the year as integer literal in DELETE + INSERT", () => {
    const sql = calibratorsDdlForTest(2024);
    expect(sql).toMatch(
      /DELETE FROM calibrators_enigh_state WHERE ano_levantamiento = 2024/,
    );
    expect(sql).toMatch(/2024\s+AS ano_levantamiento/);
  });

  it("uses CREATE TABLE IF NOT EXISTS so multi-wave loads stack", () => {
    const sql = calibratorsDdlForTest(2024);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS calibrators_enigh_state/);
  });

  it("filters parsed rows to valid Mexican entidades + non-zero factor", () => {
    const sql = calibratorsDdlForTest(2024);
    expect(sql).toMatch(
      /WHERE ubica_geo ~ '\^\(0\[1-9\]\|\[12\]\[0-9\]\|3\[0-2\]\)\[0-9\]\{3\}\$'/,
    );
    expect(sql).toMatch(/NULLIF\(factor, ''\)::numeric > 0/);
  });

  it("computes weighted percentile via cumulative-sum window function", () => {
    const sql = calibratorsDdlForTest(2024);
    expect(sql).toMatch(/SUM\(w\) OVER \(PARTITION BY entidad ORDER BY ing/);
    expect(sql).toMatch(/totw \* 0\.1/);
    expect(sql).toMatch(/totw \* 0\.5/);
    expect(sql).toMatch(/totw \* 0\.9/);
  });
});

describe("loadEnigh", () => {
  it("validates dbContainer regex before any docker call", async () => {
    stubHeader(REAL_HEADER);
    await expect(
      loadEnigh({
        csvPath: "/tmp/x.csv",
        dbContainer: "bad container",
        year: 2024,
      }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects a leading-dash csvPath (argument injection defense)", async () => {
    stubHeader(REAL_HEADER);
    await expect(
      loadEnigh({
        csvPath: "-rm -rf /",
        dbContainer: "supabase-db",
        year: 2024,
      }),
    ).rejects.toThrow(/csvPath inválido/);
  });

  it("rejects an out-of-range year", async () => {
    stubHeader(REAL_HEADER);
    await expect(
      loadEnigh({
        csvPath: "/tmp/x.csv",
        dbContainer: "supabase-db",
        year: 1850,
      }),
    ).rejects.toThrow(/year inválido/);
  });

  it("rejects a non-integer year", async () => {
    stubHeader(REAL_HEADER);
    await expect(
      loadEnigh({
        csvPath: "/tmp/x.csv",
        dbContainer: "supabase-db",
        year: 2024.5,
      }),
    ).rejects.toThrow(/year inválido/);
  });

  it("validates the CSV header before invoking docker", async () => {
    stubHeader("foo,bar,baz");
    await expect(
      loadEnigh({
        csvPath: "/tmp/x.csv",
        dbContainer: "supabase-db",
        year: 2024,
      }),
    ).rejects.toThrow(/expected 126 columns/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("orchestrates DDL → cp → \\copy → cleanup → calibrators DDL → counts", async () => {
    stubHeader(REAL_HEADER);
    mockExec
      .mockReturnValueOnce("") // raw DDL
      .mockReturnValueOnce("") // docker cp
      .mockReturnValueOnce("") // \copy
      .mockReturnValueOnce("") // rm cleanup
      .mockReturnValueOnce("") // calibrators DDL + INSERT
      .mockReturnValueOnce("91414") // raw_rows
      .mockReturnValueOnce("32"); // calibrators_rows

    const result = await loadEnigh({
      csvPath: "/tmp/enigh2024.csv",
      dbContainer: "supabase-db",
      year: 2024,
    });

    expect(result.raw_rows).toBe(91414);
    expect(result.calibrators_rows).toBe(32);
    expect(typeof result.duration_ms).toBe("number");

    // The cp call should use the `--` separator (path-injection defense).
    const cpCall = mockExec.mock.calls[1];
    expect(cpCall?.[1]).toEqual([
      "cp",
      "--",
      "/tmp/enigh2024.csv",
      expect.stringMatching(/^supabase-db:\/tmp\/enigh_raw_/),
    ]);
  });

  it("cleans up the container temp file even if \\copy throws", async () => {
    stubHeader(REAL_HEADER);
    mockExec
      .mockReturnValueOnce("") // raw DDL
      .mockReturnValueOnce("") // cp
      .mockImplementationOnce(() => {
        throw new Error("\\copy failed: ERROR: malformed CSV");
      });

    await expect(
      loadEnigh({
        csvPath: "/tmp/enigh.csv",
        dbContainer: "supabase-db",
        year: 2024,
      }),
    ).rejects.toThrow(/\\copy failed/);

    // 4th call should be rm cleanup
    const cleanupCall = mockExec.mock.calls[3];
    expect(cleanupCall?.[1]).toEqual([
      "exec",
      "supabase-db",
      "rm",
      "-f",
      expect.stringMatching(/^\/tmp\/enigh_raw_/),
    ]);
  });
});
