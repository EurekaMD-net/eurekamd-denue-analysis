import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mockExec }));

import {
  assertRelationsExist,
  CENSO_VIEWS,
  censoViewsSql,
  perfMatviewSql,
  postLoadGrants,
  refreshedMatviews,
  runPsqlScript,
} from "./_psql-tx.js";

const HERE = dirname(fileURLToPath(import.meta.url));

beforeEach(() => mockExec.mockReset());

describe("runPsqlScript", () => {
  it("pipes the script into ONE psql session: single transaction + ON_ERROR_STOP", () => {
    mockExec.mockReturnValue("");
    runPsqlScript("supabase-db", "SELECT 1;", 1000);
    const [bin, args, opts] = mockExec.mock.calls[0] as [
      string,
      string[],
      { input: string },
    ];
    expect(bin).toBe("docker");
    expect(args.slice(0, 3)).toEqual(["exec", "-i", "supabase-db"]);
    expect(args).toContain("--single-transaction");
    expect(args.join(" ")).toContain("-v ON_ERROR_STOP=1");
    expect(args.slice(-2)).toEqual(["-f", "-"]);
    expect(opts.input).toBe("SELECT 1;");
  });

  it("rejects an unsafe container name before calling docker", () => {
    expect(() => runPsqlScript("--rm", "SELECT 1;", 1000)).toThrow(
      /unsafe container/,
    );
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("refreshedMatviews", () => {
  it("parses every MV the nightly refresh sweeps", () => {
    const names = refreshedMatviews();
    for (const n of [
      "mv_national_treemap",
      "mv_sector_grade_matrix",
      "mv_delitos_municipal_yearly",
      "mv_mortalidad_municipal_yearly",
    ]) {
      expect(names).toContain(n);
    }
  });
});

describe("assertRelationsExist", () => {
  it("passes when to_regclass finds every relation", () => {
    mockExec.mockReturnValue("\n");
    expect(() => assertRelationsExist("supabase-db")).not.toThrow();
    const sql = (mockExec.mock.calls[0]?.[1] as string[]).at(-1) ?? "";
    expect(sql).toMatch(/to_regclass\(n\) IS NULL/);
    // Default list = refresh-matviews.sh MVs + the three censo views.
    for (const n of [...refreshedMatviews(), ...CENSO_VIEWS]) {
      expect(sql).toContain(`'${n}'`);
    }
  });

  it("throws naming every missing relation (loader exits non-zero)", () => {
    mockExec.mockReturnValue("censo_localidades\nmv_national_treemap\n");
    expect(() => assertRelationsExist("supabase-db")).toThrow(
      /missing after load: censo_localidades, mv_national_treemap/,
    );
  });

  it("refuses non-identifier names instead of inlining them", () => {
    expect(() => assertRelationsExist("supabase-db", ["x'); DROP"])).toThrow(
      /unsafe relation name/,
    );
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("perfMatviewSql", () => {
  it("returns exactly one MV section: its DROP, CREATE and indexes", () => {
    const sql = perfMatviewSql("mv_sector_grade_matrix");
    expect(sql.startsWith("DROP MATERIALIZED VIEW IF EXISTS mv_sector_grade_matrix;")).toBe(true);
    expect(sql).toMatch(/CREATE MATERIALIZED VIEW mv_sector_grade_matrix AS/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sgm_scian_irs/);
    expect(sql).not.toMatch(/mv_national_treemap/);
  });

  it("covers the last section of the file (EOF terminator)", () => {
    const sql = perfMatviewSql("mv_mortalidad_municipal_yearly");
    expect(sql).toMatch(/CREATE MATERIALIZED VIEW mv_mortalidad_municipal_yearly/);
    expect(sql).toMatch(/idx_mv_mmy_unique/);
  });

  it("throws for an MV the file does not define", () => {
    expect(() => perfMatviewSql("mv_nope")).toThrow(/not defined/);
  });
});

describe("censoViewsSql", () => {
  it("defines all three censo views (only migrate-censo-views.sql does)", () => {
    const sql = censoViewsSql();
    expect(sql).toMatch(/CREATE OR REPLACE VIEW censo_municipios AS/);
    expect(sql).toMatch(/CREATE VIEW censo_localidades AS/);
    expect(sql).toMatch(/CREATE OR REPLACE VIEW censo_entidades AS/);
  });
});

describe("postLoadGrants", () => {
  it("strips default privileges and restores the Sage SELECT only for allowlisted relations", () => {
    const sql = postLoadGrants(["coneval_irs_municipal", "coneval_irs_municipal_raw"]);
    expect(sql).toContain(
      "REVOKE ALL ON coneval_irs_municipal FROM anon, authenticated, trustr_app;",
    );
    expect(sql).toContain("GRANT SELECT ON coneval_irs_municipal TO denue_sage;");
    expect(sql).toContain(
      "REVOKE ALL ON coneval_irs_municipal_raw FROM anon, authenticated, trustr_app;",
    );
    // Raw tables are never on the Sage allowlist.
    expect(sql).not.toContain("GRANT SELECT ON coneval_irs_municipal_raw");
  });
});

describe("refresh-matviews.sh (audit #115)", () => {
  const sh = readFileSync(join(HERE, "refresh-matviews.sh"), "utf-8");

  it("runs psql with ON_ERROR_STOP so a failed REFRESH fails the unit", () => {
    expect(sh).toMatch(/docker exec -i "\$CONTAINER" psql -v ON_ERROR_STOP=1 /);
  });

  it("sets lock_timeout before the first REFRESH", () => {
    const lock = sh.indexOf("SET lock_timeout = '60s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(sh.indexOf("REFRESH MATERIALIZED VIEW"));
  });
});
