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

import { buildCensoCreateTable, loadCenso } from "./load-censo.js";

beforeEach(() => {
  mockExec.mockReset();
  mockOpen.mockReset();
  mockRead.mockReset();
  mockClose.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("buildCensoCreateTable", () => {
  it("emits CREATE TABLE with all columns as TEXT, lowercased + quoted", () => {
    const header = "ENTIDAD,NOM_ENT,MUN,NOM_MUN,LOC,NOM_LOC,POBTOT";
    const sql = buildCensoCreateTable(header);
    expect(sql).toMatch(/DROP TABLE IF EXISTS censo_iter CASCADE/);
    expect(sql).toMatch(/CREATE TABLE censo_iter/);
    // Quoted identifiers — defends against future ITER releases with
    // reserved-word column names.
    expect(sql).toMatch(/"entidad" TEXT/);
    expect(sql).toMatch(/"pobtot" TEXT/);
    expect(sql).not.toMatch(/POBTOT/); // lowercased
  });

  it("strips BOM from the first column name", () => {
    const header = "﻿ENTIDAD,NOM_ENT,MUN,NOM_MUN,LOC";
    const sql = buildCensoCreateTable(header);
    expect(sql).toMatch(/"entidad" TEXT/);
    // No invisible char leaks into the column name
    expect(sql).not.toContain("﻿");
  });

  it("rejects unsafe column names (defense-in-depth vs malformed CSV)", () => {
    expect(() =>
      buildCensoCreateTable("ENTIDAD,NOM_ENT,MUN,LOC,bad name"),
    ).toThrow(/unsafe column name/);
    expect(() =>
      buildCensoCreateTable("ENTIDAD,NOM_ENT,MUN,LOC,1starts_with_digit"),
    ).toThrow(/unsafe column name/);
    expect(() =>
      buildCensoCreateTable("ENTIDAD,NOM_ENT,MUN,LOC,DROP TABLE x"),
    ).toThrow(/unsafe column name/);
    expect(() =>
      buildCensoCreateTable("ENTIDAD,NOM_ENT,MUN,LOC,col-with-dash"),
    ).toThrow(/unsafe column name/);
  });

  it("rejects too-short headers", () => {
    expect(() => buildCensoCreateTable("a,b,c")).toThrow(/expected ≥5 columns/);
  });

  it("rejects headers missing required join columns", () => {
    expect(() => buildCensoCreateTable("FOO,BAR,BAZ,QUX,QUUX")).toThrow(
      /missing required columns/,
    );
  });

  it("accepts the real INEGI ITER 286-column header (sample)", () => {
    // Synthetic 6-column subset of the real header — same pattern, valid identifiers.
    const header =
      "ENTIDAD,NOM_ENT,MUN,NOM_MUN,LOC,NOM_LOC,LONGITUD,LATITUD,ALTITUD,POBTOT";
    expect(() => buildCensoCreateTable(header)).not.toThrow();
  });
});

describe("loadCenso (orchestration)", () => {
  // Helper: stub fs to return a minimal CSV header line.
  function stubHeader(line: string): void {
    mockOpen.mockReturnValue(7);
    mockRead.mockImplementation(
      (
        _fd: number,
        buf: Buffer,
        _offset: number,
        _length: number,
        _pos: number,
      ) => {
        const text = line + "\n";
        buf.write(text, 0, "utf-8");
        return Buffer.byteLength(text, "utf-8");
      },
    );
    mockClose.mockReturnValue(undefined);
  }

  it("rejects malformed dbContainer (anti docker-flag injection)", async () => {
    await expect(
      loadCenso({ csvPath: "/tmp/x.csv", dbContainer: "--rm" }),
    ).rejects.toThrow(/dbContainer inválido/);
    await expect(
      loadCenso({ csvPath: "/tmp/x.csv", dbContainer: "" }),
    ).rejects.toThrow(/dbContainer inválido/);
    await expect(
      loadCenso({ csvPath: "/tmp/x.csv", dbContainer: "name with spaces" }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects csvPath beginning with '-' (anti docker-cp flag injection)", async () => {
    await expect(
      loadCenso({ csvPath: "--rm-volumes", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/csvPath inválido/);
    await expect(
      loadCenso({ csvPath: "", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/csvPath inválido/);
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("passes csvPath positionally with `--` separator to docker cp", async () => {
    stubHeader("ENTIDAD,NOM_ENT,MUN,LOC,POBTOT");
    // Subsequent execFileSync calls return canned values
    mockExec
      .mockReturnValueOnce("DROP TABLE\nCREATE TABLE\n") // create
      .mockReturnValueOnce("") // docker cp
      .mockReturnValueOnce("COPY 195662\n") // \copy
      .mockReturnValueOnce("") // rm /tmp/iter.csv
      .mockReturnValueOnce("ALTER TABLE\nCREATE INDEX\n") // post-load
      .mockReturnValueOnce("195662\n") // count censo_iter
      .mockReturnValueOnce("2469\n"); // count censo_municipios

    const result = await loadCenso({
      csvPath: "/tmp/iter.csv",
      dbContainer: "supabase-db",
    });
    expect(result.rows_loaded).toBe(195662);
    expect(result.municipios_count).toBe(2469);

    // Find the docker-cp invocation
    const cpCall = mockExec.mock.calls.find((c) => {
      const args = c[1] as string[];
      return Array.isArray(args) && args[0] === "cp";
    });
    expect(cpCall).toBeDefined();
    const cpArgs = cpCall?.[1] as string[];
    // ["cp", "--", csvPath, "container:/tmp/iter.csv"]
    expect(cpArgs[0]).toBe("cp");
    expect(cpArgs[1]).toBe("--");
    expect(cpArgs[2]).toBe("/tmp/iter.csv");
    expect(cpArgs[3]).toBe("supabase-db:/tmp/iter.csv");
  });

  it("cleans up the in-container temp file even when \\copy fails", async () => {
    stubHeader("ENTIDAD,NOM_ENT,MUN,LOC,POBTOT");
    mockExec.mockImplementation((_bin: string, args: string[]) => {
      // create succeeds, cp succeeds, \copy throws, rm should still run
      if (
        args.includes("FROM '/tmp/iter.csv'") ||
        args.some((a) => a.includes("\\copy"))
      ) {
        throw new Error("psql copy failed");
      }
      return "";
    });
    await expect(
      loadCenso({ csvPath: "/tmp/iter.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/psql copy failed/);

    // Verify a `rm /tmp/iter.csv` call was made despite the failure
    const rmCall = mockExec.mock.calls.find((c) => {
      const args = c[1] as string[];
      return (
        Array.isArray(args) &&
        args.includes("rm") &&
        args.includes("/tmp/iter.csv")
      );
    });
    expect(rmCall).toBeDefined();
  });
});
