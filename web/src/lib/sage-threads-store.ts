/**
 * localStorage-backed index of Sage threads visited in this browser.
 *
 * The backend (sage_threads + sage_turns_audit) persists thread contents
 * but there is no `/sage/threads` list endpoint in v0.3.1 — and adding
 * one would require either a schema change (sage_threads.user_id) or
 * leak threads across users on the multi-tenant Supabase deployment.
 *
 * Frontend storage avoids that entirely: each browser remembers which
 * thread_ids it created, keyed by the signed-in user id so a sign-out /
 * sign-in cycle on the same browser doesn't expose User A's threads to
 * User B. The backend stays the source-of-truth for thread contents
 * (GET /sage/thread/:id); this store is just a per-user thread index.
 *
 * SSR-safe: every accessor narrows to an in-memory fallback when
 * `window` is undefined, so unit tests in non-jsdom environments and
 * future SSR don't NPE.
 */

const STORAGE_PREFIX = "denue_sage_threads:";
const MAX_THREADS = 20;

export interface SavedThreadIndexEntry {
  thread_id: string;
  /** First question asked in the thread — primary list label. */
  first_question: string;
  /** Most recent question, in case the title would benefit later. */
  last_question: string;
  /** Number of turns observed last time we touched the entry. */
  turn_count: number;
  /** ms since epoch of last access. Newest first in the rendered list. */
  updated_at: number;
}

/**
 * The localStorage key this store writes under, for a given user. Exported
 * so SageMode's cross-tab `storage`-event listener can match the event's
 * `key` against the currently signed-in user without re-deriving the
 * prefix convention. Anonymous fallback ("anon") shouldn't happen in
 * practice (LoginGate blocks unauthenticated children) but the fallback
 * keeps the store safe to use during the hydration window.
 */
export function savedThreadsStorageKey(userId: string | null): string {
  return `${STORAGE_PREFIX}${userId ?? "anon"}`;
}

// Internal alias kept terse for the accessors below.
const key = savedThreadsStorageKey;

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Storage can throw in privacy modes / disabled storage.
    return null;
  }
}

export function listSavedThreads(
  userId: string | null,
): SavedThreadIndexEntry[] {
  const storage = safeStorage();
  if (!storage) return [];
  const raw = storage.getItem(key(userId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isSavedThreadIndexEntry)
      .sort((a, b) => b.updated_at - a.updated_at);
  } catch {
    return [];
  }
}

function isSavedThreadIndexEntry(v: unknown): v is SavedThreadIndexEntry {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["thread_id"] === "string" &&
    typeof o["first_question"] === "string" &&
    typeof o["last_question"] === "string" &&
    typeof o["turn_count"] === "number" &&
    typeof o["updated_at"] === "number"
  );
}

/**
 * Upsert: if the thread is already in the index, update last_question +
 * turn_count + updated_at. Otherwise insert at the head. Trim to the
 * MAX_THREADS most-recent entries.
 */
export function upsertThread(
  userId: string | null,
  entry: SavedThreadIndexEntry,
): SavedThreadIndexEntry[] {
  const storage = safeStorage();
  if (!storage) return [];
  const current = listSavedThreads(userId);
  const idx = current.findIndex((e) => e.thread_id === entry.thread_id);
  let next: SavedThreadIndexEntry[];
  if (idx >= 0) {
    next = [...current];
    next[idx] = { ...current[idx]!, ...entry };
  } else {
    next = [entry, ...current];
  }
  next.sort((a, b) => b.updated_at - a.updated_at);
  next = next.slice(0, MAX_THREADS);
  try {
    storage.setItem(key(userId), JSON.stringify(next));
  } catch {
    // Quota exceeded — drop silently. The index is best-effort UX,
    // not the source of truth.
  }
  return next;
}

/**
 * Drop a thread from the local index. Caller should also DELETE
 * /sage/thread/:id if they want server-side teardown.
 */
export function removeThread(
  userId: string | null,
  threadId: string,
): SavedThreadIndexEntry[] {
  const storage = safeStorage();
  if (!storage) return [];
  const current = listSavedThreads(userId);
  const next = current.filter((e) => e.thread_id !== threadId);
  try {
    storage.setItem(key(userId), JSON.stringify(next));
  } catch {
    // Quota / read-only — silent failure, see above.
  }
  return next;
}
