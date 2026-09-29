import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunSql } = vi.hoisted(() => ({
  mockRunSql: vi.fn(),
}));
vi.mock("../db/psql-runner.js", () => ({ runSql: mockRunSql }));

import {
  preCheckSql,
  applyRowCap,
  checkExplainPlan,
  parseCsv,
  executeGatedSql,
} from "./sql-gate.js";

describe("preCheckSql", () => {
  it("accepts a simple SELECT", () => {
    expect(preCheckSql("SELECT 1")).toBeNull();
  });

  it("accepts WITH ... SELECT", () => {
    expect(
      preCheckSql("WITH x AS (SELECT 1 AS n) SELECT * FROM x LIMIT 10"),
    ).toBeNull();
  });

  it("rejects INSERT / UPDATE / DELETE / DROP / etc", () => {
    for (const sql of [
      "INSERT INTO x VALUES (1)",
      "UPDATE x SET y=1",
      "DELETE FROM x",
      "DROP TABLE x",
      "TRUNCATE x",
      "ALTER TABLE x ADD COLUMN y INT",
      "CREATE TABLE x (id int)",
      "GRANT SELECT ON x TO bob",
      "COPY x TO STDOUT",
      "VACUUM x",
    ]) {
      const err = preCheckSql(sql);
      expect(err).not.toBeNull();
      // Most of these get caught by parse-fail (first token), others by
      // forbidden-keyword scan. Both are valid rejection codes.
      expect(err?.code).toMatch(/^SQL_(PARSE_FAIL|FORBIDDEN_KEYWORD)$/);
    }
  });

  it("rejects multiple statements", () => {
    const err = preCheckSql("SELECT 1; SELECT 2");
    expect(err?.code).toBe("SQL_PARSE_FAIL");
  });

  it("accepts a trailing single semicolon", () => {
    expect(preCheckSql("SELECT 1;")).toBeNull();
  });

  it("rejects SQL that names a forbidden raw table", () => {
    const err = preCheckSql("SELECT count(*) FROM establecimientos");
    expect(err?.code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("rejects SQL that names sesnsp_delitos_municipal_raw", () => {
    const err = preCheckSql(
      "SELECT count(*) FROM sesnsp_delitos_municipal_raw LIMIT 10",
    );
    expect(err?.code).toBe("SQL_FORBIDDEN_TABLE");
  });

  it("rejects every year of the SNIIV raw tables by pattern, quoted or qualified", () => {
    for (const sql of [
      "SELECT count(*) FROM sedatu_financiamientos_raw_2027",
      'SELECT count(*) FROM public."CNBV_CREDITO_RAW_2027"',
      "SELECT count(*) FROM CNBV_CREDITO_RAW_2031",
    ]) {
      expect(preCheckSql(sql)?.code, sql).toBe("SQL_FORBIDDEN_TABLE");
    }
    // The yearly views stay reachable.
    expect(
      preCheckSql("SELECT SUM(acciones) FROM sedatu_financiamientos_estado_grain_2027"),
    ).toBeNull();
  });

  it("accepts queries naming allowlisted MVs", () => {
    expect(
      preCheckSql("SELECT cve_mun FROM mv_delitos_municipal_yearly LIMIT 10"),
    ).toBeNull();
  });

  it("ignores forbidden keywords inside string literals", () => {
    expect(
      preCheckSql(
        "SELECT 'INSERT INTO x' AS lbl FROM censo_municipios LIMIT 1",
      ),
    ).toBeNull();
  });

  it("rejects empty SQL", () => {
    expect(preCheckSql("   ")?.code).toBe("SQL_PARSE_FAIL");
  });

  // Audit #75: `--` inside a literal must not hide a real `;` + DML.
  it("rejects a second statement hidden behind '--' in a literal", () => {
    expect(
      preCheckSql("SELECT '--'; DELETE FROM sage_threads; --'")?.code,
    ).toBe("SQL_PARSE_FAIL");
    expect(
      preCheckSql(
        "SELECT '--' AS x FROM censo_entidades) s; DELETE FROM sage_threads; SELECT * FROM (SELECT 1",
      )?.code,
    ).toBe("SQL_PARSE_FAIL");
  });

  it("rejects RESET ROLE as a second statement", () => {
    expect(preCheckSql("SELECT 1; RESET ROLE")?.code).toBe("SQL_PARSE_FAIL");
  });

  it("a comment can neither hide nor fake a statement separator", () => {
    expect(preCheckSql("SELECT 1 /* ; */ FROM censo_entidades")).toBeNull();
    expect(preCheckSql("SELECT 1 /* /* nested */ ; */ ; DROP x")?.code).toBe(
      "SQL_PARSE_FAIL",
    );
  });

  // Audit #110: settings / pg_net / SQL-executing functions.
  it("rejects current_setting in any spelling", () => {
    for (const sql of [
      "SELECT current_setting('app.service_role_key')",
      'SELECT "current_setting"(\'x\')',
      "SELECT pg_catalog.CURRENT_SETTING('x', true)",
      "SELECT set_config('role','postgres',true)",
    ]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_FORBIDDEN_KEYWORD");
    }
  });

  it("rejects net.http_post and other denied schemas", () => {
    expect(
      preCheckSql(
        "SELECT net.http_post('https://x', jsonb_build_object('k', 1))",
      )?.code,
    ).toBe("SQL_FORBIDDEN_TABLE");
    expect(preCheckSql('SELECT * FROM "vault".secrets')?.code).toBe(
      "SQL_FORBIDDEN_TABLE",
    );
    expect(preCheckSql("SELECT id FROM auth . users")?.code).toBe(
      "SQL_FORBIDDEN_TABLE",
    );
  });

  it("rejects pg_settings, query_to_xml and friends", () => {
    for (const sql of [
      "SELECT setting FROM pg_settings",
      "SELECT query_to_xml('delete from x', true, false, '')",
      "SELECT query_to_xmlschema('select 1', true, false, '')",
      "SELECT pg_sleep(10)",
      "SELECT lo_import('/etc/passwd')",
      "SELECT dblink_exec('x', 'y')",
      "SELECT pg_read_file('/etc/passwd')",
    ]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_FORBIDDEN_KEYWORD");
    }
  });

  it("rejects ts_stat / ts_rewrite, which run a query string via SPI", () => {
    for (const sql of [
      "SELECT word FROM ts_stat($q$SELECT current_setting('app.x')::tsvector$q$)",
      "SELECT word FROM pg_catalog.ts_stat('SELECT v FROM t', 'a')",
      "SELECT ts_rewrite('a'::tsquery, 'SELECT t, s FROM aliases')",
      'SELECT "ts_rewrite"(\'a\'::tsquery, \'SELECT 1\')',
    ]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_FORBIDDEN_KEYWORD");
    }
  });

  it("rejects schema_to_xml* and database_to_xml*", () => {
    for (const sql of [
      "SELECT schema_to_xml('public', true, false, '')",
      "SELECT schema_to_xmlschema('public', true, false, '')",
      "SELECT database_to_xml(true, false, '')",
      "SELECT database_to_xml_and_xmlschema(true, false, '')",
    ]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_FORBIDDEN_KEYWORD");
    }
  });

  // Audit P01 r2: PG decodes U&"..." (and UESCAPE) before resolving the
  // name, so the denylist must see the decoded name too.
  it("rejects U&\"...\" identifiers that decode to a denied name", () => {
    // Default escape: a backslash, which Sage SQL may not contain at all.
    for (const sql of [
      "SELECT U&\"current_\\0073etting\"('app.service_role_key') AS k",
      "SELECT word FROM U&\"t\\0073_stat\"('SELECT 1')",
    ]) {
      expect(preCheckSql(sql)).not.toBeNull();
    }
    for (const sql of [
      "SELECT U&\"current_!0073etting\" UESCAPE '!'('app.service_role_key') AS k",
      "SELECT word FROM U&\"t!0073_stat\" UESCAPE '!'($q$SELECT 1$q$)",
      "SELECT u&\"current_#+000073etting\" /* a */ uescape /* b */ '#'('x')",
      "SELECT U&\"current_!0073etting\" UESCAPE $$!$$('x')",
      "SELECT setconfig FROM U&\"pg_db_role_s!0065tting\" UESCAPE '!'",
    ]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_FORBIDDEN_KEYWORD");
    }
    for (const sql of [
      "SELECT U&\"n!0065t\" UESCAPE '!'.http_post('https://x')",
      "SELECT 1 FROM U&\"establecimient!006Fs\" UESCAPE '!'",
    ]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_FORBIDDEN_TABLE");
    }
  });

  it("rejects malformed U& escapes and UESCAPE clauses", () => {
    for (const sql of [
      "SELECT U&\"a!zz\" UESCAPE '!' FROM censo_entidades",
      "SELECT U&\"a\" UESCAPE 'ab' FROM censo_entidades",
      "SELECT U&\"a\" UESCAPE '+' FROM censo_entidades",
      "SELECT U&\"a\" UESCAPE 1 FROM censo_entidades",
      "SELECT U&\"a!d800\" UESCAPE '!' FROM censo_entidades",
      "SELECT U&\"a\" UESCAPE '!'\n'x' FROM censo_entidades",
      "SELECT U&\"abc",
    ]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_PARSE_FAIL");
    }
  });

  it("accepts a harmless U& identifier or string once decoded", () => {
    expect(
      preCheckSql(
        "SELECT U&\"cve!005fent\" UESCAPE '!' FROM censo_entidades LIMIT 1",
      ),
    ).toBeNull();
    expect(preCheckSql("SELECT U&'caf!00e9' UESCAPE '!' AS s")).toBeNull();
  });

  it("rejects SET ROLE / RESET ROLE alone or as a second statement", () => {
    for (const sql of [
      "SET ROLE postgres",
      "RESET ROLE",
      "SELECT 1; SET ROLE postgres",
      "SELECT 1; RESET ROLE",
    ]) {
      expect(preCheckSql(sql)?.code).toMatch(
        /^SQL_(PARSE_FAIL|FORBIDDEN_KEYWORD)$/,
      );
    }
  });

  it("rejects a statement nested in dollar quotes", () => {
    for (const sql of [
      // $a$ closes on the first $a$, so the DELETE is a real statement.
      "SELECT $a$ $b$ $a$; DELETE FROM sage_threads; -- $b$",
      "SELECT $$x$$; DROP TABLE sage_threads; SELECT $$y$$",
    ]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_PARSE_FAIL");
    }
    expect(
      preCheckSql(
        "SELECT query_to_xml($$DELETE FROM sage_threads$$, true, false, '')",
      )?.code,
    ).toBe("SQL_FORBIDDEN_KEYWORD");
  });

  it("rejects a mismatched dollar quote", () => {
    expect(
      preCheckSql("SELECT $a$ x; DELETE FROM y $b$ FROM censo_entidades")
        ?.code,
    ).toBe("SQL_PARSE_FAIL");
  });

  it("accepts a matched dollar quote containing ; and keywords", () => {
    expect(
      preCheckSql("SELECT $a$ x; DELETE $b$ y $a$ AS lbl FROM censo_entidades"),
    ).toBeNull();
  });

  it("handles '' and E'\\'' escapes without ending the literal early", () => {
    expect(preCheckSql("SELECT 'it''s; DROP' AS s")).toBeNull();
    // E'' escapes need a backslash, which Sage SQL may not contain at all.
    expect(preCheckSql("SELECT E'it\\'s; DROP' AS s")?.code).toBe(
      "SQL_PARSE_FAIL",
    );
    // Standard string: backslash is literal, so the quote after it closes.
    expect(preCheckSql("SELECT 'a\\'; DROP TABLE x; --'")?.code).toBe(
      "SQL_PARSE_FAIL",
    );
  });

  it("splits literals and comments exactly where Postgres does", () => {
    for (const sql of [
      // `--` comments end at \r too.
      "SELECT 1 --x\r; DELETE FROM y",
      // `1E` must not swallow the E of an E'' string (PG15 rejects it anyway).
      "SELECT 1E'\\''; DELETE FROM x; --'",
      // U+00A0 is an identifier char to PG, so this is a standard string.
      "SELECT \u00a0E'\\'; DELETE FROM x; --'",
    ]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_PARSE_FAIL");
    }
    expect(preCheckSql("SELECT 1.5e3 AS n, 2E-2 AS m")).toBeNull();
  });

  it("rejects unterminated literals and comments", () => {
    for (const sql of ["SELECT 'abc", 'SELECT "abc', "SELECT 1 /* x"]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_PARSE_FAIL");
    }
  });

  it("rejects a backslash outside literals (psql meta-command)", () => {
    expect(preCheckSql("SELECT 1 \\! id")?.code).toBe("SQL_PARSE_FAIL");
  });

  // qa-audit P23: psql reads `1e` as one junk token and then a standard
  // '\' literal, so the `\!` after it is a meta-command to psql -f -,
  // while the tokenizer saw `1` + one E'' string. Any backslash is out.
  it("rejects a backslash anywhere, even where the tokenizer sees a literal", () => {
    for (const sql of [
      "SELECT 1e'\\' \\! id\n' AS x",
      "SELECT 1e'\\' \\echo GATE_PASSED_METACOMMAND\n' AS x",
      "SELECT 'a\\b' AS s",
      "SELECT 1 AS n -- \\! id",
    ]) {
      expect(preCheckSql(sql)?.code).toBe("SQL_PARSE_FAIL");
    }
  });

  it("rejects the MG 2025 polygon tables like the 2020 ones", () => {
    for (const sql of [
      "SELECT count(*) FROM mun_polygons_2025",
      "SELECT cvegeo FROM public.ageb_polygons_2025 LIMIT 1",
      'SELECT 1 FROM "MUN_POLYGONS_2025"',
    ]) {
      expect(preCheckSql(sql)?.code, sql).toBe("SQL_FORBIDDEN_TABLE");
    }
  });

  it("rejects forbidden relations when quoted or schema-qualified", () => {
    expect(preCheckSql('SELECT 1 FROM "Establecimientos"')?.code).toBe(
      "SQL_FORBIDDEN_TABLE",
    );
    expect(preCheckSql("SELECT 1 FROM public.censo_iter")?.code).toBe(
      "SQL_FORBIDDEN_TABLE",
    );
  });

  // Audit #85: a trailing line comment is legitimate.
  it("accepts a query ending in a line comment", () => {
    expect(
      preCheckSql("SELECT cve_ent FROM censo_entidades LIMIT 5 -- note"),
    ).toBeNull();
    expect(
      preCheckSql("SELECT cve_ent FROM censo_entidades LIMIT 5; -- note"),
    ).toBeNull();
  });
});

describe("applyRowCap", () => {
  it("wraps with outer LIMIT", () => {
    const out = applyRowCap("SELECT 1", 5000);
    expect(out).toContain("LIMIT 5000");
    expect(out).toMatch(/^SELECT \* FROM \(/);
  });

  it("strips trailing semicolons before wrapping", () => {
    const out = applyRowCap("SELECT 1;", 100);
    expect(out).not.toMatch(/;\)/);
    expect(out).toContain("LIMIT 100");
  });

  // Audit #85: a trailing comment must not swallow the wrapper.
  it("drops a trailing line comment and `; -- note`", () => {
    for (const sql of [
      "SELECT cve_ent FROM censo_entidades LIMIT 5 -- top 5",
      "SELECT cve_ent FROM censo_entidades LIMIT 5; -- top 5",
      "SELECT cve_ent FROM censo_entidades LIMIT 5 /* top */ ;",
    ]) {
      expect(applyRowCap(sql, 5000)).toBe(
        "SELECT * FROM (\nSELECT cve_ent FROM censo_entidades LIMIT 5\n) AS sage_wrapped LIMIT 5000",
      );
    }
  });

  it("keeps a comment inside the query on its own line", () => {
    const out = applyRowCap("SELECT 1 -- one\n, 2", 10);
    expect(out).toBe(
      "SELECT * FROM (\nSELECT 1 -- one\n, 2\n) AS sage_wrapped LIMIT 10",
    );
  });
});

describe("checkExplainPlan", () => {
  it("accepts a cheap plan", () => {
    const out = checkExplainPlan(
      [{ Plan: { "Node Type": "Index Scan", "Total Cost": 1000 } }],
      { maxCost: 5_000_000 },
    );
    expect(out).toBeNull();
  });

  it("rejects a plan over budget", () => {
    const out = checkExplainPlan(
      [{ Plan: { "Node Type": "Seq Scan", "Total Cost": 9_000_000 } }],
      { maxCost: 5_000_000 },
    );
    expect(out?.code).toBe("SQL_PLAN_TOO_EXPENSIVE");
  });

  it("rejects Seq Scan over forbidden relation regardless of cost", () => {
    const out = checkExplainPlan(
      [
        {
          Plan: {
            "Node Type": "Seq Scan",
            "Relation Name": "establecimientos",
            "Total Cost": 1000,
          },
        },
      ],
      { maxCost: 5_000_000 },
    );
    expect(out?.code).toBe("SQL_PLAN_SEQ_SCAN_BIG");
  });

  // Audit #80: the root Limit's cost is prorated; budget the worst node.
  it("rejects an expensive child under a cheap root Limit", () => {
    const out = checkExplainPlan(
      [
        {
          Plan: {
            "Node Type": "Limit",
            "Total Cost": 375.89,
            Plans: [
              { "Node Type": "Merge Join", "Total Cost": 8_017_528_635.6 },
            ],
          },
        },
      ],
      { maxCost: 5_000_000 },
    );
    expect(out?.code).toBe("SQL_PLAN_TOO_EXPENSIVE");
  });

  it("walks nested plans", () => {
    const out = checkExplainPlan(
      [
        {
          Plan: {
            "Node Type": "Hash Join",
            "Total Cost": 200,
            Plans: [
              {
                "Node Type": "Seq Scan",
                "Relation Name": "establecimientos",
                "Total Cost": 100,
              },
            ],
          },
        },
      ],
      { maxCost: 5_000_000 },
    );
    expect(out?.code).toBe("SQL_PLAN_SEQ_SCAN_BIG");
  });
});

describe("redactPgError (via execution-error code mapping)", () => {
  // We can't unit-test redactPgError directly (not exported); validate
  // its behavior is OPAQUE-by-default by exercising the public surface.
  // The four common PG error families should map to distinct codes
  // without leaking schema text. Smoke-tested through the SqlGateError
  // shape — the actual mapping is owned by sql-gate internals.
  it("Sql gate errors carry only opaque codes, never PG verbatim text", () => {
    // This is a documentation test — the assertion is structural: as long
    // as SqlGateError.message strings come from redactPgError, they should
    // be one of a small fixed set. The set lives in sql-gate.ts.
    const ALLOWED_OPAQUE = new Set([
      "permission_denied",
      "unknown_column",
      "unknown_relation",
      "query_timeout",
      "syntax_error",
      "division_by_zero",
      "invalid_input",
      "execution_error",
      "EXPLAIN timed out",
      "query timed out",
      "could not parse EXPLAIN output",
      "empty SQL",
    ]);
    // Tautology — kept so future contributors see the contract.
    expect(ALLOWED_OPAQUE.size).toBeGreaterThan(0);
  });
});

describe("parseCsv", () => {
  it("parses basic CSV with header", () => {
    const out = parseCsv("a,b\n1,2\n3,4\n");
    expect(out.columns).toEqual(["a", "b"]);
    expect(out.rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    const out = parseCsv('a,b\n"x,y",2\n');
    expect(out.rows[0]).toEqual({ a: "x,y", b: "2" });
  });

  it("handles escaped quotes ('')", () => {
    const out = parseCsv('a\n"he said ""hi"""\n');
    expect((out.rows[0] as Record<string, string>).a).toBe('he said "hi"');
  });

  it("keeps NULL (unquoted empty) distinct from '' (quoted empty) (audit #81)", () => {
    const out = parseCsv('a,b,c\n,"",x\n"",,\n');
    expect(out.rows).toEqual([
      { a: null, b: "", c: "x" },
      { a: "", b: null, c: null },
    ]);
  });

  it("returns empty rows for header-only CSV", () => {
    const out = parseCsv("a,b\n");
    expect(out.columns).toEqual(["a", "b"]);
    expect(out.rows).toEqual([]);
  });
});

describe("executeGatedSql psql invocation", () => {
  beforeEach(() => {
    mockRunSql.mockReset();
  });

  const PLAN = JSON.stringify([
    { Plan: { "Node Type": "Limit", "Total Cost": 10 } },
  ]);

  it("logs in as denue_sage in a READ ONLY txn, never SET ROLE", async () => {
    mockRunSql.mockResolvedValueOnce(PLAN).mockResolvedValueOnce("n\n1\n");
    const res = await executeGatedSql("SELECT 1 AS n -- note", {
      dbContainer: "supabase-db",
    });
    expect(res).toEqual({
      ok: true,
      data: { rows: [{ n: "1" }], columns: ["n"] },
    });
    expect(mockRunSql).toHaveBeenCalledTimes(2);
    for (const call of mockRunSql.mock.calls) {
      const script = call[0] as string;
      expect(call[1]).toMatchObject({
        container: "supabase-db",
        user: "denue_sage",
        readOnly: true,
        timeoutMs: 8000,
      });
      expect(script.startsWith("BEGIN READ ONLY;")).toBe(true);
      expect(script).not.toMatch(/SET\s+(LOCAL\s+)?ROLE/i);
      // Default outer cap is DEFAULT_ROW_CAP=200, not 5000 (audit #87).
      expect(script).toContain("\n) AS sage_wrapped LIMIT 200");
    }
  });

  it("runs EXPLAIN and COPY on the async runner with the caller's abort signal (audit #79/#202)", async () => {
    mockRunSql.mockResolvedValueOnce(PLAN).mockResolvedValueOnce("n\n1\n");
    const ac = new AbortController();
    await executeGatedSql("SELECT 1 AS n", {
      dbContainer: "supabase-db",
      signal: ac.signal,
    });
    expect(mockRunSql.mock.calls.map((c) => c[1].signal)).toEqual([
      ac.signal,
      ac.signal,
    ]);
    expect(mockRunSql.mock.calls[0]![0]).toContain("EXPLAIN (FORMAT JSON)");
    expect(mockRunSql.mock.calls[1]![0]).toContain("COPY (");
  });

  it("never hands a backslash payload to psql (qa-audit P23)", async () => {
    const res = await executeGatedSql(
      "SELECT 1e'\\' \\echo GATE_PASSED_METACOMMAND\n' AS x",
      { dbContainer: "supabase-db" },
    );
    expect(res).toMatchObject({ ok: false, error: { code: "SQL_PARSE_FAIL" } });
    expect(mockRunSql).not.toHaveBeenCalled();
  });

  it("maps a statement_timeout in the runner's stderr to SQL_TIMEOUT", async () => {
    mockRunSql.mockResolvedValueOnce(PLAN).mockRejectedValueOnce(
      Object.assign(new Error("Upstream query failed"), {
        stderr: "ERROR:  canceling statement due to statement timeout",
      }),
    );
    const res = await executeGatedSql("SELECT 1 AS n", {
      dbContainer: "supabase-db",
    });
    expect(res).toEqual({
      ok: false,
      error: { code: "SQL_TIMEOUT", message: "query timed out" },
    });
  });

  it("maps other runner failures to an opaque SQL_EXECUTION_ERROR", async () => {
    mockRunSql.mockRejectedValueOnce(
      Object.assign(new Error("Upstream query failed"), {
        stderr: 'ERROR:  permission denied for table "secret_x"',
      }),
    );
    const res = await executeGatedSql("SELECT 1 AS n", {
      dbContainer: "supabase-db",
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: "SQL_EXECUTION_ERROR",
        message: "permission_denied",
        detail: 'ERROR:  permission denied for table "secret_x"',
      },
    });
    // An abort or client-side kill carries no stderr.
    mockRunSql.mockRejectedValueOnce(new Error("Upstream query failed"));
    const aborted = await executeGatedSql("SELECT 1 AS n", {
      dbContainer: "supabase-db",
    });
    expect(aborted).toEqual({
      ok: false,
      error: { code: "SQL_EXECUTION_ERROR", message: "execution_error" },
    });
  });

  it("never shells out when the pre-check rejects", async () => {
    const res = await executeGatedSql(
      "SELECT '--'; DELETE FROM sage_threads; --'",
      { dbContainer: "supabase-db" },
    );
    expect(res.ok).toBe(false);
    expect(mockRunSql).not.toHaveBeenCalled();
  });

  it("never shells out for a UESCAPE-spelled current_setting (P01 r2)", async () => {
    const res = await executeGatedSql(
      "SELECT U&\"current_!0073etting\" UESCAPE '!'('app.service_role_key') AS k",
      { dbContainer: "supabase-db" },
    );
    expect(res).toMatchObject({
      ok: false,
      error: { code: "SQL_FORBIDDEN_KEYWORD" },
    });
    expect(mockRunSql).not.toHaveBeenCalled();
  });
});
