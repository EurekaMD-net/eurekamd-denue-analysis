/**
 * Thin persistence layer over sage_threads + sage_turns_audit. Uses the
 * shared async psql runner (audit #79/#104): no event-loop blocking, and
 * every call has a 10 s statement_timeout plus the runner's client kill.
 *
 * Threads are append-only; turns are JSONB digests, never full results.
 * Every thread belongs to one owner (the JWT sub, or API_KEY_OWNER for the
 * shared X-Api-Key): reads, appends and deletes match thread_id AND
 * owner_sub, so a thread id alone grants nothing (audit #11/#28).
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

/** owner_sub for callers on the shared X-Api-Key (no JWT identity). */
export const API_KEY_OWNER = "api-key";

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

/** The thread's turns, or null when no thread with this id belongs to `ownerSub`. */
export async function getThread(
  config: ThreadStoreConfig,
  threadId: string,
  ownerSub: string,
): Promise<TurnRecord[] | null> {
  const raw = await execSql(
    config,
    `SELECT COALESCE(turns::text, '[]') FROM sage_threads WHERE thread_id = ${quote(threadId)} AND owner_sub = ${quote(ownerSub)};`,
  );
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as TurnRecord[];
  } catch {
    return [];
  }
}

export interface ThreadHead {
  /** Total turns stored on the thread. */
  turnCount: number;
  /** The last `n` turns, oldest first. */
  lastTurns: TurnRecord[];
}

/**
 * One round trip for what /sage/query needs (audit #88/#208): the turn
 * count for the cap check plus only the last `n` turns for history, so
 * the full turns JSONB is never shipped and parsed just to count it.
 * Null when no thread with this id belongs to `ownerSub`.
 */
export async function getThreadHead(
  config: ThreadStoreConfig,
  threadId: string,
  ownerSub: string,
  n: number,
): Promise<ThreadHead | null> {
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
             FROM sage_threads
            WHERE thread_id = ${quote(threadId)}
              AND owner_sub = ${quote(ownerSub)}) s;`,
  );
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as { count: number; tail: TurnRecord[] };
    return { turnCount: parsed.count, lastTurns: parsed.tail };
  } catch {
    return { turnCount: 0, lastTurns: [] };
  }
}

/**
 * Append a turn, creating the thread row on its first turn (lazy creation,
 * audit #82/#207: no empty rows for turns that never finish). The upsert
 * only touches a row that `ownerSub` owns; a row owned by anyone else is
 * left alone and this throws, so the caller never reports a turn_id that
 * was not saved.
 */
export async function appendTurn(
  config: ThreadStoreConfig,
  threadId: string,
  ownerSub: string,
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
  const raw = await execSql(
    config,
    `BEGIN;
     SELECT pg_advisory_xact_lock(hashtext(${quote(threadId)}));
     INSERT INTO sage_threads (thread_id, owner_sub, turns)
       VALUES (${quote(threadId)}, ${quote(ownerSub)}, ${quoteJson([turnRecord])}::jsonb)
       ON CONFLICT (thread_id) DO UPDATE
         SET turns = sage_threads.turns || EXCLUDED.turns,
             updated_at = NOW()
         WHERE sage_threads.owner_sub = EXCLUDED.owner_sub
       RETURNING 'appended';
     COMMIT;`,
  );
  if (!raw.includes("appended")) {
    throw new Error("sage thread not found for this owner; turn not saved");
  }
  return turnRecord;
}

/** True when a thread with this id belonging to `ownerSub` was deleted. */
export async function deleteThread(
  config: ThreadStoreConfig,
  threadId: string,
  ownerSub: string,
): Promise<boolean> {
  const raw = await execSql(
    config,
    `WITH d AS (
       DELETE FROM sage_threads
        WHERE thread_id = ${quote(threadId)} AND owner_sub = ${quote(ownerSub)}
       RETURNING 1)
     SELECT count(*) FROM d;`,
  );
  return raw.trim() === "1";
}

export interface AuditEntry {
  thread_id: string | null;
  call_kind: "router" | "narrative" | "dispatch" | "sql_gate";
  provider: string;
  model: string;
  prompt: unknown;
  output: unknown;
  usage: UsageNormalized;
  error_code: string | null;
  error_message: string | null;
}

/**
 * The thread_id is resolved through sage_threads, so a turn that failed
 * before its thread row was created (lazy creation) is audited with a
 * NULL thread_id instead of failing the FK.
 */
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
       ${entry.thread_id ? `(SELECT thread_id FROM sage_threads WHERE thread_id = ${quote(entry.thread_id)})` : "NULL"},
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
