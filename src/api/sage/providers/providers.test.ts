import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildSageProvider } from "./index.js";
import {
  buildRouterUserPrompt,
  buildNarrativeUserPrompt,
  NARRATIVE_ROWS_MAX_BYTES,
  ROUTER_SYSTEM_PROMPT,
} from "./prompts.js";
import { SAGE_ENDPOINT_CATALOG } from "../endpoint-catalog.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { sageUsageOf } from "./provider.js";

describe("buildSageProvider — factory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns AnthropicProvider when SAGE_PROVIDER=anthropic", () => {
    // Anthropic provider authenticates via ~/.claude/.credentials.json
    // (Claude Agent SDK OAuth) — no API key needed in env.
    const p = buildSageProvider({
      SAGE_PROVIDER: "anthropic",
      SAGE_MODEL_ROUTER: "claude-sonnet-4-6",
      SAGE_MODEL_NARRATIVE: "claude-sonnet-4-6",
    });
    expect(p.name).toBe("anthropic");
    expect(p.routerModel).toBe("claude-sonnet-4-6");
  });

  it("defaults router/narrative models to Sonnet 4.6 for anthropic", () => {
    const p = buildSageProvider({ SAGE_PROVIDER: "anthropic" });
    expect(p.routerModel).toBe("claude-sonnet-4-6");
    expect(p.narrativeModel).toBe("claude-sonnet-4-6");
  });

  it("Anthropic provider is the default when SAGE_PROVIDER is unset", () => {
    const p = buildSageProvider({});
    expect(p.name).toBe("anthropic");
  });

  it("returns OpenAICompatibleProvider for openai-compatible", () => {
    const p = buildSageProvider({
      SAGE_PROVIDER: "openai-compatible",
      SAGE_BASE_URL: "https://api.groq.com/openai/v1",
      SAGE_API_KEY: "gsk_test",
      SAGE_MODEL_ROUTER: "llama-3.3-70b-versatile",
      SAGE_MODEL_NARRATIVE: "qwen3-32b",
    });
    expect(p.name).toMatch(/^openai-compat/);
    expect(p.routerModel).toBe("llama-3.3-70b-versatile");
    expect(p.narrativeModel).toBe("qwen3-32b");
  });

  it("openai-compatible requires explicit router + narrative models", () => {
    expect(() =>
      buildSageProvider({
        SAGE_PROVIDER: "openai-compatible",
        SAGE_BASE_URL: "https://a/b",
        SAGE_API_KEY: "k",
      }),
    ).toThrow(/SAGE_MODEL_ROUTER/);
  });

  it("rejects unknown provider names", () => {
    expect(() =>
      buildSageProvider({ SAGE_PROVIDER: "definitely-not-real" }),
    ).toThrow(/Unknown SAGE_PROVIDER/);
  });
});

describe("buildRouterUserPrompt — params schema (audit #86)", () => {
  it("tells the model which params are required", () => {
    const p = buildRouterUserPrompt("q", SAGE_ENDPOINT_CATALOG, [], "");
    const line = p
      .split("\n\n")
      .find((s) => s.startsWith("- **opportunity-by-ageb**"));
    expect(line).toContain('"required":["cve_mun","target_scian"]');
  });
});

describe("buildNarrativeUserPrompt — rows block (audit #209/#76)", () => {
  const route = { kind: "endpoint", endpoint_name: "municipios" };

  it("renders rows as CSV with one header line, not pretty JSON", () => {
    const p = buildNarrativeUserPrompt(
      "q",
      route,
      {
        columns: ["municipio", "total"],
        row_count: 2,
        first_n_rows: [
          { municipio: "Oaxaca, centro", total: 10 },
          { municipio: "Tlaxiaco", total: null },
        ],
        context: { entidad: "20" },
      },
      [],
    );
    expect(p).toContain(
      '```csv\nmunicipio,total\n"Oaxaca, centro",10\nTlaxiaco,\n```',
    );
    expect(p).toContain('Context: {"entidad":"20"}');
    expect(p).not.toContain('\n  {\n    "municipio"');
  });

  it("hard-caps the rows block whatever digest it is handed", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      txt: "z".repeat(100),
    }));
    const p = buildNarrativeUserPrompt(
      "q",
      route,
      { columns: ["id", "txt"], row_count: 500, first_n_rows: rows },
      [],
    );
    const block = p.split("```csv\n")[1]!.split("\n```")[0]!;
    expect(block.length).toBeLessThanOrEqual(
      NARRATIVE_ROWS_MAX_BYTES + "… (truncated)".length,
    );
    expect(block.endsWith("… (truncated)")).toBe(true);
  });
});

describe("row cap is visible to the model (audit #87 follow-up)", () => {
  const route = { kind: "sql", sql: "SELECT nom_mun FROM x" };
  const prior = {
    question: "lista municipios de Oaxaca",
    route: { kind: "sql" as const, sql: "SELECT nom_mun FROM x" },
    digest: {
      columns: ["nom_mun"],
      row_count: 200,
      first_5_rows: [],
      truncated: true,
    },
    narrative: "n",
  };

  it("narrative prompt says a cut result's row count is a floor", () => {
    const p = buildNarrativeUserPrompt(
      "¿cuántos municipios tiene Oaxaca?",
      route,
      {
        columns: ["nom_mun"],
        row_count: 200,
        first_n_rows: [{ nom_mun: "Tlaxiaco" }],
        truncated: true,
      },
      [prior],
    );
    expect(p).toContain("Row count: 200+ (cut at the 200-row cap");
    expect(p).not.toContain("Row count: 200\n");
    expect(p).toContain("→ 200+ rows");
  });

  it("narrative prompt keeps a plain count when the result was not cut", () => {
    const p = buildNarrativeUserPrompt(
      "q",
      route,
      { columns: ["nom_mun"], row_count: 12, first_n_rows: [] },
      [],
    );
    expect(p).toContain("Row count: 12\n");
  });

  it("router history marks a cut prior result as N+ rows", () => {
    const p = buildRouterUserPrompt("q", SAGE_ENDPOINT_CATALOG, [prior], "");
    expect(p).toContain("Result: 200+ rows");
  });

  it("router system prompt states the 200-row cap and steers counts to COUNT(*)", () => {
    expect(ROUTER_SYSTEM_PROMPT).toContain("cut at 200 rows");
    expect(ROUTER_SYSTEM_PROMPT).toContain("COUNT(*)");
    expect(ROUTER_SYSTEM_PROMPT).not.toContain("max 5000");
  });
});

describe("a failed turn reaches the next router prompt (audit #89)", () => {
  it("renders the persisted error code and message", () => {
    const prompt = buildRouterUserPrompt(
      "¿y en 2023?",
      [],
      [
        {
          question: "q",
          route: { kind: "sql", sql: "SELECT nope" },
          digest: { columns: [], row_count: 0, first_5_rows: [] },
          narrative: "",
          error: { code: "SQL_EXECUTION_ERROR", message: "unknown_column" },
        },
      ],
      "",
    );
    expect(prompt).toContain("Error: SQL_EXECUTION_ERROR: unknown_column");
  });
});

describe("OpenAICompatibleProvider — usage survives a thrown call (audit #83)", () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://llm.test/v1",
    apiKey: "k",
    routerModel: "r-m",
    narrativeModel: "n-m",
    pricing: { "r-m": { in: 1, out: 1 }, "n-m": { in: 1, out: 1 } },
  });

  it("a router fetch that times out carries an input estimate", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const err = await provider
      .routeAndDraft({
        question: "q",
        endpoints: [],
        history: [],
        sql_schema_summary: "",
      })
      .catch((e: unknown) => e);
    vi.restoreAllMocks();
    expect((err as { name?: string }).name).toBe("TimeoutError");
    const usage = sageUsageOf(err);
    expect(usage).toMatchObject({ model: "r-m", output_tokens: 0 });
    expect(usage!.input_tokens).toBeGreaterThan(0);
  });

  it("a narrative stream cut mid-way carries the text it had streamed", async () => {
    const enc = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (pulls++ === 0) {
          ctrl.enqueue(
            enc.encode(
              'data: {"choices":[{"delta":{"content":"Hay 1234 unidades"}}]}\n',
            ),
          );
        } else {
          ctrl.error(new Error("socket hang up"));
        }
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const chunks: string[] = [];
    const err = await (async () => {
      for await (const c of provider.writeNarrativeStream({
        question: "q",
        route: { kind: "sql", sql: "SELECT 1" },
        digest: { columns: [], row_count: 0, first_n_rows: [] },
        history: [],
      })) {
        chunks.push(c.text);
      }
    })().catch((e: unknown) => e);
    vi.restoreAllMocks();
    expect(chunks).toEqual(["Hay 1234 unidades"]);
    const usage = sageUsageOf(err);
    expect(usage).toMatchObject({
      model: "n-m",
      output_tokens: Math.ceil("Hay 1234 unidades".length / 4),
    });
    expect(usage!.input_tokens).toBeGreaterThan(0);
  });
});
