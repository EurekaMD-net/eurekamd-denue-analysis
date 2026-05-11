/**
 * SQL safety gate for the Sage SQL fallback path.
 *
 * Four layers, smallest to strongest:
 *   1. Regex pre-check       — reject obvious DDL/DML at the lexical level.
 *   2. Single-statement check — reject anything with multiple statements.
 *   3. EXPLAIN plan budget   — reject expensive plans before they run.
 *   4. Role + runtime guards — execute as denue_sage with statement_timeout.
 *
 * Even if all four fail in concert, the worst the query can do is SELECT
 * from the denue_sage allowlist (no establecimientos, no raw tables).
 *
 * Errors return structured codes the caller can surface to the LLM:
 *   SQL_PARSE_FAIL         — multiple statements, or starts with non-SELECT
 *   SQL_FORBIDDEN_KEYWORD  — DDL/DML keyword present
 *   SQL_FORBIDDEN_TABLE    — references a non-allowlisted table
 *   SQL_PLAN_TOO_EXPENSIVE — EXPLAIN cost above budget
 *   SQL_PLAN_SEQ_SCAN_BIG  — Seq Scan over a large/forbidden relation
 *   SQL_TIMEOUT            — statement_timeout fired
 *   SQL_EXECUTION_ERROR    — postgres returned an error
 */

import { execFileSync } from "node:child_process";
import { assertSafeContainer } from "../handlers/_safe-container.js";

export type SqlGateErrorCode =
  | "SQL_PARSE_FAIL"
  | "SQL_FORBIDDEN_KEYWORD"
  | "SQL_FORBIDDEN_TABLE"
  | "SQL_PLAN_TOO_EXPENSIVE"
  | "SQL_PLAN_SEQ_SCAN_BIG"
  | "SQL_TIMEOUT"
  | "SQL_EXECUTION_ERROR";

export interface SqlGateError {
  code: SqlGateErrorCode;
  message: string;
}

export interface SqlGateSuccess {
  rows: unknown[];
  columns: string[];
}

export type SqlGateResult =
  | { ok: true; data: SqlGateSuccess }
  | { ok: false; error: SqlGateError };

export interface SqlGateConfig {
  dbContainer: string;
  /** Wall-clock cap; postgres statement_timeout is also set below. */
  timeoutMs?: number;
  /** EXPLAIN cost rejection threshold. Default 5e6. */
  maxCost?: number;
  /** Force LIMIT N at the outer level. Default 5000. */
  rowCap?: number;
}

// Forbidden keywords at the lexical level. Matched case-insensitively
// outside string literals. Block list, not allow list, so legitimate
// SELECT/WITH queries pass cleanly.
const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "TRUNCATE",
  "ALTER",
  "CREATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "VACUUM",
  "ANALYZE",
  "REINDEX",
  "CLUSTER",
  "LOCK",
  "RESET",
  "SET",
  "EXECUTE",
  "PREPARE",
  "DEALLOCATE",
  "LISTEN",
  "NOTIFY",
  "UNLISTEN",
  "DO",
  "CALL",
  "SECURITY",
  "DEFINER",
  "MERGE",
];

// Sensitive relations that must never appear in user-authored SQL text.
// The preCheckSql regex rejects any query that *names* one of these.
// Defense in depth on top of the denue_sage role GRANTs.
const FORBIDDEN_RELATIONS = [
  "establecimientos",
  "sesnsp_delitos_municipal_raw",
  "censo_ageb_raw",
  "ce2024_raw",
  "enigh_concentradohogar_raw",
  "enoe_sdem_raw",
  "inegi_edr_defunciones_raw",
  "sinba_ec_raw",
  "cofepris_farmacias",
  "clues_raw",
  "cnbv_credito_raw_2025",
  "cnbv_panorama_estatal_raw",
  "cnbv_panorama_municipal_raw",
  "coneval_grs_ageb_raw",
  "coneval_irs_municipal_raw",
  "coneval_pobreza_municipal_raw",
  "sedatu_financiamientos_raw_2025",
  "sict_estaciones_viales_raw_2024",
  "bienestar_padron_estatal_trimestral_raw",
  "aeropuertos_movements_raw",
  "censo_iter",
  "ageb_polygons",
  "ent_polygons",
  "mun_polygons",
  "loc_polygons",
];

// Relations the EXPLAIN planner must never Seq-Scan. Strictly the
// largest tables — Seq Scan over 16M+ rows would burn the
// statement_timeout (and the operator's wallet) even if the role GRANT
// happened to be loose. Smaller base tables (e.g. cofepris_farmacias =
// 2,381 rows) are intentionally absent; the planner inlines allowlisted
// views to those base tables, which the EXPLAIN plan reflects, and
// blocking the Seq Scan there would refuse legitimate queries through
// the allowlisted view. Live-finding 2026-05-10.
const FORBIDDEN_SEQ_SCAN_RELATIONS = [
  "establecimientos",
  "sesnsp_delitos_municipal_raw",
  "censo_ageb_raw",
  "censo_iter",
];

// Strip string literals (single-quoted) and line/block comments before
// keyword scanning, so a query like SELECT 'INSERT' FROM ... is allowed.
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/'[^']*'/g, "''") // single-quoted strings (lossy but safe)
    .replace(/\$[A-Za-z0-9_]*\$[\s\S]*?\$[A-Za-z0-9_]*\$/g, "''"); // dollar-quoted
}

export function preCheckSql(sql: string): SqlGateError | null {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return { code: "SQL_PARSE_FAIL", message: "empty SQL" };
  }

  // Single-statement rule: count meaningful semicolons. A trailing `;` is
  // allowed; semicolons inside the body are not.
  const stripped = stripLiteralsAndComments(trimmed);
  const innerSemicolons = stripped.replace(/;\s*$/, "").includes(";");
  if (innerSemicolons) {
    return {
      code: "SQL_PARSE_FAIL",
      message: "multiple statements not allowed",
    };
  }

  // First non-whitespace token must be SELECT or WITH.
  const firstToken = stripped
    .replace(/^\s+/, "")
    .split(/\s+/)[0]
    ?.toUpperCase();
  if (firstToken !== "SELECT" && firstToken !== "WITH") {
    return {
      code: "SQL_PARSE_FAIL",
      message: `expected SELECT or WITH, got ${firstToken}`,
    };
  }

  // Forbidden keyword scan. Word-boundary so columns named "select_id"
  // (not present in our schema, but defensively) wouldn't trigger.
  const upper = stripped.toUpperCase();
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(upper)) {
      return {
        code: "SQL_FORBIDDEN_KEYWORD",
        message: `keyword "${kw}" not allowed in Sage SQL`,
      };
    }
  }

  // Forbidden-relation scan. Case-insensitive; word-boundary.
  for (const rel of FORBIDDEN_RELATIONS) {
    const re = new RegExp(`\\b${rel}\\b`, "i");
    if (re.test(stripped)) {
      return {
        code: "SQL_FORBIDDEN_TABLE",
        message: `table "${rel}" not in Sage allowlist`,
      };
    }
  }

  return null;
}

/**
 * Wrap user SQL with an outer LIMIT. Postgres allows LIMIT on top of
 * SELECT/CTE; we wrap as a subselect to enforce N even if the user
 * forgot. Idempotent against existing LIMIT (smaller LIMIT wins).
 */
export function applyRowCap(sql: string, cap: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  return `SELECT * FROM (${trimmed}) AS sage_wrapped LIMIT ${cap}`;
}

interface ExplainPlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Total Cost"?: number;
  Plans?: ExplainPlanNode[];
}

interface ExplainOutput {
  Plan?: ExplainPlanNode;
}

function walkPlan(
  node: ExplainPlanNode | undefined,
  fn: (n: ExplainPlanNode) => void,
): void {
  if (!node) return;
  fn(node);
  for (const child of node.Plans ?? []) walkPlan(child, fn);
}

export function checkExplainPlan(
  explain: ExplainOutput[],
  config: { maxCost: number },
): SqlGateError | null {
  const root = explain[0]?.Plan;
  if (!root) {
    return { code: "SQL_PARSE_FAIL", message: "EXPLAIN returned no plan" };
  }
  const totalCost = root["Total Cost"] ?? 0;
  if (totalCost > config.maxCost) {
    return {
      code: "SQL_PLAN_TOO_EXPENSIVE",
      message: `plan cost ${totalCost.toFixed(0)} exceeds budget ${config.maxCost}`,
    };
  }
  let err: SqlGateError | null = null;
  walkPlan(root, (n) => {
    if (err) return;
    const nodeType = n["Node Type"];
    const rel = n["Relation Name"];
    if (
      nodeType === "Seq Scan" &&
      rel &&
      FORBIDDEN_SEQ_SCAN_RELATIONS.includes(rel.toLowerCase())
    ) {
      err = {
        code: "SQL_PLAN_SEQ_SCAN_BIG",
        message: `EXPLAIN shows Seq Scan over forbidden relation "${rel}"`,
      };
    }
  });
  return err;
}

/**
 * Execute the gated SQL. Returns rows + columns on success or a
 * structured error code on failure. The caller (sage route) records
 * the outcome in sage_turns_audit.
 *
 * Postgres-side guards baked into every call:
 *   - SET ROLE denue_sage  (so privilege is enforced by the DB)
 *   - SET statement_timeout = 8000  (so runaway queries die)
 *   - Outer LIMIT 5000  (so result payload stays bounded)
 *
 * We shell out to `docker exec ... psql` rather than using node-postgres
 * because the rest of the API already uses this pattern and the
 * statement_timeout/role discipline is per-session — wrapping in BEGIN
 * + SET LOCAL guarantees they're scoped to the single query.
 */
export async function executeGatedSql(
  sql: string,
  config: SqlGateConfig,
): Promise<SqlGateResult> {
  const dbContainer = config.dbContainer;
  assertSafeContainer(dbContainer);

  const preErr = preCheckSql(sql);
  if (preErr) return { ok: false, error: preErr };

  const rowCap = config.rowCap ?? 5000;
  const timeoutMs = config.timeoutMs ?? 8000;
  const maxCost = config.maxCost ?? 5_000_000;

  const wrapped = applyRowCap(sql, rowCap);

  // EXPLAIN first (statement_timeout still applies). Wrap the whole
  // transaction so role + timeout are scoped to this one operation.
  const explainScript = `
BEGIN;
SET LOCAL ROLE denue_sage;
SET LOCAL statement_timeout = ${timeoutMs};
EXPLAIN (FORMAT JSON) ${wrapped};
COMMIT;
`.trim();

  // PG stmt_timeout (in-band SET LOCAL in explainScript) fires first; the
  // execFileSync wall-clock has +5s headroom for docker exec startup +
  // libpq handshake so the DB-side abort produces a structured error
  // rather than racing SIGTERM (closure audit W4-perf; parity with
  // analytics.ts 5s discipline).
  let explainRaw: string;
  try {
    // -tA: tuples-only + unaligned. -q: quiet (suppresses the BEGIN /
    // SET / COMMIT command tags that would otherwise prefix the JSON
    // output and corrupt JSON.parse. Without -q the parse fails on
    // multi-statement scripts (R-audit-live finding 2026-05-10).
    explainRaw = execFileSync(
      "docker",
      [
        "exec",
        "-i",
        dbContainer,
        "psql",
        "-U",
        "postgres",
        "-tAq",
        "-c",
        explainScript,
      ],
      {
        encoding: "utf-8",
        timeout: timeoutMs + 5000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (err) {
    const e = err as { stderr?: Buffer; message?: string };
    const msg = e.stderr?.toString("utf-8") ?? e.message ?? "EXPLAIN failed";
    if (/canceling statement due to statement timeout/i.test(msg)) {
      return {
        ok: false,
        error: { code: "SQL_TIMEOUT", message: "EXPLAIN timed out" },
      };
    }
    return {
      ok: false,
      error: { code: "SQL_EXECUTION_ERROR", message: redactPgError(msg) },
    };
  }

  let explainParsed: ExplainOutput[];
  try {
    explainParsed = JSON.parse(explainRaw) as ExplainOutput[];
  } catch {
    return {
      ok: false,
      error: {
        code: "SQL_PARSE_FAIL",
        message: "could not parse EXPLAIN output",
      },
    };
  }
  const planErr = checkExplainPlan(explainParsed, { maxCost });
  if (planErr) return { ok: false, error: planErr };

  // Plan passed. Execute the same wrapped SQL.
  const execScript = `
BEGIN;
SET LOCAL ROLE denue_sage;
SET LOCAL statement_timeout = ${timeoutMs};
COPY (${wrapped}) TO STDOUT WITH (FORMAT csv, HEADER true);
COMMIT;
`.trim();

  let csvRaw: string;
  try {
    // -q suppresses the BEGIN / SET / COMMIT command-tag lines that
    // would otherwise interleave with the COPY-emitted CSV (same
    // root cause as the EXPLAIN parse fix). Without -q the CSV
    // parser sees "BEGIN\nSET\nSET\n<rows>\nCOMMIT" and treats the
    // first three as header + data rows.
    csvRaw = execFileSync(
      "docker",
      [
        "exec",
        "-i",
        dbContainer,
        "psql",
        "-U",
        "postgres",
        "-q",
        "-c",
        execScript,
      ],
      {
        encoding: "utf-8",
        timeout: timeoutMs + 5000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (err) {
    const e = err as { stderr?: Buffer; message?: string };
    const msg = e.stderr?.toString("utf-8") ?? e.message ?? "execution failed";
    if (/canceling statement due to statement timeout/i.test(msg)) {
      return {
        ok: false,
        error: { code: "SQL_TIMEOUT", message: "query timed out" },
      };
    }
    return {
      ok: false,
      error: { code: "SQL_EXECUTION_ERROR", message: redactPgError(msg) },
    };
  }

  const parsed = parseCsv(csvRaw);
  return { ok: true, data: parsed };
}

// Minimal CSV parser sufficient for psql COPY output. Handles
// double-quoted fields, escaped quotes (""), and newlines inside
// quoted values. Result rows are objects keyed by column name.
export function parseCsv(csv: string): SqlGateSuccess {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < csv.length) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"' && csv[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n") {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1).filter((r) => r.length === header.length);
  const objects = dataRows.map((row) => {
    const o: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      o[header[j] ?? ""] = row[j] ?? "";
    }
    return o;
  });
  return { rows: objects, columns: header };
}

// Map Postgres errors to opaque codes so schema/role internals never
// leak to the LLM response (and thence to the user). The verbatim PG
// text is still recorded in sage_turns_audit.error_message for operator
// debugging — only the public-facing message is redacted. Closure audit
// W1-sec.
function redactPgError(msg: string): string {
  if (/permission denied/i.test(msg)) return "permission_denied";
  if (/does not exist/i.test(msg) && /column/i.test(msg))
    return "unknown_column";
  if (/does not exist/i.test(msg) && /(relation|table)/i.test(msg)) {
    return "unknown_relation";
  }
  if (/canceling statement due to statement timeout/i.test(msg)) {
    return "query_timeout";
  }
  if (/syntax error/i.test(msg)) return "syntax_error";
  if (/division by zero/i.test(msg)) return "division_by_zero";
  if (/invalid input syntax/i.test(msg)) return "invalid_input";
  // Catchall: no verbatim ERROR-text in the public payload.
  return "execution_error";
}
