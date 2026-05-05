import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

import {
  listStateZips,
  readCe2024Header,
  POST_LOAD_SQL,
} from "./load-ce2024.js";

beforeEach(() => mockExec.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("listStateZips", () => {
  it("returns one entry per state zip, alphabetically sorted by state code", () => {
    mockExec.mockReturnValue(
      [
        "conjunto_de_datos_ce_jal_2024_csv.zip",
        "conjunto_de_datos_ce_ags_2024_csv.zip",
        "conjunto_de_datos_ce_cdmx_2024_csv.zip",
      ].join("\n"),
    );
    const zips = listStateZips("raw");
    expect(zips.map((z) => z.stateCode)).toEqual(["ags", "cdmx", "jal"]);
    expect(zips[0]?.zipPath).toBe("raw/conjunto_de_datos_ce_ags_2024_csv.zip");
  });

  it("silently skips the national rollup file (_nac_)", () => {
    mockExec.mockReturnValue(
      [
        "conjunto_de_datos_ce_nac_2024_csv.zip",
        "conjunto_de_datos_ce_ags_2024_csv.zip",
      ].join("\n"),
    );
    const zips = listStateZips("raw");
    expect(zips.map((z) => z.stateCode)).toEqual(["ags"]);
  });

  it("returns an empty list when nothing matches the pattern", () => {
    mockExec.mockReturnValue("");
    expect(listStateZips("raw")).toEqual([]);
  });

  it("ignores files that don't match the canonical filename pattern", () => {
    mockExec.mockReturnValue(
      [
        "conjunto_de_datos_ce_ags_2024_csv.zip",
        "ce2024_random_export.zip", // doesn't match → ignored
        "conjunto_de_datos_ce_jal_2024_csv.zip",
      ].join("\n"),
    );
    const zips = listStateZips("raw");
    expect(zips.map((z) => z.stateCode)).toEqual(["ags", "jal"]);
  });
});

describe("readCe2024Header", () => {
  it("returns lower-cased column names from the CSV's first line", () => {
    mockExec.mockReturnValue(
      "E03,E04,SECTOR,SUBSECTOR,RAMA,SUBRAMA,CLASE,ID_ESTRATO,CODIGO,UE,H001A,A111A\n",
    );
    const cols = readCe2024Header(
      "raw/x.zip",
      "conjunto_de_datos/tr_ce_x_2024.csv",
    );
    expect(cols).toEqual([
      "e03",
      "e04",
      "sector",
      "subsector",
      "rama",
      "subrama",
      "clase",
      "id_estrato",
      "codigo",
      "ue",
      "h001a",
      "a111a",
    ]);
  });

  it("rejects column names containing characters outside [a-z0-9_]", () => {
    mockExec.mockReturnValue("e03,e 04,sector\n"); // space
    expect(() => readCe2024Header("raw/x.zip", "tr_ce_x_2024.csv")).toThrow(
      /unsafe column name/,
    );
  });

  it("strips a leading BOM before splitting", () => {
    mockExec.mockReturnValue("﻿E03,E04\n");
    expect(readCe2024Header("raw/x.zip", "tr_ce_x_2024.csv")).toEqual([
      "e03",
      "e04",
    ]);
  });
});

describe("POST_LOAD_SQL — ce2024_municipal materialized view", () => {
  it("derives cve_mun by concatenating e03 and e04", () => {
    expect(POST_LOAD_SQL).toMatch(/\(e03 \|\| e04\)\s+AS cve_mun/);
  });

  it("filters to municipal rows only (E03 and E04 both populated)", () => {
    expect(POST_LOAD_SQL).toMatch(/WHERE e03 IS NOT NULL AND e03 != ''/);
    expect(POST_LOAD_SQL).toMatch(/AND e04 IS NOT NULL AND e04 != ''/);
  });

  it("guards every numeric cast with NULLIF(col, '')", () => {
    // High-signal columns the analytics endpoints depend on.
    const guarded = [
      "ue",
      "h001a",
      "j000a",
      "a111a",
      "a131a",
      "a700a",
      "a800a",
    ];
    for (const col of guarded) {
      const re = new RegExp(`NULLIF\\(${col}, ''\\)::(?:int|numeric)`);
      expect(POST_LOAD_SQL).toMatch(re);
    }
  });

  it("creates the indexes the analytics queries rely on", () => {
    expect(POST_LOAD_SQL).toMatch(
      /CREATE INDEX idx_ce2024_mun_cve ON ce2024_municipal \(cve_mun\)/,
    );
    expect(POST_LOAD_SQL).toMatch(
      /CREATE INDEX idx_ce2024_mun_sector ON ce2024_municipal \(sector\)/,
    );
    expect(POST_LOAD_SQL).toMatch(
      /CREATE INDEX idx_ce2024_mun_clase ON ce2024_municipal \(clase\)/,
    );
  });

  it("is idempotent — drops and recreates everything", () => {
    expect(POST_LOAD_SQL).toMatch(/DROP MATERIALIZED VIEW IF EXISTS/);
    expect(POST_LOAD_SQL).toMatch(/DROP INDEX IF EXISTS/);
  });
});
