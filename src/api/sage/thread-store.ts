/**
 * Thin persistence layer over sage_threads + sage_turns_audit. Uses the
 * shared async psql runner (audit #79/#104): no event-loop blocking, and
 * every call has a 10 s statement_timeout plus the runner's client kill.
 *
 * Threads are append-only; turns are JSONB digests, never full results.
 */

import { randomUUID } from "node:crypto";
import { runSql } from "../db/psql-runner.js";
import type { PriorTurnDigest } from "./providers/provider.js";
import type { UsageNormalized } from "./providers/provider.js";

export interface ThreadStoreConfig {
  dbContainer: string;
}

export interface TurnRecord extends PriorTurnDigest {
  turn_id: string;
  created_at: string;
}

const THREAD_STORE_TIMEOUT_MS = 10_000;

function execSql(config: ThreadStoreConfig, sql: string): Promise<string> {
  // SQL goes on stdin via the runner. Values interpolated into SQL are
  // escaped with quote()/quoteJson() below (no user input ever reaches
  // this path; all values are app-controlled JSON).
  return runSql(sql, {
    container: config.dbContainer,
    readOnly: false,
    timeoutMs: THREAD_STORE_TIMEOUT_MS,
  });
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function quoteJson(value: unknown): string {
  return quote(JSON.stringify(value));
}

export async function createThread(
  config: ThreadStoreConfig,
): Promise<string> {
  const threadId = randomUUID();
  await execSql(
    config,
    `INSERT INTO sage_threads (thread_id, turns) VALUES (${quote(threadId)}, '[]'::jsonb);`,
  );
  return threadId;
}

export async function getThread(
  config: ThreadStoreConfig,
  threadId: string,
): Promise<TurnRecord[]> {
  const raw = await execSql(
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

export interface ThreadHead {
  /** Total turns stored on the thread (0 when the row does not exist). */
  turnCount: number;
  /** The last `n` turns, oldest first. */
  lastTurns: TurnRecord[];
}

/**
 * One round trip for what /sage/query needs (audit #88/#208): the turn
 * count for the cap check plus only the last `n` turns for history, so
 * the full turns JSONB is never shipped and parsed just to count it.
 */
export async function getThreadHead(
  config: ThreadStoreConfig,
  threadId: string,
  n: number,
): Promise<ThreadHead> {
  const raw = await execSql(
    config,
    `SELECT json_build_object(
       'count', jsonb_array_length(t),
       'tail', COALESCE(
         (SELECT jsonb_agg(e ORDER BY i)
            FROM jsonb_array_elements(t) WITH ORDINALITY AS x(e, i)
           WHERE i > jsonb_array_length(t) - ${Math.trunc(n)}),
         '[]'::jsonb))::text
     FROM (SELECT COALESCE(turns, '[]'::jsonb) AS t
             FROM sage_threads WHERE thread_id = ${quote(threadId)}) s;`,
  );
  if (!raw.trim()) return { turnCount: 0, lastTurns: [] };
  try {
    const parsed = JSON.parse(raw) as { count: number; tail: TurnRecord[] };
    return { turnCount: parsed.count, lastTurns: parsed.tail };
  } catch {
    return { turnCount: 0, lastTurns: [] };
  }
}

export async function appendTurn(
  config: ThreadStoreConfig,
  threadId: string,
  turn: PriorTurnDigest,
): Promise<TurnRecord> {
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
  await execSql(
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

export async function deleteThread(
  config: ThreadStoreConfig,
  threadId: string,
): Promise<void> {
  await execSql(
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

export async function appendAudit(
  config: ThreadStoreConfig,
  entry: AuditEntry,
): Promise<void> {
  await execSql(
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
