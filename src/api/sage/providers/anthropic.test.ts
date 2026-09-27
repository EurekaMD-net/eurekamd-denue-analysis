import { describe, it, expect, beforeEach, vi } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import { sageUsageOf } from "./provider.js";
import type { Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";

const mocks = vi.hoisted(() => ({
  capturedOptions: [] as SdkOptions[],
  stream: null as null | (() => AsyncGenerator<unknown>),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (config: unknown) => ({ type: "sdk", config }),
  tool: (...args: unknown[]) => ({ args }),
  query: ({ options }: { options: SdkOptions }) => {
    mocks.capturedOptions.push(options);
    if (mocks.stream) return mocks.stream();
    // Empty stream — both call sites tolerate a result-less iteration.
    return (async function* () {})();
  },
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
