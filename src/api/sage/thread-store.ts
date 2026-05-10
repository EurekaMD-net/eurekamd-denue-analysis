/**
 * Thin persistence layer over sage_threads + sage_turns_audit. Uses the
 * same docker-exec psql pattern as the rest of the API.
 *
 * Threads are append-only; turns are JSONB digests, never full results.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assertSafeContainer } from "../handlers/_safe-container.js";
import type { PriorTurnDigest } from "./providers/provider.js";
import type { UsageNormalized } from "./providers/provider.js";

export interface ThreadStoreConfig {
  dbContainer: string;
}

export interface TurnRecord extends PriorTurnDigest {
  turn_id: string;
  created_at: string;
}

function execSql(
  config: ThreadStoreConfig,
  sql: string,
  params: string[] = [],
): string {
  assertSafeContainer(config.dbContainer);
  // We deliberately pass SQL as a single -c arg via array form (no
  // shell). Parameters interpolated into SQL must use psql's
  // server-side parsing — for the simple inserts/selects below we
  // build SQL with explicitly-escaped string params (no user input
  // ever reaches this path; all values are app-controlled JSON).
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      config.dbContainer,
      "psql",
      "-U",
      "postgres",
      "-tA",
      "-c",
      sql,
      ...params.flatMap((p) => ["-v", p]),
    ],
    { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function quoteJson(value: unknown): string {
  return quote(JSON.stringify(value));
}

export function createThread(config: ThreadStoreConfig): string {
  const threadId = randomUUID();
  execSql(
    config,
    `INSERT INTO sage_threads (thread_id, turns) VALUES (${quote(threadId)}, '[]'::jsonb);`,
  );
  return threadId;
}

export function getThread(
  config: ThreadStoreConfig,
  threadId: string,
): TurnRecord[] {
  const raw = execSql(
    config,
    `SELECT COALESCE(turns::text, '[]') FROM sage_threads WHERE thread_id = ${quote(threadId)};`,
  );
  if (!raw.trim()) return [];
  try {
    return JSON.parse(raw) as TurnRecord[];
  } catch {
    return [];
  }
}

export function appendTurn(
  config: ThreadStoreConfig,
  threadId: string,
  turn: PriorTurnDigest,
): TurnRecord {
  const turnRecord: TurnRecord = {
    ...turn,
    turn_id: randomUUID(),
    created_at: new Date().toISOString(),
  };
  // Append to the turns array under a per-thread advisory transaction
  // lock so concurrent same-thread submits serialize at the database
  // level. Without this, two in-flight turns both read pre-turn-N
  // history (in sage-handler), then race to append — data is preserved
  // (jsonb || is atomic) but the logical ordering is undefined.
  // Closure audit C4-perf.
  execSql(
    config,
    `BEGIN;
     SELECT pg_advisory_xact_lock(hashtext(${quote(threadId)}));
     UPDATE sage_threads
       SET turns = turns || ${quoteJson([turnRecord])}::jsonb,
           updated_at = NOW()
       WHERE thread_id = ${quote(threadId)};
     COMMIT;`,
  );
  return turnRecord;
}

export function deleteThread(
  config: ThreadStoreConfig,
  threadId: string,
): void {
  execSql(
    config,
    `DELETE FROM sage_threads WHERE thread_id = ${quote(threadId)};`,
  );
}

export interface AuditEntry {
  thread_id: string | null;
  call_kind: "router" | "narrative";
  provider: string;
  model: string;
  prompt: unknown;
  output: unknown;
  usage: UsageNormalized;
  error_code: string | null;
  error_message: string | null;
}

export function appendAudit(
  config: ThreadStoreConfig,
  entry: AuditEntry,
): void {
  execSql(
    config,
    `INSERT INTO sage_turns_audit
      (thread_id, call_kind, provider, model, prompt, output,
       input_tokens, output_tokens, cost_usd, latency_ms,
       error_code, error_message)
     VALUES (
       ${entry.thread_id ? quote(entry.thread_id) : "NULL"},
       ${quote(entry.call_kind)},
       ${quote(entry.provider)},
       ${quote(entry.model)},
       ${quoteJson(entry.prompt)}::jsonb,
       ${entry.output === null ? "NULL" : `${quoteJson(entry.output)}::jsonb`},
       ${entry.usage.input_tokens},
       ${entry.usage.output_tokens},
       ${entry.usage.cost_usd},
       ${entry.usage.latency_ms},
       ${entry.error_code ? quote(entry.error_code) : "NULL"},
       ${entry.error_message ? quote(entry.error_message) : "NULL"}
     );`,
  );
}
