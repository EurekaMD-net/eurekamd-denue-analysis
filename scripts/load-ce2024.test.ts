import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

import {
  buildCe2024SwapSql,
  listStateZips,
  loadCe2024,
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

describe("loadCe2024 reload (audit #145)", () => {
  const HEADER =
    "E03,E04,SECTOR,SUBSECTOR,RAMA,SUBRAMA,CLASE,ID_ESTRATO,CODIGO,UE,H001A,A111A,A131A,A700A,A800A,J000A";

  it("buildCe2024SwapSql drops the MV explicitly, swaps staging in, rebuilds, grants", () => {
    const sql = buildCe2024SwapSql();
    const dropMv = sql.indexOf("DROP MATERIALIZED VIEW IF EXISTS ce2024_municipal;");
    const dropRaw = sql.indexOf("DROP TABLE IF EXISTS ce2024_raw;");
    const swap = sql.indexOf("ALTER TABLE ce2024_raw_staging RENAME TO ce2024_raw;");
    const rebuild = sql.indexOf("CREATE MATERIALIZED VIEW ce2024_municipal AS");
    expect(dropMv).toBe(0);
    expect(dropMv).toBeLessThan(dropRaw);
    expect(dropRaw).toBeLessThan(swap);
    expect(swap).toBeLessThan(rebuild);
    expect(sql).not.toMatch(/DROP TABLE[^;]*CASCADE/);
    expect(sql).toContain("GRANT SELECT ON ce2024_municipal TO denue_sage;");
  });

  function route(failCopyFor?: string, bcHeader = HEADER) {
    mockExec.mockImplementation(
      (bin: string, args: string[]) => {
        // beforeEach returns mockExec, which vitest then calls bare as a cleanup hook.
        if (!Array.isArray(args)) return "";
        if (bin === "/bin/sh" && args[1]?.startsWith("cd ")) {
          return "conjunto_de_datos_ce_ags_2024_csv.zip\nconjunto_de_datos_ce_bc_2024_csv.zip\n";
        }
        if (bin === "/bin/sh" && args[1]?.includes("head -1")) {
          return `${args.some((a) => a.includes("_bc_")) ? bcHeader : HEADER}\n`;
        }
        if (bin === "/bin/sh") return `${HEADER}\n1,001,31,311\n`;
        const joined = args.join(" ");
        if (failCopyFor && joined.includes(`\\copy`) && joined.includes(failCopyFor)) {
          throw new Error(`copy failed for ${failCopyFor}`);
        }
        if (joined.includes("SELECT COUNT(*)")) return "42\n";
        return "";
      },
    );
  }

  it("\\copies every state into staging, then swaps in ONE single-transaction session", async () => {
    route();
    const r = await loadCe2024({ zipDir: "raw", dbContainer: "supabase-db" });
    expect(r.states_loaded).toBe(2);
    const calls = mockExec.mock.calls as Array<[string, string[], { input?: string }]>;
    const copies = calls.filter((c) => c[1].join(" ").includes("\\copy"));
    expect(copies).toHaveLength(2);
    for (const c of copies) expect(c[1].join(" ")).toContain("\\copy ce2024_raw_staging FROM");
    const txs = calls.filter((c) => c[1].includes("--single-transaction"));
    expect(txs).toHaveLength(2); // staging DDL, then the swap
    expect(txs[0]?.[2].input).toContain("CREATE TABLE ce2024_raw_staging (");
    expect(txs[1]?.[2].input).toBe(buildCe2024SwapSql());
    // The swap is issued only after the last state's \\copy.
    expect(calls.indexOf(txs[1]!)).toBeGreaterThan(calls.indexOf(copies[1]!));
    // Nothing ever touches the live table outside the swap transaction.
    for (const c of calls) {
      if (c === txs[1]) continue;
      expect(`${c[1].join(" ")} ${c[2]?.input ?? ""}`).not.toMatch(/DROP (TABLE|MATERIALIZED VIEW) IF EXISTS ce2024_(raw|municipal)\b(?!_)/);
    }
  });

  it("rejects a state whose header has the same count but a different column order (audit #152)", async () => {
    // Same 16 columns, A111A and A131A swapped: positional \copy would load
    // one into the other silently.
    route(undefined, HEADER.replace("A111A,A131A", "A131A,A111A"));
    await expect(
      loadCe2024({ zipDir: "raw", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/bc header differs from ags/);
    const calls = mockExec.mock.calls as Array<[string, string[], { input?: string }]>;
    expect(calls.filter((c) => c[1].join(" ").includes("\\copy"))).toHaveLength(1);
    expect(calls.filter((c) => c[2]?.input?.includes("RENAME TO ce2024_raw;"))).toHaveLength(0);
  });

  it("a failed state copy never reaches the swap (live tables untouched)", async () => {
    route("/tmp/ce2024_bc.csv");
    await expect(
      loadCe2024({ zipDir: "raw", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/copy failed/);
    const calls = mockExec.mock.calls as Array<[string, string[], { input?: string }]>;
    const swaps = calls.filter((c) => c[2]?.input?.includes("RENAME TO ce2024_raw;"));
    expect(swaps).toHaveLength(0);
  });
});
