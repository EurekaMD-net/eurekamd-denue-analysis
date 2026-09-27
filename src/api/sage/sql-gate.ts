/**
 * SQL safety gate for the Sage SQL fallback path.
 *
 * The controls that hold, strongest first:
 *   1. Role — psql logs in AS denue_sage (a non-superuser LOGIN role with
 *      SELECT on the allowlisted views/MVs only). The session never starts
 *      as a superuser, so RESET ROLE / set_config('role') cannot escalate.
 *   2. Read-only transaction — every script opens with BEGIN READ ONLY, so
 *      writes (including pg_net's queue INSERT) fail even where PUBLIC has
 *      been granted them. statement_timeout is set in the same transaction.
 *   3. Single statement — a real left-to-right tokenizer (quotes, E'',
 *      $tag$, "idents", nested comments) must see exactly one statement
 *      starting with SELECT or WITH.
 *   4. EXPLAIN plan budget — the most expensive plan node must fit the
 *      budget and no forbidden relation may be Seq-Scanned.
 *
 * Best effort only, not a control: the keyword, relation and function
 * denylists run on the same token stream. They give the LLM a clear error
 * for obvious mistakes; the role and read-only transaction are what stop
 * a query that slips past them.
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
// The preCheckSql token scan rejects any query that *names* one of these.
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

// Functions / catalog relations that read or change server settings,
// touch the filesystem, open connections, or run SQL text the gate never
// saw. Matched against every identifier token, quoted or schema-qualified.
const FORBIDDEN_FUNCTIONS = [
  "current_setting",
  "set_config",
  "pg_settings",
  "pg_show_all_settings",
  "pg_db_role_setting",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_cancel_backend",
  "pg_terminate_backend",
  // ts_stat(text) and ts_rewrite(tsquery, text) run their text argument
  // as a query through SPI.
  "ts_stat",
  "ts_rewrite",
];
const FORBIDDEN_FUNCTION_PREFIXES = [
  "lo_",
  "dblink",
  "query_to_xml",
  "table_to_xml",
  "cursor_to_xml",
  "schema_to_xml",
  "database_to_xml",
  "pg_sleep",
];
// Any name qualified by one of these schemas is rejected (pg_net, Supabase
// vault/auth/storage, extension helpers).
const FORBIDDEN_SCHEMAS = ["net", "vault", "auth", "storage", "extensions"];

type SqlTokenKind = "word" | "qident" | "string" | "number" | "op";

interface SqlToken {
  kind: SqlTokenKind;
  /** word/qident: lowercased name; op: the operator text; else raw text. */
  value: string;
  start: number;
  end: number;
}

const IDENT_START = /[A-Za-z_\u0080-\uffff]/;
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

/**
 * One left-to-right pass over the SQL, following Postgres quoting rules:
 * '...' with '' escapes, E'...' with backslash escapes, $tag$...$tag$
 * closing only on the same tag, "idents" with "" escapes, -- line comments
 * and nested block comments. Comments are dropped. Returns a string error
 * for anything Postgres would treat as unterminated, and for a backslash
 * outside a literal (not valid SQL; psql would read it as a meta-command).
 */
function tokenizeSql(sql: string): SqlToken[] | string {
  const tokens: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    // Postgres whitespace only: any non-ASCII char (even U+00A0) is an
    // identifier char to PG, so `\u00a0E'..'` is not an E'' string there.
    if (/[ \t\n\r\f]/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) return "unterminated block comment";
      continue;
    }
    const start = i;
    if (c === "'" || ((c === "E" || c === "e") && next === "'")) {
      const backslashEscapes = c !== "'";
      i += backslashEscapes ? 2 : 1;
      let closed = false;
      while (i < n) {
        const ch = sql[i];
        if (backslashEscapes && ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return "unterminated string literal";
      tokens.push({
        kind: "string",
        value: sql.slice(start, i),
        start,
        end: i,
      });
      continue;
    }
    if (c === '"') {
      i++;
      let name = "";
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            name += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        name += sql[i];
        i++;
      }
      if (!closed) return "unterminated quoted identifier";
      tokens.push({ kind: "qident", value: name.toLowerCase(), start, end: i });
      continue;
    }
    if (c === "$") {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) return "unterminated dollar-quoted string";
        i = close + tag.length;
        tokens.push({
          kind: "string",
          value: sql.slice(start, i),
          start,
          end: i,
        });
        continue;
      }
    }
    if (IDENT_START.test(c)) {
      while (i < n && IDENT_CHAR.test(sql[i]!)) i++;
      tokens.push({
        kind: "word",
        value: sql.slice(start, i).toLowerCase(),
        start,
        end: i,
      });
      continue;
    }
    if (/[0-9]/.test(c)) {
      // Digits, dots and a complete exponent only. PG never lets a number
      // absorb the E of `1E'..'` (it raises trailing junk), so neither may we.
      while (i < n && /[0-9.]/.test(sql[i]!)) i++;
      const exp = /^[eE][+-]?[0-9]+/.exec(sql.slice(i))?.[0];
      if (exp) i += exp.length;
      tokens.push({
        kind: "number",
        value: sql.slice(start, i),
        start,
        end: i,
      });
      continue;
    }
    if (c === "\\") return "backslash outside a string literal";
    i++;
    tokens.push({ kind: "op", value: c, start, end: i });
  }
  return tokens;
}

function isIdent(t: SqlToken | undefined): t is SqlToken {
  return t !== undefined && (t.kind === "word" || t.kind === "qident");
}

export function preCheckSql(sql: string): SqlGateError | null {
  const tokens = tokenizeSql(sql);
  if (typeof tokens === "string") {
    return { code: "SQL_PARSE_FAIL", message: tokens };
  }
  if (tokens.length === 0) {
    return { code: "SQL_PARSE_FAIL", message: "empty SQL" };
  }

  // Single-statement rule: after the first `;` only more `;` may follow
  // (comments are already dropped, so `SELECT 1; -- note` is fine).
  const firstSemi = tokens.findIndex(
    (t) => t.kind === "op" && t.value === ";",
  );
  if (
    firstSemi !== -1 &&
    tokens.slice(firstSemi).some((t) => !(t.kind === "op" && t.value === ";"))
  ) {
    return {
      code: "SQL_PARSE_FAIL",
      message: "multiple statements not allowed",
    };
  }

  // First token must be the bare keyword SELECT or WITH.
  const first = tokens[0]!;
  const firstWord = first.kind === "word" ? first.value.toUpperCase() : "";
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    return {
      code: "SQL_PARSE_FAIL",
      message: `expected SELECT or WITH, got ${firstWord || first.value}`,
    };
  }

  // Forbidden keyword scan over unquoted words. `set_config` is one word
  // token, so it never matches SET here; the function denylist covers it.
  for (const t of tokens) {
    if (t.kind !== "word") continue;
    const kw = t.value.toUpperCase();
    if (FORBIDDEN_KEYWORDS.includes(kw)) {
      return {
        code: "SQL_FORBIDDEN_KEYWORD",
        message: `keyword "${kw}" not allowed in Sage SQL`,
      };
    }
  }

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (!isIdent(t)) continue;
    const name = t.value;

    // Forbidden-relation scan, quoted or schema-qualified.
    if (FORBIDDEN_RELATIONS.includes(name)) {
      return {
        code: "SQL_FORBIDDEN_TABLE",
        message: `table "${name}" not in Sage allowlist`,
      };
    }

    // Function / settings denylist.
    if (
      FORBIDDEN_FUNCTIONS.includes(name) ||
      FORBIDDEN_FUNCTION_PREFIXES.some((p) => name.startsWith(p))
    ) {
      return {
        code: "SQL_FORBIDDEN_KEYWORD",
        message: `function "${name}" not allowed in Sage SQL`,
      };
    }

    // Schema-qualified reference into a denied schema: `net.http_post`.
    const dot = tokens[k + 1];
    if (
      FORBIDDEN_SCHEMAS.includes(name) &&
      dot?.kind === "op" &&
      dot.value === "." &&
      isIdent(tokens[k + 2])
    ) {
      return {
        code: "SQL_FORBIDDEN_TABLE",
        message: `schema "${name}" not in Sage allowlist`,
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
  // Cut at the end of the last real token, dropping trailing `;` and
  // comments (`... LIMIT 5; -- top 5`). The inner SQL sits on its own
  // lines so a comment inside it cannot swallow the wrapper.
  let inner = sql.trim();
  const tokens = tokenizeSql(sql);
  if (typeof tokens !== "string") {
    const last = [...tokens]
      .reverse()
      .find((t) => !(t.kind === "op" && t.value === ";"));
    if (last) inner = sql.slice(0, last.end).trim();
  }
  return `SELECT * FROM (\n${inner}\n) AS sage_wrapped LIMIT ${cap}`;
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
  // The root is always the wrapper's Limit, whose cost is prorated by the
  // fraction of rows fetched. Budget the most expensive node instead.
  let totalCost = 0;
  walkPlan(root, (n) => {
    totalCost = Math.max(totalCost, n["Total Cost"] ?? 0);
  });
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

// Log in as the least-privileged role itself (pg_hba trusts the container's
// local socket; TCP needs a password the role does not have). -X skips any
// psqlrc; ON_ERROR_STOP makes psql exit non-zero on the first error.
function sagePsqlArgs(): string[] {
  return [
    "psql",
    "-X",
    "-U",
    "denue_sage",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
  ];
}

/**
 * Execute the gated SQL. Returns rows + columns on success or a
 * structured error code on failure. The caller (sage route) records
 * the outcome in sage_turns_audit.
 *
 * Postgres-side guards baked into every call:
 *   - psql -U denue_sage  (logs in as the role; never a superuser session)
 *   - BEGIN READ ONLY  (writes fail, including pg_net queue inserts)
 *   - SET LOCAL statement_timeout  (so runaway queries die)
 *   - ON_ERROR_STOP  (psql stops at the first failing statement)
 *   - Outer LIMIT 5000  (so result payload stays bounded)
 *
 * We shell out to `docker exec ... psql` rather than using node-postgres
 * because the rest of the API already uses this pattern. The script goes
 * as one -c string, which psql sends to the server verbatim: no psql
 * meta-commands (`\!`) or `:var` interpolation apply to the LLM's SQL.
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
  // transaction so read-only + timeout are scoped to this one operation.
  const explainScript = `
BEGIN READ ONLY;
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
        ...sagePsqlArgs(),
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
BEGIN READ ONLY;
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
        ...sagePsqlArgs(),
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
