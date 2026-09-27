import { describe, it, expect, beforeEach, vi } from "vitest";
import { AnthropicProvider, fallbackPrice, sdkEnv } from "./anthropic.js";
import { sageUsageOf } from "./provider.js";
import { ROUTER_SYSTEM_PROMPT } from "./prompts.js";
import { SAGE_ENDPOINT_CATALOG } from "../endpoint-catalog.js";
import type { Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";

const mocks = vi.hoisted(() => ({
  capturedOptions: [] as SdkOptions[],
  capturedPrompts: [] as unknown[],
  stream: null as null | ((options: SdkOptions) => AsyncGenerator<unknown>),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
  createSdkMcpServer: (config: unknown) => ({ type: "sdk", config }),
  tool: (...args: unknown[]) => ({ args }),
  query: ({ prompt, options }: { prompt: unknown; options: SdkOptions }) => {
    mocks.capturedOptions.push(options);
    mocks.capturedPrompts.push(prompt);
    if (mocks.stream) return mocks.stream(options);
    // Empty stream — both call sites tolerate a result-less iteration.
    return (async function* () {})();
  },
}));

// The resolver probes the host's filesystem; pin its answer so the
// assertion below checks the wiring, not this machine's layout.
vi.mock("./claude-executable.js", () => ({
  resolveClaudeExecutable: () => "/test/claude-agent-sdk-linux-x64/claude",
}));

// Spec pin: settingSources MUST be explicitly []. With it unset the SDK
// loads the host user's ~/.claude/CLAUDE.md + rules + memory into every
// call (omitted !== none). Discovered live 2026-07-12; do not remove.
describe("AnthropicProvider — SDK isolation (settingSources)", () => {
  const provider = new AnthropicProvider({
    routerModel: "claude-sonnet-4-6",
    narrativeModel: "claude-sonnet-4-6",
  });

  beforeEach(() => {
    mocks.capturedOptions.length = 0;
  });

  it("router call passes settingSources: []", async () => {
    await provider.routeAndDraft({
      question: "¿Cuántas unidades hay?",
      endpoints: [],
      history: [],
      sql_schema_summary: "",
    });
    expect(mocks.capturedOptions).toHaveLength(1);
    expect(mocks.capturedOptions[0].settingSources).toEqual([]);
    expect(mocks.capturedOptions[0].pathToClaudeCodeExecutable).toBe(
      "/test/claude-agent-sdk-linux-x64/claude",
    );
  });

  it("narrative call passes settingSources: []", async () => {
    const stream = provider.writeNarrativeStream({
      question: "¿Cuántas unidades hay?",
      route: { kind: "endpoint", endpoint_name: "x" },
      digest: { columns: [], row_count: 0, first_n_rows: [] },
      history: [],
    });
    for await (const _chunk of stream) {
      // drain
    }
    expect(mocks.capturedOptions).toHaveLength(1);
    expect(mocks.capturedOptions[0].settingSources).toEqual([]);
    expect(mocks.capturedOptions[0].pathToClaudeCodeExecutable).toBe(
      "/test/claude-agent-sdk-linux-x64/claude",
    );
  });
});

describe("AnthropicProvider — usage survives a thrown call (audit #83)", () => {
  const provider = new AnthropicProvider({
    routerModel: "claude-sonnet-4-6",
    narrativeModel: "claude-sonnet-4-6",
  });

  beforeEach(() => {
    mocks.capturedOptions.length = 0;
    mocks.stream = null;
  });

  it("a router call aborted before its result carries an input estimate", async () => {
    mocks.stream = async function* () {
      throw new Error("Claude Code process aborted by user");
    };
    const err = await provider
      .routeAndDraft({
        question: "¿Cuántas unidades hay?",
        endpoints: [],
        history: [],
        sql_schema_summary: "",
      })
      .catch((e: unknown) => e);
    const usage = sageUsageOf(err);
    expect(usage).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      output_tokens: 0,
    });
    expect(usage!.input_tokens).toBeGreaterThan(0);
    expect(usage!.cost_usd).toBeGreaterThan(0);
  });

  it("a narrative cut mid-stream carries the text it had streamed", async () => {
    mocks.stream = async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hay 1234 unidades" }] },
      };
      throw new Error("Claude Code process aborted by user");
    };
    const chunks: string[] = [];
    const err = await (async () => {
      for await (const c of provider.writeNarrativeStream({
        question: "q",
        route: { kind: "endpoint", endpoint_name: "x" },
        digest: { columns: [], row_count: 0, first_n_rows: [] },
        history: [],
      })) {
        chunks.push(c.text);
      }
    })().catch((e: unknown) => e);
    expect(chunks).toEqual(["Hay 1234 unidades"]);
    expect(sageUsageOf(err)).toMatchObject({
      model: "claude-sonnet-4-6",
      output_tokens: Math.ceil("Hay 1234 unidades".length / 4),
    });
  });
});

// The fake SDK's tool() keeps its args: [name, description, schema, handler].
type Handler = (args: Record<string, unknown>) => Promise<unknown>;
function handler(options: SdkOptions, name: string): Handler {
  const server = options.mcpServers!["sage_router"] as unknown as {
    config: { tools: Array<{ args: unknown[] }> };
  };
  const t = server.config.tools.find((x) => x.args[0] === name)!;
  return t.args[3] as Handler;
}
const ROUTE_INPUT = {
  question: "¿Cuántas farmacias hay en Monterrey?",
  endpoints: SAGE_ENDPOINT_CATALOG,
  history: [],
  sql_schema_summary: "VIEW v_demo (cve_mun text)",
};

describe("AnthropicProvider router — one model call per turn (audit #78 #200)", () => {
  const provider = new AnthropicProvider({
    routerModel: "claude-sonnet-4-6",
    narrativeModel: "claude-sonnet-4-6",
  });

  beforeEach(() => {
    mocks.capturedOptions.length = 0;
    mocks.capturedPrompts.length = 0;
    mocks.stream = null;
  });

  it("returns after the first tool call: first call wins, no second turn, usage from the first assistant message, output floored at the tool call", async () => {
    let secondTurn = false;
    let abortedAtHandler = false;
    mocks.stream = async function* (options) {
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__sage_router__call_endpoint" },
          ],
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 3000,
            cache_creation_input_tokens: 0,
            // The real CLI aborts before message_delta: only message_start's
            // placeholder output count reaches the router.
            output_tokens: 1,
          },
        },
      };
      // Parallel tool_use in the same turn: both handlers run.
      await handler(
        options,
        "call_endpoint",
      )({
        endpoint_name: "pharmacies",
        params: { cve_mun: "19039" },
        reasoning: "r",
        confidence: 0.9,
      });
      abortedAtHandler = options.abortController!.signal.aborted;
      await handler(options, "decline")({ reasoning: "no" });
      yield { type: "user", message: { content: [] } };
      secondTurn = true;
      yield { type: "assistant", message: { content: [], usage: {} } };
      yield {
        type: "result",
        subtype: "success",
        result: "",
        usage: { input_tokens: 99999, output_tokens: 1 },
        total_cost_usd: 9,
      };
    };
    const res = await provider.routeAndDraft(ROUTE_INPUT);
    expect(res.output).toEqual({
      kind: "endpoint",
      endpoint_name: "pharmacies",
      params: { cve_mun: "19039" },
      reasoning: "r",
      confidence: 0.9,
    });
    expect(secondTurn).toBe(false);
    expect(abortedAtHandler).toBe(true);
    expect(mocks.capturedOptions[0]!.maxTurns).toBe(1);
    // Floor: approximateTokens(JSON.stringify(captured tool call)).
    const outTok = Math.ceil(JSON.stringify(res.output).length / 4);
    expect(outTok).toBeGreaterThan(1);
    expect(res.usage).toMatchObject({
      input_tokens: 3100,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 0,
      output_tokens: outTok,
    });
    // 100 x $3 + 3000 x $0.30 (cache read) + outTok x $15, per million.
    expect(res.usage.cost_usd).toBeCloseTo(
      (100 * 3 + 3000 * 0.3 + outTok * 15) / 1e6,
      10,
    );
  });

  it("the SDK's abort throw after the first tool call is the success path", async () => {
    mocks.stream = async function* (options) {
      await handler(
        options,
        "draft_sql",
      )({
        sql: "SELECT 1",
        reasoning: "r",
        confidence: 1,
      });
      throw new Error("Claude Code process aborted by user");
    };
    const res = await provider.routeAndDraft(ROUTE_INPUT);
    expect(res.output).toMatchObject({ kind: "sql", sql: "SELECT 1" });
    expect(res.usage.input_tokens).toBeGreaterThan(0);
  });
});

describe("AnthropicProvider router — no tool call is explicit (audit #84)", () => {
  const provider = new AnthropicProvider({
    routerModel: "claude-sonnet-4-6",
    narrativeModel: "claude-sonnet-4-6",
  });

  beforeEach(() => {
    mocks.capturedOptions.length = 0;
    mocks.stream = null;
  });

  it("a text-only reply becomes a clarify carrying the model's text", async () => {
    mocks.stream = async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "¿Te refieres al estado o al municipio?",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.001,
      };
    };
    const res = await provider.routeAndDraft(ROUTE_INPUT);
    expect(res.output).toEqual({
      kind: "clarify",
      reasoning: "¿Te refieres al estado o al municipio?",
    });
    expect(res.usage.cost_usd).toBe(0.001);
  });

  it("an SDK error result before any tool is ROUTER_SDK_ERROR with its total_cost_usd", async () => {
    mocks.stream = async function* () {
      yield {
        type: "result",
        subtype: "error_max_turns",
        errors: ["max turns reached"],
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.004,
      };
    };
    const res = await provider.routeAndDraft(ROUTE_INPUT);
    expect(res.output).toMatchObject({
      kind: "error",
      code: "ROUTER_SDK_ERROR",
    });
    expect((res.output as { detail: string }).detail).toContain(
      "error_max_turns",
    );
    expect(res.usage.cost_usd).toBe(0.004);
  });

  it("no tool call and no text is ROUTER_NO_TOOL, not a placeholder decline", async () => {
    const res = await provider.routeAndDraft(ROUTE_INPUT);
    expect(res.output).toMatchObject({ kind: "error", code: "ROUTER_NO_TOOL" });
  });
});

describe("AnthropicProvider router — cacheable static prompt (audit #204)", () => {
  const provider = new AnthropicProvider({
    routerModel: "claude-sonnet-4-6",
    narrativeModel: "claude-sonnet-4-6",
  });

  it("catalog and schema sit in the system prompt before the boundary; the user message is history + question only", async () => {
    mocks.capturedOptions.length = 0;
    mocks.capturedPrompts.length = 0;
    mocks.stream = null;
    await provider.routeAndDraft(ROUTE_INPUT);
    const sys = mocks.capturedOptions[0]!.systemPrompt as string[];
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[0]).toBe(ROUTER_SYSTEM_PROMPT);
    expect(sys.at(-1)).toBe("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
    const staticPart = sys.slice(0, -1).join("\n");
    expect(staticPart).toContain(`**${SAGE_ENDPOINT_CATALOG[0]!.name}**`);
    expect(staticPart).toContain("VIEW v_demo (cve_mun text)");
    expect(staticPart).not.toContain(ROUTE_INPUT.question);
    const prompt = mocks.capturedPrompts[0] as string;
    expect(prompt).toContain(ROUTE_INPUT.question);
    expect(prompt).not.toContain("# Available endpoints");
    expect(prompt).not.toContain("VIEW v_demo");
  });
});

describe("AnthropicProvider narrative — real streaming (audit #203 #91)", () => {
  const provider = new AnthropicProvider({
    routerModel: "claude-sonnet-4-6",
    narrativeModel: "claude-sonnet-4-6",
  });
  const NARR = {
    question: "q",
    route: { kind: "endpoint" as const, endpoint_name: "x" },
    digest: { columns: [], row_count: 0, first_n_rows: [] },
    history: [],
  };

  beforeEach(() => {
    mocks.capturedOptions.length = 0;
    mocks.stream = null;
  });

  it("asks for partial messages and yields each text_delta once", async () => {
    const delta = (text: string) => ({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    });
    mocks.stream = async function* () {
      yield { type: "stream_event", event: { type: "message_start" } };
      yield delta("Hay ");
      yield delta("1234 unidades");
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hay 1234 unidades" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 50,
          cache_read_input_tokens: 500,
          output_tokens: 8,
        },
        total_cost_usd: 0.0021,
      };
    };
    const chunks: string[] = [];
    let last = null as null | {
      cost_usd: number;
      cache_read_input_tokens?: number;
    };
    for await (const c of provider.writeNarrativeStream(NARR)) {
      if (c.text) chunks.push(c.text);
      if (c.usage) last = c.usage;
    }
    expect(mocks.capturedOptions[0]!.includePartialMessages).toBe(true);
    expect(chunks).toEqual(["Hay ", "1234 unidades"]);
    expect(last).toMatchObject({
      cost_usd: 0.0021,
      cache_read_input_tokens: 500,
    });
  });

  it("an error result is costed from its total_cost_usd, not the fallback table", async () => {
    mocks.stream = async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        errors: ["boom"],
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
        total_cost_usd: 0.05,
      };
    };
    let usage = null as null | { cost_usd: number };
    for await (const c of provider.writeNarrativeStream(NARR)) {
      if (c.usage) usage = c.usage;
    }
    expect(usage!.cost_usd).toBe(0.05);
  });
});

describe("fallbackPrice (audit #91 #210)", () => {
  const M = 1_000_000;
  it("prices base input, cache write (1.25x) and cache read (0.1x) separately", () => {
    expect(fallbackPrice("claude-sonnet-4-6", { input_tokens: M })).toBeCloseTo(
      3,
    );
    expect(
      fallbackPrice("claude-sonnet-4-6", { cache_creation_input_tokens: M }),
    ).toBeCloseTo(3.75);
    expect(
      fallbackPrice("claude-sonnet-4-6", { cache_read_input_tokens: M }),
    ).toBeCloseTo(0.3);
    expect(
      fallbackPrice("claude-sonnet-4-6", { output_tokens: M }),
    ).toBeCloseTo(15);
  });

  it("has current Opus 4.7 prices and the Haiku 4.5 alias", () => {
    expect(fallbackPrice("claude-opus-4-7", { input_tokens: M })).toBeCloseTo(
      5,
    );
    expect(fallbackPrice("claude-opus-4-7", { output_tokens: M })).toBeCloseTo(
      25,
    );
    expect(fallbackPrice("claude-haiku-4-5", { input_tokens: M })).toBeCloseTo(
      1,
    );
  });

  it("warns once on a model it cannot price", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(fallbackPrice("claude-unknown-9", { input_tokens: M })).toBe(0);
    expect(fallbackPrice("claude-unknown-9", { input_tokens: M })).toBe(0);
    const warns = write.mock.calls.filter((c) =>
      String(c[0]).includes("claude-unknown-9"),
    );
    write.mockRestore();
    expect(warns).toHaveLength(1);
  });
});

describe("SDK child env is allowlisted (audit #30)", () => {
  it("sdkEnv keeps PATH, HOME and the auth variables only", () => {
    expect(
      sdkEnv({
        PATH: "/usr/bin",
        HOME: "/root",
        CLAUDE_CODE_OAUTH_TOKEN: "t",
        ANTHROPIC_BASE_URL: "https://a.test",
        SUPABASE_SERVICE_KEY: "s",
        SUPABASE_JWT_SECRET: "j",
        API_KEY: "k",
        DENUE_TOKEN: "d",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/root",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
      ANTHROPIC_BASE_URL: "https://a.test",
    });
  });

  it("router and narrative calls never pass application secrets", async () => {
    vi.stubEnv("SUPABASE_SERVICE_KEY", "test-not-a-secret");
    vi.stubEnv("API_KEY", "test-not-a-secret");
    mocks.capturedOptions.length = 0;
    mocks.stream = null;
    const provider = new AnthropicProvider({
      routerModel: "claude-sonnet-4-6",
      narrativeModel: "claude-sonnet-4-6",
    });
    await provider.routeAndDraft(ROUTE_INPUT);
    for await (const _c of provider.writeNarrativeStream({
      question: "q",
      route: { kind: "endpoint", endpoint_name: "x" },
      digest: { columns: [], row_count: 0, first_n_rows: [] },
      history: [],
    })) {
      // drain
    }
    vi.unstubAllEnvs();
    expect(mocks.capturedOptions).toHaveLength(2);
    for (const o of mocks.capturedOptions) {
      expect(o.env).not.toHaveProperty("SUPABASE_SERVICE_KEY");
      expect(o.env).not.toHaveProperty("API_KEY");
      expect(o.env).toHaveProperty("PATH");
    }
  });
});
