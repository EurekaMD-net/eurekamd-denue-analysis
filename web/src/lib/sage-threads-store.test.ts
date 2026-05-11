// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SageStoredTurn } from "../api/sage-client";
import {
  listSavedThreads,
  removeThread,
  upsertThread,
  type SavedThreadIndexEntry,
} from "./sage-threads-store";

function entry(
  overrides: Partial<SavedThreadIndexEntry> = {},
): SavedThreadIndexEntry {
  return {
    thread_id: "00000000-0000-0000-0000-000000000001",
    first_question: "primera pregunta",
    last_question: "última pregunta",
    turn_count: 1,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("sage-threads-store (RH-4)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("listSavedThreads returns [] when nothing stored", () => {
    expect(listSavedThreads("user-1")).toEqual([]);
  });

  it("upsertThread inserts when not present", () => {
    upsertThread("user-1", entry({ thread_id: "abc", updated_at: 1 }));
    const list = listSavedThreads("user-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.thread_id).toBe("abc");
  });

  it("upsertThread updates in place when thread_id matches", () => {
    upsertThread("user-1", entry({ thread_id: "abc", turn_count: 1 }));
    upsertThread(
      "user-1",
      entry({
        thread_id: "abc",
        turn_count: 3,
        last_question: "tercera",
        updated_at: 9_999_999_999_999,
      }),
    );
    const list = listSavedThreads("user-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.turn_count).toBe(3);
    expect(list[0]?.last_question).toBe("tercera");
  });

  it("sorts newest-first by updated_at", () => {
    upsertThread("user-1", entry({ thread_id: "old", updated_at: 1 }));
    upsertThread("user-1", entry({ thread_id: "new", updated_at: 2 }));
    upsertThread("user-1", entry({ thread_id: "mid", updated_at: 1.5 }));
    const list = listSavedThreads("user-1");
    expect(list.map((e) => e.thread_id)).toEqual(["new", "mid", "old"]);
  });

  it("caps the list at MAX_THREADS (20), keeping the newest", () => {
    for (let i = 0; i < 25; i++) {
      upsertThread("user-1", entry({ thread_id: `t-${i}`, updated_at: i }));
    }
    const list = listSavedThreads("user-1");
    expect(list).toHaveLength(20);
    // Newest 20 are t-24 down to t-5
    expect(list[0]?.thread_id).toBe("t-24");
    expect(list[19]?.thread_id).toBe("t-5");
  });

  it("scopes by userId so different users see different threads", () => {
    upsertThread("user-A", entry({ thread_id: "a-1" }));
    upsertThread("user-B", entry({ thread_id: "b-1" }));
    expect(listSavedThreads("user-A").map((e) => e.thread_id)).toEqual(["a-1"]);
    expect(listSavedThreads("user-B").map((e) => e.thread_id)).toEqual(["b-1"]);
  });

  it("anon scope is isolated from any signed-in user", () => {
    upsertThread(null, entry({ thread_id: "anon-1" }));
    upsertThread("user-1", entry({ thread_id: "user-1-1" }));
    expect(listSavedThreads(null).map((e) => e.thread_id)).toEqual(["anon-1"]);
    expect(listSavedThreads("user-1").map((e) => e.thread_id)).toEqual([
      "user-1-1",
    ]);
  });

  it("removeThread drops the matching entry and leaves siblings intact", () => {
    upsertThread("user-1", entry({ thread_id: "keep", updated_at: 1 }));
    upsertThread("user-1", entry({ thread_id: "drop", updated_at: 2 }));
    removeThread("user-1", "drop");
    expect(listSavedThreads("user-1").map((e) => e.thread_id)).toEqual([
      "keep",
    ]);
  });

  it("tolerates corrupted storage (manual JSON mangling)", () => {
    window.localStorage.setItem(
      "denue_sage_threads:user-1",
      "this is not json",
    );
    expect(listSavedThreads("user-1")).toEqual([]);
  });

  it("rejects malformed entries from storage (defensive parse)", () => {
    window.localStorage.setItem(
      "denue_sage_threads:user-1",
      JSON.stringify([
        {
          thread_id: "ok",
          first_question: "q",
          last_question: "q",
          turn_count: 1,
          updated_at: 1,
        },
        { thread_id: 123 }, // bad shape
        null,
        "string",
      ]),
    );
    const list = listSavedThreads("user-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.thread_id).toBe("ok");
  });
});

describe("SageStoredTurn shape (RH-4 audit C1)", () => {
  // Backend persists JSONB digest under `first_5_rows` (server-side
  // truncation; see `src/api/sage/sage-handler.ts:345`). The first-pass
  // SageMode hydrate read `first_n_rows` instead, which is the in-memory
  // dispatcher shape, not the persisted shape. Result: restored threads
  // always rendered empty tables. This test pins the contract.
  it("digest uses `first_5_rows` to match backend persistence", () => {
    // Type-level: assigning a literal to SageStoredTurn confirms the
    // field is named first_5_rows and not first_n_rows.
    const sample: SageStoredTurn = {
      turn_id: "00000000-0000-0000-0000-000000000001",
      created_at: "2026-05-11T00:00:00Z",
      question: "Test",
      route: null,
      digest: {
        columns: ["a", "b"],
        first_5_rows: [
          { a: 1, b: 2 },
          { a: 3, b: 4 },
        ],
        row_count: 2,
      },
      narrative: "n/a",
    };
    // Runtime: rehydration reads first_5_rows, not first_n_rows.
    const rows = sample.digest?.first_5_rows ?? [];
    expect(rows).toHaveLength(2);
    // first_n_rows must NOT exist on the type (compile-time check):
    // @ts-expect-error - intentional: confirm `first_n_rows` is not part of SageStoredTurn
    void sample.digest?.first_n_rows;
  });
});
