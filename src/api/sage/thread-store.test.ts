import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunSql } = vi.hoisted(() => ({ mockRunSql: vi.fn() }));
vi.mock("../db/psql-runner.js", () => ({ runSql: mockRunSql }));

import { appendAudit, appendTurn, getThreadHead } from "./thread-store.js";

const CFG = { dbContainer: "supabase-db" };
const TID = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  mockRunSql.mockReset();
});

describe("thread-store on the async runner (audit #79/#104)", () => {
  it("writes through runSql with a 10 s timeout and a writable session", async () => {
    mockRunSql.mockResolvedValue("");
    await appendTurn(CFG, TID, {
      question: "q",
      route: { kind: "sql", sql: "SELECT 1" },
      digest: { columns: [], row_count: 0, first_5_rows: [] },
      narrative: "n",
    });
    expect(mockRunSql).toHaveBeenCalledTimes(1);
    expect(mockRunSql.mock.calls[0]![1]).toEqual({
      container: "supabase-db",
      readOnly: false,
      timeoutMs: 10_000,
    });
    expect(mockRunSql.mock.calls[0]![0]).toContain("pg_advisory_xact_lock");
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
    const head = await getThreadHead(CFG, TID, 5);
    expect(head).toEqual({ turnCount: 7, lastTurns: tail });
    expect(mockRunSql).toHaveBeenCalledTimes(1);
    const sql = mockRunSql.mock.calls[0]![0] as string;
    expect(sql).toContain("jsonb_array_length(t)");
    expect(sql).toContain("WITH ORDINALITY");
    expect(sql).toContain("jsonb_array_length(t) - 5");
    expect(sql).toContain(`thread_id = '${TID}'`);
  });

  it("an unknown thread (no row) is empty", async () => {
    mockRunSql.mockResolvedValue("\n");
    expect(await getThreadHead(CFG, TID, 5)).toEqual({
      turnCount: 0,
      lastTurns: [],
    });
  });
});
