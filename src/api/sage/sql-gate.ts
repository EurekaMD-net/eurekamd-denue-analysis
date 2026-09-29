/**
 * SQL safety gate for the Sage SQL fallback path.
 *
 * The controls that hold, strongest first:
 *   1. Role — psql logs in AS denue_sage (a non-superuser LOGIN role with
 *      SELECT on the allowlisted views/MVs only). The session never starts
 *      as a superuser, so RESET ROLE / set_config('role') cannot escalate.
 *      scripts/sage-role.sql masks every custom setting stored at database
 *      level (app.service_role_key, ...) with a role-level '' and revokes
 *      the functions that run SQL text (ts_stat, query_to_xml, ...), so
 *      current_setting() reads nothing whatever SQL gets through.
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

import { assertSafeContainer } from "../handlers/_safe-container.js";
import { runSql } from "../db/psql-runner.js";

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
  /**
   * Verbatim psql stderr of an execution error. Server-side only: the
   * handler writes it to sage_turns_audit.error_message and never sends
   * it to the client or the LLM (audit #83).
   */
  detail?: string;
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
  /** Force LIMIT N at the outer level. Default DEFAULT_ROW_CAP. */
  rowCap?: number;
  /** Aborting kills the psql client and cancels the backend. */
  signal?: AbortSignal;
}

/** Outer LIMIT when the caller passes no rowCap. */
export const DEFAULT_ROW_CAP = 200;

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
  "cnbv_credito_raw_2026",
  "cnbv_panorama_estatal_raw",
  "cnbv_panorama_municipal_raw",
  "coneval_grs_ageb_raw",
  "coneval_irs_municipal_raw",
  "coneval_pobreza_municipal_raw",
  "sedatu_financiamientos_raw_2025",
  "sedatu_financiamientos_raw_2026",
  "sict_estaciones_viales_raw_2024",
  "bienestar_padron_estatal_trimestral_raw",
  "aeropuertos_movements_raw",
  "censo_iter",
  "ageb_polygons",
  "ent_polygons",
  "mun_polygons",
  "loc_polygons",
  "ageb_polygons_2025",
  "mun_polygons_2025",
];

// Year-suffixed raw tables of the SNIIV loaders (load-sedatu-financiamientos.ts,
// load-cnbv-credito.ts --year=<YYYY>): denied for every year, so a new year
// needs no edit here. Matched against the lowercased identifier token.
const FORBIDDEN_RELATION_PATTERNS = [
  /^(sedatu_financiamientos|cnbv_credito)_raw_\d{4}$/,
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
  /** U&"..." / U&'...': the body, decoded once any UESCAPE is known. */
  unicodeBody?: string;
}

const IDENT_START = /[A-Za-z_\u0080-\uffff]/;
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

/**
 * Decode a U&"..." body the way PG's str_udeescape does: `<esc><esc>` is
 * the escape char, `<esc>XXXX` / `<esc>+XXXXXX` a code point. Returns null
 * for anything PG would reject, and also for surrogates (PG pairs them;
 * Sage SQL never needs them).
 */
function decodeUnicodeEscapes(body: string, esc: string): string | null {
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] !== esc) {
      out += body[i];
      i++;
      continue;
    }
    if (body[i + 1] === esc) {
      out += esc;
      i += 2;
      continue;
    }
    let hex = /^[0-9A-Fa-f]{4}/.exec(body.slice(i + 1))?.[0];
    if (hex) {
      i += 5;
    } else if (body[i + 1] === "+") {
      hex = /^[0-9A-Fa-f]{6}/.exec(body.slice(i + 2))?.[0];
      if (!hex) return null;
      i += 8;
    } else {
      return null;
    }
    const cp = parseInt(hex, 16);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return null;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** Value of a plain '...' / E'...' / $$...$$ literal (PG SCONST), or null. */
function simpleStringValue(t: SqlToken | undefined): string | null {
  if (t?.kind !== "string" || t.unicodeBody !== undefined) return null;
  const raw = t.value;
  if (raw.startsWith("$")) {
    const tag = DOLLAR_TAG.exec(raw)![0];
    return raw.slice(tag.length, raw.length - tag.length);
  }
  const body = raw.startsWith("'") ? raw.slice(1, -1) : raw.slice(2, -1);
  if (body.includes("\\")) return null;
  return body.replace(/''/g, "'");
}

/**
 * One left-to-right pass over the SQL, following Postgres quoting rules:
 * '...' with '' escapes, E'...' with backslash escapes, $tag$...$tag$
 * closing only on the same tag, "idents" with "" escapes, U&"..." / U&'...'
 * with an optional UESCAPE clause, -- line comments and nested block
 * comments. Comments are dropped. Returns a string error for anything
 * Postgres would treat as unterminated, and for a backslash outside a
 * literal (not valid SQL; psql would read it as a meta-command).
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
    // U&"..." / U&'...' is ONE token to PG, only at a token start (`abcU&"x"`
    // is the word abcu). The body follows the plain "..." / '...' rules, so
    // the UESCAPE char cannot move its end.
    const uq = sql[i + 2];
    if (
      (c === "U" || c === "u") &&
      next === "&" &&
      (uq === '"' || uq === "'")
    ) {
      i += 3;
      let body = "";
      let closed = false;
      while (i < n) {
        if (sql[i] === uq) {
          if (sql[i + 1] === uq) {
            body += uq;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        body += sql[i];
        i++;
      }
      if (!closed) {
        return uq === '"'
          ? "unterminated quoted identifier"
          : "unterminated string literal";
      }
      tokens.push({
        kind: uq === '"' ? "qident" : "string",
        value: sql.slice(start, i),
        start,
        end: i,
        unicodeBody: body,
      });
      continue;
    }
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

  // PG's parser folds `UESCAPE '<c>'` after a U& token into that token and
  // only then decodes it, so U&"current_!0073etting" UESCAPE '!' is the
  // identifier current_setting. Do the same, so every check below sees the
  // name PG will resolve and the stream has no stray UESCAPE tokens.
  const out: SqlToken[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.unicodeBody === undefined) {
      out.push(t);
      continue;
    }
    let esc = "\\";
    const kw = tokens[k + 1];
    if (kw?.kind === "word" && kw.value === "uescape") {
      const escValue = simpleStringValue(tokens[k + 2]);
      // PG: exactly one char, not a hex digit, +, a quote or whitespace.
      // A string right after it could be a PG string continuation, which
      // would change the value, so refuse that too.
      if (
        escValue === null ||
        !/^[!-~]$/.test(escValue) ||
        /[0-9A-Fa-f+'"]/.test(escValue) ||
        tokens[k + 3]?.kind === "string"
      ) {
        return "invalid UESCAPE clause";
      }
      esc = escValue;
      t.end = tokens[k + 2]!.end;
      t.value = sql.slice(t.start, t.end);
      k += 2;
    }
    const decoded = decodeUnicodeEscapes(t.unicodeBody, esc);
    if (decoded === null) return "invalid Unicode escape";
    if (t.kind === "qident") t.value = decoded.toLowerCase();
    out.push(t);
  }
  return out;
}

function isIdent(t: SqlToken | undefined): t is SqlToken {
  return t !== undefined && (t.kind === "word" || t.kind === "qident");
}

export function preCheckSql(sql: string): SqlGateError | null {
  // psql reads the gate script from stdin, where a backslash can start a
  // meta-command (`\!` runs a shell). psql's lexer does not split tokens
  // exactly like tokenizeSql (`1e'\'` is junk + a standard literal to psql,
  // `1` + an E'' string here), so a backslash "inside a literal" is not
  // proof of safety. No backslash anywhere means no meta-command, full stop.
  if (sql.includes("\\")) {
    return {
      code: "SQL_PARSE_FAIL",
      message: "backslash not allowed in Sage SQL",
    };
  }
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
    if (
      FORBIDDEN_RELATIONS.includes(name) ||
      FORBIDDEN_RELATION_PATTERNS.some((re) => re.test(name))
    ) {
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
 *   - Outer LIMIT (default 200)  (so result payload stays bounded)
 *
 * Both calls go through the shared async psql runner (audit #79/#202):
 * the event loop is never blocked, the script goes on stdin, and aborting
 * `config.signal` kills the client and cancels the backend. psql reads
 * the script as a file, so preCheckSql rejects any backslash anywhere in
 * the SQL (literals and comments included): no psql meta-command (`\!`,
 * `\o`) can reach it, whatever psql's lexer makes of the text. pg_hba
 * trusts the container's local socket (and 127.0.0.1/::1 inside it), so
 * `-U denue_sage` needs no password; connections through the published
 * port do not come from the container's loopback, so scram-sha-256
 * applies there and the role has no password to match.
 */
export async function executeGatedSql(
  sql: string,
  config: SqlGateConfig,
): Promise<SqlGateResult> {
  const dbContainer = config.dbContainer;
  assertSafeContainer(dbContainer);

  const preErr = preCheckSql(sql);
  if (preErr) return { ok: false, error: preErr };

  const rowCap = config.rowCap ?? DEFAULT_ROW_CAP;
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
  // runner's wall-clock has +5s headroom for docker exec startup + libpq
  // handshake so the DB-side abort produces a structured error rather
  // than racing the kill (closure audit W4-perf). -q (set by the runner)
  // suppresses the BEGIN / SET / COMMIT command tags that would otherwise
  // prefix the JSON output and corrupt JSON.parse (R-audit-live
  // 2026-05-10).
  const psqlOpts = {
    container: dbContainer,
    user: "denue_sage",
    readOnly: true,
    timeoutMs,
    signal: config.signal,
  };
  let explainRaw: string;
  try {
    explainRaw = await runSql(explainScript, psqlOpts);
  } catch (err) {
    return { ok: false, error: runErrorToGateError(err, "EXPLAIN timed out") };
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
    // -q keeps the BEGIN / SET / COMMIT command tags out of the CSV that
    // COPY writes (same root cause as the EXPLAIN parse fix).
    csvRaw = await runSql(execScript, psqlOpts);
  } catch (err) {
    return { ok: false, error: runErrorToGateError(err, "query timed out") };
  }

  const parsed = parseCsv(csvRaw);
  return { ok: true, data: parsed };
}

// Minimal CSV parser sufficient for psql COPY output. Handles
// double-quoted fields, escaped quotes (""), and newlines inside
// quoted values. Result rows are objects keyed by column name. COPY
// writes NULL as an unquoted empty field and '' as `""`, so an unquoted
// empty field parses to null and a quoted one to "".
export function parseCsv(csv: string): SqlGateSuccess {
  const rows: (string | null)[][] = [];
  let cur: (string | null)[] = [];
  let field = "";
  let quoted = false;
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
      quoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      cur.push(field === "" && !quoted ? null : field);
      field = "";
      quoted = false;
      i++;
      continue;
    }
    if (c === "\n") {
      cur.push(field === "" && !quoted ? null : field);
      rows.push(cur);
      cur = [];
      field = "";
      quoted = false;
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
  if (field.length > 0 || quoted || cur.length > 0) {
    cur.push(field === "" && !quoted ? null : field);
    rows.push(cur);
  }
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1).filter((r) => r.length === header.length);
  const objects = dataRows.map((row) => {
    const o: Record<string, string | null> = {};
    for (let j = 0; j < header.length; j++) {
      o[header[j] ?? ""] = row[j] ?? null;
    }
    return o;
  });
  return { rows: objects, columns: header.map((h) => h ?? "") };
}

// The runner rejects with a generic error; the raw psql stderr rides on
// its `stderr` field (absent on abort, client-side timeout or spawn
// failure).
function runErrorToGateError(
  err: unknown,
  timeoutMessage: string,
): SqlGateError {
  const stderr = (err as { stderr?: string }).stderr ?? "";
  if (/canceling statement due to statement timeout/i.test(stderr)) {
    return { code: "SQL_TIMEOUT", message: timeoutMessage };
  }
  return {
    code: "SQL_EXECUTION_ERROR",
    message: redactPgError(stderr),
    ...(stderr ? { detail: stderr } : {}),
  };
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
