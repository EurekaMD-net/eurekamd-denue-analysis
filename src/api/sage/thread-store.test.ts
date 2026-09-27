import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunSql } = vi.hoisted(() => ({ mockRunSql: vi.fn() }));
vi.mock("../db/psql-runner.js", () => ({ runSql: mockRunSql }));

import {
  appendAudit,
  appendTurn,
  deleteThread,
  getThread,
  getThreadHead,
} from "./thread-store.js";

const CFG = { dbContainer: "supabase-db" };
const TID = "00000000-0000-0000-0000-000000000001";
const OWNER = "user-1";
const TURN = {
  question: "q",
  route: { kind: "sql" as const, sql: "SELECT 1" },
  digest: { columns: [], row_count: 0, first_5_rows: [] },
  narrative: "n",
};

beforeEach(() => {
  mockRunSql.mockReset();
});

describe("thread-store on the async runner (audit #79/#104)", () => {
  it("writes through runSql with a 10 s timeout and a writable session", async () => {
    mockRunSql.mockResolvedValue("\nappended\n");
    await appendTurn(CFG, TID, OWNER, TURN);
    expect(mockRunSql).toHaveBeenCalledTimes(1);
    expect(mockRunSql.mock.calls[0]![1]).toEqual({
      container: "supabase-db",
      readOnly: false,
      timeoutMs: 10_000,
    });
    expect(mockRunSql.mock.calls[0]![0]).toContain("pg_advisory_xact_lock");
  });

  it("appendTurn upserts the row with its owner (lazy creation, audit #82/#207)", async () => {
    mockRunSql.mockResolvedValue("\nappended\n");
    const rec = await appendTurn(CFG, TID, OWNER, TURN);
    const sql = mockRunSql.mock.calls[0]![0] as string;
    expect(sql).toContain(
      "INSERT INTO sage_threads (thread_id, owner_sub, turns)",
    );
    expect(sql).toContain(`VALUES ('${TID}', '${OWNER}', `);
    expect(sql).toContain("ON CONFLICT (thread_id) DO UPDATE");
    expect(sql).toContain("WHERE sage_threads.owner_sub = EXCLUDED.owner_sub");
    expect(sql).not.toMatch(/^\s*UPDATE sage_threads/m);
    expect(rec.turn_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("appendTurn throws when the row belongs to another owner (nothing saved)", async () => {
    // The owner-guarded upsert returns no row: the old UPDATE silently
    // matched 0 rows and still handed back a turn_id.
    mockRunSql.mockResolvedValue("\n");
    await expect(appendTurn(CFG, TID, OWNER, TURN)).rejects.toThrow(
      /not found for this owner/,
    );
  });

  it("appendAudit resolves thread_id through sage_threads so a thread that was never created audits as NULL", async () => {
    mockRunSql.mockResolvedValue("");
    await appendAudit(CFG, {
      thread_id: TID,
      call_kind: "sql_gate",
      provider: "p",
      model: "m",
      prompt: {},
      output: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        latency_ms: 0,
        provider: "p",
        model: "m",
      },
      error_code: "SQL_EXECUTION_ERROR",
      error_message: "ERROR: boom",
    });
    const sql = mockRunSql.mock.calls[0]![0] as string;
    expect(sql).toContain(
      `(SELECT thread_id FROM sage_threads WHERE thread_id = '${TID}')`,
    );
    expect(sql).toContain("'sql_gate'");
  });

  it("appendAudit writes the prompt-cache token columns (audit #204)", async () => {
    mockRunSql.mockResolvedValue("");
    await appendAudit(CFG, {
      thread_id: null,
      call_kind: "router",
      provider: "p",
      model: "m",
      prompt: {},
      output: null,
      usage: {
        input_tokens: 3100,
        output_tokens: 40,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 7,
        cost_usd: 0.0018,
        latency_ms: 1,
        provider: "p",
        model: "m",
      },
      error_code: null,
      error_message: null,
    });
    const sql = (mockRunSql.mock.calls[0]![0] as string).replace(/\s+/g, " ");
    expect(sql).toContain(
      "input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd",
    );
    expect(sql).toContain("3100, 40, 3000, 7, 0.0018");
  });

  it("appendAudit returns a promise that rejects when the runner fails", async () => {
    mockRunSql.mockRejectedValue(new Error("Upstream query failed"));
    await expect(
      appendAudit(CFG, {
        thread_id: TID,
        call_kind: "router",
        provider: "p",
        model: "m",
        prompt: {},
        output: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          latency_ms: 0,
          provider: "p",
          model: "m",
        },
        error_code: null,
        error_message: null,
      }),
    ).rejects.toThrow("Upstream query failed");
  });
});

describe("getThreadHead (audit #88/#208)", () => {
  it("reads the count and only the last n turns in one query", async () => {
    const tail = [{ question: "a" }, { question: "b" }];
    mockRunSql.mockResolvedValue(JSON.stringify({ count: 7, tail }) + "\n");
    const head = await getThreadHead(CFG, TID, OWNER, 5);
    expect(head).toEqual({ turnCount: 7, lastTurns: tail });
    expect(mockRunSql).toHaveBeenCalledTimes(1);
    const sql = mockRunSql.mock.calls[0]![0] as string;
    expect(sql).toContain("jsonb_array_length(t)");
    expect(sql).toContain("WITH ORDINALITY");
    expect(sql).toContain("jsonb_array_length(t) - 5");
    expect(sql).toContain(`thread_id = '${TID}'`);
    expect(sql).toContain(`owner_sub = '${OWNER}'`);
  });

  it("an unknown or foreign thread (no row for this owner) is null", async () => {
    mockRunSql.mockResolvedValue("\n");
    expect(await getThreadHead(CFG, TID, OWNER, 5)).toBeNull();
  });
});

describe("getThread / deleteThread are owner-scoped (audit #11/#28)", () => {
  it("getThread filters on owner_sub and is null when no row matches", async () => {
    mockRunSql.mockResolvedValue("\n");
    expect(await getThread(CFG, TID, OWNER)).toBeNull();
    const sql = mockRunSql.mock.calls[0]![0] as string;
    expect(sql).toContain(`thread_id = '${TID}' AND owner_sub = '${OWNER}'`);

    mockRunSql.mockResolvedValue('[{"question":"a"}]\n');
    expect(await getThread(CFG, TID, OWNER)).toEqual([{ question: "a" }]);
  });

  it("deleteThread filters on owner_sub and reports whether a row went", async () => {
    mockRunSql.mockResolvedValue("0\n");
    expect(await deleteThread(CFG, TID, OWNER)).toBe(false);
    const sql = mockRunSql.mock.calls[0]![0] as string;
    expect(sql).toContain(`thread_id = '${TID}' AND owner_sub = '${OWNER}'`);

    mockRunSql.mockResolvedValue("1\n");
    expect(await deleteThread(CFG, TID, OWNER)).toBe(true);
  });
});
