import { describe, it, expect, beforeEach, vi } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import type { Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";

const mocks = vi.hoisted(() => ({
  capturedOptions: [] as SdkOptions[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (config: unknown) => ({ type: "sdk", config }),
  tool: (...args: unknown[]) => ({ args }),
  query: ({ options }: { options: SdkOptions }) => {
    mocks.capturedOptions.push(options);
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
