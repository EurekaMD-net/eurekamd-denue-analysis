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
  copyFromStdinScript,
  existingRowCount,
  perfMatviewSql,
  postLoadGrants,
  refreshedMatviews,
  runPsqlScript,
  swapInStagingSql,
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

describe("runPsqlScript with a Buffer script", () => {
  it("pipes the bytes unchanged (inline \\copy data survives)", () => {
    mockExec.mockReturnValue("");
    const buf = Buffer.from("TRUNCATE t;\n\\copy t FROM STDIN\nñ,1\n\\.\n");
    runPsqlScript("supabase-db", buf, 1000);
    expect((mockExec.mock.calls[0]?.[2] as { input: Buffer }).input).toBe(buf);
  });
});

describe("copyFromStdinScript (audit #146)", () => {
  const CMD = "\\copy t (a, b) FROM STDIN WITH (FORMAT csv, HEADER true)";

  it("prelude, then the \\copy line, then the CSV bytes, then the \\. marker", () => {
    const out = copyFromStdinScript(
      "TRUNCATE TABLE t;",
      CMD,
      Buffer.from("a,b\n1,ñ\n"),
    ).toString("utf-8");
    expect(out).toBe(`TRUNCATE TABLE t;\n${CMD}\na,b\n1,ñ\n\\.\n`);
  });

  it("puts \\. on its own line when the CSV lacks a trailing newline", () => {
    const out = copyFromStdinScript("", CMD, Buffer.from("a,b\n1,2")).toString(
      "utf-8",
    );
    expect(out.endsWith("1,2\n\\.\n")).toBe(true);
  });

  it("ends CRLF data with a CRLF \\. marker (a bare \\.\\n fails: unquoted newline found in data)", () => {
    const out = copyFromStdinScript("", CMD, Buffer.from("a,b\r\n1,2\r\n")).toString(
      "utf-8",
    );
    expect(out.endsWith("1,2\r\n\\.\r\n")).toBe(true);
    const noTrail = copyFromStdinScript("", CMD, Buffer.from("a,b\r\n1,2")).toString(
      "utf-8",
    );
    expect(noTrail.endsWith("1,2\r\n\\.\r\n")).toBe(true);
  });

  it("keeps the CSV bytes verbatim (no re-encoding)", () => {
    const csv = Buffer.from([0x61, 0x0a, 0xf1, 0x0a]); // Latin-1 ñ stays one byte
    const out = copyFromStdinScript("", CMD, csv);
    expect(out.subarray(out.length - csv.length - 3, out.length - 3)).toEqual(csv);
  });

  it("rejects a copy command that is not a one-line \\copy ... FROM STDIN", () => {
    expect(() =>
      copyFromStdinScript("", "\\copy t FROM '/tmp/x.csv'", Buffer.from("")),
    ).toThrow(/FROM STDIN/);
    expect(() =>
      copyFromStdinScript("", `${CMD}\nDROP TABLE t;`, Buffer.from("")),
    ).toThrow(/one-line/);
  });
});

describe("existingRowCount (audit #157)", () => {
  function route(regclass: string, count: string | Error): void {
    mockExec.mockImplementation((_bin: string, args: string[]) => {
      if (!Array.isArray(args)) return "";
      const sql = args[args.length - 1] ?? "";
      if (sql.includes("to_regclass")) return `${regclass}\n`;
      if (count instanceof Error) throw count;
      return `${count}\n`;
    });
  }

  it("returns 0 only when to_regclass reports the relation absent", () => {
    route("f", "999");
    expect(existingRowCount("supabase-db", "t_raw")).toBe(0);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("returns the COUNT when the relation exists", () => {
    route("t", "1500000");
    expect(existingRowCount("supabase-db", "t_raw")).toBe(1_500_000);
    const sqls = mockExec.mock.calls.map((c) => (c[1] as string[]).at(-1));
    expect(sqls).toEqual([
      "SELECT to_regclass('t_raw') IS NOT NULL;",
      "SELECT COUNT(*) FROM t_raw;",
    ]);
  });

  it("rethrows a failed COUNT instead of reporting an empty table", () => {
    route("t", new Error("canceling statement due to lock timeout"));
    expect(() => existingRowCount("supabase-db", "t_raw")).toThrow(/lock timeout/);
  });

  it("rethrows a failed probe and rejects unexpected probe output", () => {
    mockExec.mockImplementation(() => {
      throw new Error("Error response from daemon: No such container");
    });
    expect(() => existingRowCount("supabase-db", "t_raw")).toThrow(/No such container/);
    route("", "0");
    expect(() => existingRowCount("supabase-db", "t_raw")).toThrow(
      /unexpected to_regclass output/,
    );
    route("t", "");
    expect(() => existingRowCount("supabase-db", "t_raw")).toThrow(
      /unexpected COUNT output/,
    );
  });

  it("refuses unsafe identifiers and containers before calling docker", () => {
    expect(() => existingRowCount("supabase-db", "t; DROP")).toThrow(/unsafe relation/);
    expect(() => existingRowCount("--rm", "t_raw")).toThrow();
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("swapInStagingSql (audit #145)", () => {
  it("drops the listed dependents, then the live table, then renames staging", () => {
    expect(
      swapInStagingSql("t_raw", ["DROP VIEW IF EXISTS v2;", "DROP VIEW IF EXISTS v1;"]),
    ).toBe(
      "DROP VIEW IF EXISTS v2;\nDROP VIEW IF EXISTS v1;\n" +
        "DROP TABLE IF EXISTS t_raw;\nALTER TABLE t_raw_staging RENAME TO t_raw;",
    );
  });

  it("never uses CASCADE and refuses unsafe table names", () => {
    expect(swapInStagingSql("t_raw", [])).not.toMatch(/CASCADE/);
    expect(() => swapInStagingSql("t raw", [])).toThrow(/unsafe relation/);
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
    // EDR sentinel 9999 = "año no especificado" (recon 2026-09-27).
    expect(sql).toContain("AND anio_ocur <> '9999'");
  });

  it("throws for an MV the file does not define", () => {
    expect(() => perfMatviewSql("mv_nope")).toThrow(/not defined/);
  });
});

describe("censoViewsSql", () => {
  it("defines all three censo views (only migrate-censo-views.sql does)", () => {
    const sql = censoViewsSql();
    expect(sql).toMatch(/CREATE OR REPLACE VIEW censo_municipios AS/);
    expect(sql).toMatch(/CREATE OR REPLACE VIEW censo_localidades AS/);
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
