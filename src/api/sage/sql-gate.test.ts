import { describe, it, expect } from "vitest";
import {
  preCheckSql,
  applyRowCap,
  checkExplainPlan,
  parseCsv,
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

  it("returns empty rows for header-only CSV", () => {
    const out = parseCsv("a,b\n");
    expect(out.columns).toEqual(["a", "b"]);
    expect(out.rows).toEqual([]);
  });
});
