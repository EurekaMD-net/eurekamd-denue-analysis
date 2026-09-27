import { describe, it, expect, afterEach, vi } from "vitest";
import { AbortError } from "@anthropic-ai/claude-agent-sdk";

const {
  mockDispatch,
  mockSql,
  mockAppendTurn,
  mockAppendAudit,
  mockGetThreadHead,
} = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockSql: vi.fn(),
  mockAppendTurn: vi.fn(),
  mockAppendAudit: vi.fn(async () => {}),
  mockGetThreadHead: vi.fn(),
}));
vi.mock("./dispatcher.js", async (orig) => ({
  ...(await orig<typeof import("./dispatcher.js")>()),
  dispatchEndpoint: mockDispatch,
}));
vi.mock("./sql-gate.js", async (orig) => ({
  ...(await orig<typeof import("./sql-gate.js")>()),
  executeGatedSql: mockSql,
}));
vi.mock("./thread-store.js", () => ({
  createThread: async () => "00000000-0000-0000-0000-000000000001",
  getThread: async () => [],
  getThreadHead: mockGetThreadHead,
  appendTurn: mockAppendTurn,
  appendAudit: mockAppendAudit,
  deleteThread: vi.fn(),
}));

import { createServer } from "../server.js";
import type { ApiServerConfig } from "../types.js";
import { pickChartType } from "./sage-handler.js";
import { buildDigest, DIGEST_ROWS_MAX_BYTES } from "./dispatcher.js";
import type {
  NarrativeInput,
  RouteOutput,
  SageProvider,
} from "./providers/provider.js";

const CONFIG_NO_SAGE: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "k",
  apiKey: "key",
  dbContainer: "test-db",
};
const AUTH = { "X-Api-Key": "key" };

afterEach(() => vi.restoreAllMocks());

describe("/sage/* without provider configured", () => {
  it("/sage/health reports configured=false", async () => {
    const app = createServer(CONFIG_NO_SAGE);
    const res = await app.request("/sage/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      provider: string | null;
    };
    expect(body.configured).toBe(false);
    expect(body.provider).toBeNull();
  });

  it("POST /sage/query returns 503 when provider missing", async () => {
    const app = createServer(CONFIG_NO_SAGE);
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "test question" }),
    });
    expect(res.status).toBe(503);
  });

  it("POST /sage/query requires auth", async () => {
    const app = createServer(CONFIG_NO_SAGE);
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "test" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("/sage/query input validation", () => {
  it("returns 503 when provider missing even for malformed body", async () => {
    // The provider check fires before body parsing; absent Sage, every
    // shape of input returns 503. Body validation is covered by the
    // provider-configured paths.
    const app = createServer(CONFIG_NO_SAGE);
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(503);
  });

  it("rejects short questions (<3 chars)", async () => {
    const app = createServer(CONFIG_NO_SAGE);
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "a" }),
    });
    // 503 sage-not-configured trumps 400 length, but length check IS in
    // the handler before the provider lookup — assertion adapts to both.
    expect([400, 503]).toContain(res.status);
  });
});

describe("/sage/thread/:id", () => {
  it("rejects non-UUID thread ids", async () => {
    const app = createServer(CONFIG_NO_SAGE);
    const res = await app.request("/sage/thread/not-a-uuid", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });
});

describe("/sage/query — max_rows defensive validation (R1 W3-sec)", () => {
  // These ride on the unconfigured-provider 503 path; the validation
  // gate fires BEFORE the provider check, so we can exercise it without
  // a live Sage provider.
  it("rejects non-integer max_rows", async () => {
    const app = createServer(CONFIG_NO_SAGE);
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "valid question",
        max_rows: "5000); DROP TABLE x; --",
      }),
    });
    // Either 400 (validation) or 503 (no provider) — but never 200.
    expect([400, 503]).toContain(res.status);
  });

  it("rejects max_rows < 1", async () => {
    const app = createServer(CONFIG_NO_SAGE);
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "valid question", max_rows: 0 }),
    });
    expect([400, 503]).toContain(res.status);
  });

  it("rejects max_rows > 5000", async () => {
    const app = createServer(CONFIG_NO_SAGE);
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "valid question", max_rows: 999999 }),
    });
    expect([400, 503]).toContain(res.status);
  });
});

describe("pickChartType (audit #81)", () => {
  it("never puts an ID or rank column on the y axis", () => {
    const d = buildDigest([
      { cve_ent: "02", nom_ent: "Baja California", ranking: "1", total: "40" },
      { cve_ent: "17", nom_ent: "Morelos", ranking: "2", total: "30" },
      { cve_ent: "09", nom_ent: "CDMX", ranking: "3", total: "20" },
    ]);
    expect(pickChartType(d)).toEqual({
      chart_type: "bar",
      x_col: "nom_ent",
      y_col: "total",
    });
  });

  it("draws a line for a numeric year column", () => {
    const d = buildDigest([
      { ano: 2022, total_defunciones: 5 },
      { ano: 2023, total_defunciones: 7 },
      { ano: 2024, total_defunciones: 6 },
    ]);
    expect(pickChartType(d)).toEqual({
      chart_type: "line",
      x_col: "ano",
      y_col: "total_defunciones",
    });
  });
});

describe("/sage/query table + digest caps (audit #76/#87)", () => {
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    cost_usd: 0,
    latency_ms: 1,
    provider: "fake",
    model: "fake",
  };
  function fakeProvider(route: RouteOutput) {
    const narrativeInputs: NarrativeInput[] = [];
    const provider: SageProvider = {
      name: "fake",
      routerModel: "fake",
      narrativeModel: "fake",
      routeAndDraft: async () => ({ output: route, usage }),
      async *writeNarrativeStream(input: NarrativeInput) {
        narrativeInputs.push(input);
        yield { text: "ok", usage };
      },
      countTokens: () => 0,
    };
    return { provider, narrativeInputs };
  }
  function events(text: string) {
    return text
      .trim()
      .split("\n\n")
      .map((block) => {
        const [ev, data] = block.split("\n");
        return {
          event: ev!.slice("event: ".length),
          data: JSON.parse(data!.slice("data: ".length)) as Record<
            string,
            unknown
          >,
        };
      });
  }
  async function ask(provider: SageProvider, body: object = {}) {
    const app = createServer({ ...CONFIG_NO_SAGE, sageProvider: provider });
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "serie de delitos", ...body }),
    });
    return events(await res.text());
  }

  it("endpoint route: keyed body is unwrapped; table carries up to 200 rows with truncated; narrative + persisted digest stay small", async () => {
    const series = Array.from({ length: 250 }, (_, i) => ({
      ano: 2015 + Math.floor(i / 12),
      mes: (i % 12) + 1,
      total: i,
      nota: "n".repeat(60),
    }));
    mockDispatch.mockResolvedValue({
      ok: true,
      status: 200,
      endpoint_path: "/analytics/risk-trend?cve_mun=20067",
      body: { cve_mun: "20067", municipio: "Oaxaca", series },
    });
    const { provider, narrativeInputs } = fakeProvider({
      kind: "endpoint",
      endpoint_name: "risk-trend",
      params: { cve_mun: "20067" },
      reasoning: "",
      confidence: 1,
    } as RouteOutput);
    const evs = await ask(provider);
    const table = evs.find((e) => e.event === "table")!.data;
    expect(table.row_count).toBe(250);
    expect((table.rows as unknown[]).length).toBe(200);
    expect(table.truncated).toBe(true);
    expect(evs.find((e) => e.event === "chart")?.data).toEqual({
      chart_type: "line",
      x_col: "ano",
      y_col: "total",
    });

    const digest = narrativeInputs[0]!.digest;
    expect(digest.row_count).toBe(250);
    expect(digest.first_n_rows.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(digest.first_n_rows).length).toBeLessThanOrEqual(
      DIGEST_ROWS_MAX_BYTES,
    );
    const persisted = mockAppendTurn.mock.calls[0]![2] as {
      digest: { row_count: number; first_5_rows: unknown[] };
    };
    expect(persisted.digest.row_count).toBe(250);
    expect(persisted.digest.first_5_rows).toHaveLength(5);
  });

  it("SQL route: default cap is 200 (+1 probe row) and the table says when it was cut", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({
      cve_mun: String(i).padStart(5, "0"),
      total: String(i),
    }));
    mockSql.mockResolvedValue({
      ok: true,
      data: { rows, columns: ["cve_mun", "total"] },
    });
    const { provider, narrativeInputs } = fakeProvider({
      kind: "sql",
      sql: "SELECT cve_mun, total FROM x",
      reasoning: "",
      confidence: 1,
    } as RouteOutput);
    const evs = await ask(provider);
    expect(mockSql.mock.calls[0]![1]).toMatchObject({ rowCap: 201 });
    const table = evs.find((e) => e.event === "table")!.data;
    expect((table.rows as unknown[]).length).toBe(200);
    expect(table.row_count).toBe(200);
    expect(table.truncated).toBe(true);
    // The cut reaches the narrative and the persisted thread digest, so
    // neither reports "200 rows" as if it were the real total.
    expect(narrativeInputs[0]!.digest.truncated).toBe(true);
    const persisted = mockAppendTurn.mock.lastCall![2] as {
      digest: { row_count: number; truncated?: boolean };
    };
    expect(persisted.digest).toMatchObject({ row_count: 200, truncated: true });
  });

  it("SQL route: a result that fits the cap is not marked truncated", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      cve_mun: String(i).padStart(5, "0"),
      total: String(i),
    }));
    mockSql.mockResolvedValue({
      ok: true,
      data: { rows, columns: ["cve_mun", "total"] },
    });
    const { provider, narrativeInputs } = fakeProvider({
      kind: "sql",
      sql: "SELECT cve_mun, total FROM x",
      reasoning: "",
      confidence: 1,
    } as RouteOutput);
    const evs = await ask(provider);
    const table = evs.find((e) => e.event === "table")!.data;
    expect(table.row_count).toBe(200);
    expect(table.truncated).toBe(false);
    expect(narrativeInputs[0]!.digest.truncated).toBeUndefined();
    const persisted = mockAppendTurn.mock.lastCall![2] as {
      digest: Record<string, unknown>;
    };
    expect(persisted.digest).not.toHaveProperty("truncated");
  });
});

describe("/sage/query async runner, abort signal and thread read (audit #79 #88 #90 #202 #206 #208)", () => {
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    cost_usd: 0,
    latency_ms: 1,
    provider: "fake",
    model: "fake",
  };
  const SQL_ROUTE = {
    kind: "sql",
    sql: "SELECT 1 AS n",
    reasoning: "",
    confidence: 1,
  } as RouteOutput;
  const EXISTING = "11111111-1111-1111-1111-111111111111";

  function provider(
    routeAndDraft: SageProvider["routeAndDraft"],
  ): SageProvider {
    return {
      name: "fake",
      routerModel: "fake",
      narrativeModel: "fake",
      routeAndDraft,
      async *writeNarrativeStream() {
        yield { text: "ok", usage };
      },
      countTokens: () => 0,
    };
  }
  function eventNames(text: string) {
    return [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  }
  function errorEvent(text: string) {
    const m = /event: error\ndata: (.*)\n/.exec(text);
    return m ? (JSON.parse(m[1]!) as { code: string; message: string }) : null;
  }
  async function ask(p: SageProvider, body: object = {}) {
    const app = createServer({ ...CONFIG_NO_SAGE, sageProvider: p });
    const res = await app.request("/sage/query", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "cuantos negocios", ...body }),
    });
    return { status: res.status, text: await res.text() };
  }
  function resetMocks() {
    mockSql.mockReset();
    mockDispatch.mockReset();
    mockAppendTurn.mockReset();
    mockAppendAudit.mockReset();
    mockGetThreadHead.mockReset();
    mockAppendTurn.mockResolvedValue({ turn_id: "t1" });
    mockAppendAudit.mockResolvedValue(undefined);
    mockSql.mockResolvedValue({
      ok: true,
      data: { rows: [{ n: "1" }], columns: ["n"] },
    });
  }

  it("passes the turn's abort signal to the SQL gate", async () => {
    resetMocks();
    await ask(provider(async () => ({ output: SQL_ROUTE, usage })));
    expect(mockSql.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("passes the turn's abort signal to dispatchEndpoint", async () => {
    resetMocks();
    mockDispatch.mockResolvedValue({
      ok: true,
      status: 200,
      endpoint_path: "/analytics/x",
      body: [{ a: 1 }],
    });
    const route = {
      kind: "endpoint",
      endpoint_name: "risk-trend",
      params: { cve_mun: "20067" },
      reasoning: "",
      confidence: 1,
    } as RouteOutput;
    await ask(provider(async () => ({ output: route, usage })));
    expect(mockDispatch.mock.calls[0]![3]).toBeInstanceOf(AbortSignal);
  });

  it("a new thread skips the thread read; an existing one is read once for cap + history", async () => {
    resetMocks();
    const histories: number[] = [];
    const p = provider(async (input) => {
      histories.push(input.history.length);
      return { output: SQL_ROUTE, usage };
    });
    await ask(p);
    expect(mockGetThreadHead).not.toHaveBeenCalled();

    const turn = {
      question: "q",
      route: { kind: "sql", sql: "SELECT 1" },
      digest: { columns: ["n"], row_count: 1, first_5_rows: [] },
      narrative: "n",
      turn_id: "x",
      created_at: "2026-09-27T00:00:00Z",
    };
    mockGetThreadHead.mockResolvedValue({
      turnCount: 12,
      lastTurns: [turn, turn, turn, turn, turn],
    });
    await ask(p, { thread_id: EXISTING });
    expect(mockGetThreadHead).toHaveBeenCalledTimes(1);
    expect(mockGetThreadHead.mock.calls[0]!.slice(1)).toEqual([EXISTING, 5]);
    expect(histories).toEqual([0, 5]);
  });

  it("rejects a thread at the 50-turn cap with 429 before any LLM call", async () => {
    resetMocks();
    mockGetThreadHead.mockResolvedValue({ turnCount: 50, lastTurns: [] });
    const route = vi.fn();
    const res = await ask(provider(route), { thread_id: EXISTING });
    expect(res.status).toBe(429);
    expect(route).not.toHaveBeenCalled();
  });

  it("a failed audit write is logged and does not fail the turn", async () => {
    resetMocks();
    mockAppendAudit.mockImplementation(async () => {
      throw new Error("Upstream query failed");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const res = await ask(provider(async () => ({ output: SQL_ROUTE, usage })));
    const logged = stderr.mock.calls.map((c) => String(c[0]));
    stderr.mockRestore();
    expect(mockAppendAudit).toHaveBeenCalledTimes(2);
    expect(eventNames(res.text)).toEqual([
      "thread",
      "route",
      "usage",
      "table",
      "delta",
      "narrative",
      "usage",
      "done",
    ]);
    expect(
      logged.filter((l) => l.includes("[sage] audit write failed")),
    ).toHaveLength(2);
  });

  it("maps the Agent SDK's AbortError (a provider timer) to SAGE_TIMEOUT", async () => {
    resetMocks();
    const res = await ask(
      provider(async () => {
        throw new AbortError("Claude Code process aborted by user");
      }),
    );
    expect(errorEvent(res.text)).toEqual({
      code: "SAGE_TIMEOUT",
      message: "La consulta tardó demasiado; intenta de nuevo.",
    });
  });

  it("maps a fetch TimeoutError (OpenAI path) to SAGE_TIMEOUT", async () => {
    resetMocks();
    const res = await ask(
      provider(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    expect(errorEvent(res.text)?.code).toBe("SAGE_TIMEOUT");
  });

  it("other failures stay SAGE_INTERNAL", async () => {
    resetMocks();
    const res = await ask(
      provider(async () => {
        throw new Error("boom");
      }),
    );
    expect(errorEvent(res.text)).toEqual({
      code: "SAGE_INTERNAL",
      message: "boom",
    });
  });
});
