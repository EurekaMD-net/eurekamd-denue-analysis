/**
 * Shared psql transport: `docker exec -i <container> psql -f -`.
 *
 * Audit 2026-09-26 (findings #15 #93 #16 #6 #18 #95 #23 #139):
 *  - async `spawn`, never execFileSync, so a slow query no longer blocks
 *    the Node event loop (and with it /health, auth and tiles);
 *  - SQL goes on stdin, never argv, so it cannot leak through Node's
 *    `Command failed: <argv>` message or `ps`;
 *  - PGOPTIONS (passed with `docker exec -e`, the only path that reaches
 *    the in-container libpq) sets statement_timeout, a read-only session by
 *    default, work_mem=32MB and jit=off — session-level only, the instance
 *    config is untouched;
 *  - a module-level semaphore caps in-flight psql processes;
 *  - every call is tagged with PGAPPNAME=denue-<uuid>. Killing the docker
 *    CLI does NOT stop psql or its backend inside the container, so on
 *    timeout or abort the runner also fires pg_cancel_backend for the tag;
 *  - failures are logged server-side (tag, exit code, truncated stderr) and
 *    thrown as a generic HttpError: no SQL and no stderr in the message.
 *    The raw stderr rides on the error's `stderr` field for server-side
 *    classification only (see isRelationMissingError in analytics.ts).
 *
 * Audit finding #8: every call logs in as the least-privilege denue_api
 * role by default (scripts/api-role.sql: SELECT on the relations the API
 * reads, DML on the Sage thread tables only), never the postgres
 * superuser, so a SQL-building bug cannot reach other projects' data or
 * COPY ... TO PROGRAM. The Sage gate passes its own `user`.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HttpError } from "../middleware/error.js";
import { assertSafeContainer } from "../handlers/_safe-container.js";

export interface RunSqlOptions {
  /** Docker container running Postgres (config.dbContainer). */
  container: string;
  /** default_transaction_read_only for the session. Default true. */
  readOnly?: boolean;
  /** Server-side statement_timeout in ms. The client is killed 5 s later. Default 25000. */
  timeoutMs?: number;
  /** Database role for `psql -U`. Default "denue_api" (scripts/api-role.sql). */
  user?: string;
  /** Aborting kills the client and cancels the backend. */
  signal?: AbortSignal;
  /** Max stdout bytes before the call is killed. Default 64 MB. */
  maxBuffer?: number;
  /** Extra `name=value` session settings appended to PGOPTIONS. */
  extraSettings?: string[];
}

const DEFAULT_TIMEOUT_MS = 25_000;
// The DB-side statement_timeout must fire first so psql reports a clean
// error; the client-side kill is only the backstop.
const CLIENT_GRACE_MS = 5_000;
// 64MB accommodates dense ageb-detail / manzanas-by-ageb payloads.
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_IN_FLIGHT = 6;
const STDERR_LOG_CHARS = 500;
const SETTING_RE = /^[a-z_]+=[A-Za-z0-9_.]+$/;
const ROLE_RE = /^[a-z_][a-z0-9_]*$/;

export const UPSTREAM_ERROR_MESSAGE = "Upstream query failed";
/** Least-privilege login role for API queries (scripts/api-role.sql). */
const API_DB_ROLE = "denue_api";

export type PsqlHttpError = HttpError & { stderr?: string };

function upstreamError(code: string, stderr?: string): PsqlHttpError {
  const err: PsqlHttpError = new HttpError(UPSTREAM_ERROR_MESSAGE, 502, code);
  if (stderr) err.stderr = stderr;
  return err;
}

function log(line: string): void {
  process.stderr.write(`[db] ${line}\n`);
}

function pgOptions(opts: RunSqlOptions): string {
  const settings = [
    `statement_timeout=${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}`,
    `default_transaction_read_only=${opts.readOnly === false ? "off" : "on"}`,
    "work_mem=32MB",
    "jit=off",
    ...(opts.extraSettings ?? []),
  ];
  for (const s of settings) {
    if (!SETTING_RE.test(s)) throw new Error(`unsafe psql setting "${s}"`);
  }
  return settings.map((s) => `-c ${s}`).join(" ");
}

/** argv for `docker exec -i ... psql -f -`; the SQL itself goes on stdin. */
export function psqlArgv(opts: RunSqlOptions, appName: string): string[] {
  try {
    assertSafeContainer(opts.container);
  } catch {
    throw new HttpError("invalid dbContainer", 500, "config.bad_container");
  }
  const user = opts.user ?? API_DB_ROLE;
  if (!ROLE_RE.test(user)) throw new Error(`unsafe psql user "${user}"`);
  return [
    "exec",
    "-i",
    "-e",
    `PGOPTIONS=${pgOptions(opts)}`,
    "-e",
    `PGAPPNAME=${appName}`,
    opts.container,
    "psql",
    "-X",
    "-q",
    "-t",
    "-A",
    "-U",
    user,
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "-",
  ];
}

// --- semaphore ------------------------------------------------------------

let inFlight = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else inFlight--;
}

// --- cancel ---------------------------------------------------------------

/**
 * Fire-and-forget pg_cancel_backend for a tagged session. Runs outside the
 * semaphore (a full queue must not block cancellation) as the same role
 * that ran the query: a non-superuser may cancel its own role's backends,
 * but not another role's. The tag is `denue-<uuid>`, safe to inline.
 */
function cancelBackend(
  container: string,
  appName: string,
  user: string | undefined,
): void {
  const sql = `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = '${appName}';\n`;
  const child = spawn(
    "docker",
    psqlArgv({ container, timeoutMs: 5_000, user }, `${appName}-cancel`),
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  child.on("error", (err) => log(`${appName} cancel failed: ${err.message}`));
  child.stdin?.on("error", () => {});
  child.stdin?.end(sql);
}

// --- runners --------------------------------------------------------------

/** Run SQL and resolve with raw stdout. Rejects with a generic 502 HttpError. */
export function runSql(sql: string, opts: RunSqlOptions): Promise<string> {
  return execTagged(sql, opts, `denue-${randomUUID()}`);
}

async function execTagged(
  sql: string,
  opts: RunSqlOptions,
  appName: string,
): Promise<string> {
  const argv = psqlArgv(opts, appName);
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const wallMs = (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) + CLIENT_GRACE_MS;

  if (opts.signal?.aborted) throw upstreamError("postgres.error");
  await acquire();
  try {
    if (opts.signal?.aborted) throw upstreamError("postgres.error");
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let outBytes = 0;
      let settled = false;

      const finish = (err: PsqlHttpError | null, stdout?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(stdout ?? "");
      };
      const killAndCancel = (reason: string, code: string): void => {
        if (settled) return;
        log(`${appName} ${reason}; killing client and cancelling backend`);
        child.kill("SIGKILL");
        cancelBackend(opts.container, appName, opts.user);
        finish(upstreamError(code));
      };
      const onAbort = (): void => killAndCancel("aborted", "postgres.error");
      const timer = setTimeout(
        () => killAndCancel(`timed out after ${wallMs}ms`, "postgres.error"),
        wallMs,
      );
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > maxBuffer) {
          killAndCancel(`stdout exceeded ${maxBuffer} bytes`, "postgres.error");
          return;
        }
        out.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));
      child.on("error", (err) => {
        log(`${appName} spawn failed: ${err.message}`);
        finish(upstreamError("postgres.error"));
      });
      child.on("close", (code, sig) => {
        if (settled) return;
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        if (code !== 0) {
          log(
            `${appName} exit=${code ?? sig} stderr=${stderr.slice(0, STDERR_LOG_CHARS)}`,
          );
          finish(upstreamError("postgres.error", stderr));
          return;
        }
        finish(null, Buffer.concat(out).toString("utf-8"));
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(sql);
    });
  } finally {
    release();
  }
}

function parseJson<T>(stdout: string, appName: string): T {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "null") return [] as unknown as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${appName} malformed JSON (${trimmed.length} chars): ${msg}`);
    throw upstreamError("postgres.parse_error");
  }
}

/**
 * Run a query whose single output cell is JSON. Empty output or `null`
 * resolves to `[]`; malformed JSON rejects with 502 postgres.parse_error.
 */
export async function runJson<T>(sql: string, opts: RunSqlOptions): Promise<T> {
  const appName = `denue-${randomUUID()}`;
  return parseJson<T>(await execTagged(sql, opts, appName), appName);
}

/**
 * Synchronous variant for boot-time resolvers only (serve.ts runs them
 * before the server listens, so blocking is harmless there). Same argv,
 * PGOPTIONS and stdin transport; no semaphore or cancel. Never use it in a
 * request handler.
 */
export function runJsonSync<T>(sql: string, opts: RunSqlOptions): T {
  const appName = `denue-${randomUUID()}`;
  const argv = psqlArgv(opts, appName);
  let stdout: string;
  try {
    stdout = execFileSync("docker", argv, {
      input: sql,
      encoding: "utf-8",
      timeout: (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) + CLIENT_GRACE_MS,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    });
  } catch (err) {
    const stderrField = (err as { stderr?: unknown }).stderr;
    const stderr =
      typeof stderrField === "string"
        ? stderrField
        : stderrField instanceof Buffer
          ? stderrField.toString("utf-8")
          : "";
    log(`${appName} sync failed: ${stderr.trim().slice(0, STDERR_LOG_CHARS)}`);
    throw upstreamError("postgres.error", stderr.trim());
  }
  return parseJson<T>(stdout, appName);
}
