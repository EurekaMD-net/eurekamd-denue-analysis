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

import { loadClues, POST_LOAD_SQL_FOR_TEST } from "./load-clues.js";

beforeEach(() => {
  mockExec.mockReset();
  mockOpen.mockReset();
  mockRead.mockReset();
  mockClose.mockReset();
});
afterEach(() => vi.restoreAllMocks());

/**
 * Stub fs.openSync/readSync/closeSync so loadClues can read the header line
 * without an actual filesystem. The header below matches the real CLUES
 * snake_case header from the openpyxl conversion (68 cols, but only the
 * required ones need to be present for the validator).
 */
function stubHeader(headerLine: string): void {
  mockOpen.mockReturnValue(7);
  mockRead.mockImplementation(
    (
      _fd: number,
      buf: Buffer,
      _offset: number,
      _length: number,
      _pos: number,
    ) => {
      const text = headerLine + "\n";
      buf.write(text, 0, "utf-8");
      return Buffer.byteLength(text, "utf-8");
    },
  );
  mockClose.mockReturnValue(undefined);
}

const VALID_CLUES_HEADER = [
  "clues",
  "clave_de_la_institucion",
  "nombre_de_la_institucion",
  "clave_de_la_entidad",
  "entidad",
  "clave_del_municipio",
  "municipio",
  "clave_de_la_localidad",
  "localidad",
  "estatus_de_operacion",
  "clave_nivel_atencion",
  "nivel_atencion",
  "latitud",
  "longitud",
].join(",");

describe("loadClues (orchestration)", () => {
  it("rejects malformed dbContainer (anti docker-flag injection)", async () => {
    await expect(
      loadClues({ csvPath: "/c.csv", dbContainer: "--rm" }),
    ).rejects.toThrow(/dbContainer inválido/);
    await expect(
      loadClues({ csvPath: "/c.csv", dbContainer: "" }),
    ).rejects.toThrow(/dbContainer inválido/);
    await expect(
      loadClues({ csvPath: "/c.csv", dbContainer: "-evil" }),
    ).rejects.toThrow(/dbContainer inválido/);
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("rejects csvPath beginning with '-'", async () => {
    await expect(
      loadClues({ csvPath: "--rm-volumes", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/csvPath inválido/);
    await expect(
      loadClues({ csvPath: "", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/csvPath inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects unsafe column names in CSV header", async () => {
    stubHeader(
      "clues,clave_de_la_entidad,clave_del_municipio,clave_de_la_localidad,estatus_de_operacion,clave_nivel_atencion,latitud,longitud,bad name with spaces",
    );
    await expect(
      loadClues({ csvPath: "/c.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/unsafe column name/);
  });

  it("rejects header missing required column", async () => {
    stubHeader(
      "clues,clave_de_la_entidad,clave_del_municipio,estatus_de_operacion,latitud,longitud",
    );
    await expect(
      loadClues({ csvPath: "/c.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/missing required column "clave_de_la_localidad"/);
  });

  it("passes csvPath positionally with `--` separator to docker cp", async () => {
    stubHeader(VALID_CLUES_HEADER);
    mockExec
      .mockReturnValueOnce("DROP TABLE\nCREATE TABLE\n") // DDL
      .mockReturnValueOnce("") // docker cp
      .mockReturnValueOnce("COPY 63708\n") // \copy
      .mockReturnValueOnce("") // rm
      .mockReturnValueOnce("CREATE MATERIALIZED VIEW\n") // post-load
      .mockReturnValueOnce("63708\n") // count raw
      .mockReturnValueOnce("41381\n") // count clues (EN OPERACION)
      .mockReturnValueOnce("41200\n"); // count with geom

    const result = await loadClues({
      csvPath: "/data/clues.csv",
      dbContainer: "supabase-db",
    });
    expect(result.raw_rows).toBe(63708);
    expect(result.clues_rows).toBe(41381);
    expect(result.clues_with_geom).toBe(41200);

    const cpCalls = mockExec.mock.calls.filter((c) => {
      const args = c[1] as string[];
      return Array.isArray(args) && args[0] === "cp";
    });
    expect(cpCalls.length).toBe(1);
    const cpArgs = cpCalls[0][1] as string[];
    expect(cpArgs[0]).toBe("cp");
    expect(cpArgs[1]).toBe("--"); // flag-injection defense
    expect(cpArgs[2]).toBe("/data/clues.csv");

    // S1: confirm the post-load step was actually invoked with the
    // exported SQL constant. Catches refactors that drop the view step
    // or wire it to a different SQL string.
    const postLoadCalled = mockExec.mock.calls.some((c) => {
      const args = c[1] as string[];
      return (
        Array.isArray(args) &&
        args.includes("-c") &&
        args.includes(POST_LOAD_SQL_FOR_TEST)
      );
    });
    expect(postLoadCalled).toBe(true);
  });

  it("guards every numeric cast against empty string", () => {
    // CLUES ships ungeocoded rows with latitud/longitud=''. Casting '' to
    // numeric blows up. Same defense pattern as the coneval n.d guard.
    const sql = POST_LOAD_SQL_FOR_TEST;
    expect(sql).toMatch(/NULLIF\(latitud, ''\)::numeric/);
    expect(sql).toMatch(/NULLIF\(longitud, ''\)::numeric/);
    expect(sql).toMatch(/NULLIF\(clave_nivel_atencion, ''\)::int/);
  });

  it("filters to EN OPERACION units in the canonical view", () => {
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /WHERE estatus_de_operacion = 'EN OPERACION'/,
    );
  });

  it("creates GIST index on geom for spatial joins", () => {
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /CREATE INDEX idx_clues_geom ON clues USING GIST \(geom\)/,
    );
  });

  it("creates btree on cve_mun + cve_loc for join speed", () => {
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /CREATE INDEX idx_clues_cve_mun ON clues \(cve_mun\)/,
    );
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /CREATE INDEX idx_clues_cve_loc ON clues \(cve_loc\)/,
    );
  });

  it("derives cve_mun and cve_loc by concatenation, not LPAD", () => {
    // CLUES already ships zero-padded clave_de_la_entidad (2-char) and
    // clave_del_municipio (3-char), so plain || concatenation works.
    // (LPAD would be a code smell suggesting we don't trust the input width.)
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(
      /\(clave_de_la_entidad \|\| clave_del_municipio\)\s+AS cve_mun/,
    );
  });

  it("uses MATERIALIZED VIEW (not regular VIEW) so GIST is buildable", () => {
    // GIST indexes can't be built on regular views — only on tables and
    // materialized views. This test pins the choice.
    expect(POST_LOAD_SQL_FOR_TEST).toMatch(/CREATE MATERIALIZED VIEW clues/);
  });

  it("cleans up in-container temp file even when \\copy fails", async () => {
    stubHeader(VALID_CLUES_HEADER);
    let copyAttempted = false;
    mockExec.mockImplementation((_bin: string, args: string[]) => {
      if (args.some((a) => typeof a === "string" && a.includes("\\copy"))) {
        copyAttempted = true;
        const e = new Error("psql copy failed");
        throw e;
      }
      return "";
    });
    await expect(
      loadClues({ csvPath: "/c.csv", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/psql copy failed/);
    expect(copyAttempted).toBe(true);

    // S2: tighter assertion — rm must reference the canonical container
    // path, not just be called. Catches refactors that drop the path arg.
    const rmCalls = mockExec.mock.calls.filter((c) => {
      const args = c[1] as string[];
      return (
        Array.isArray(args) &&
        args.includes("rm") &&
        args.includes("/tmp/clues_raw.csv")
      );
    });
    expect(rmCalls.length).toBeGreaterThanOrEqual(1);
  });
});
