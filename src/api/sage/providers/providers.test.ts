import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildSageProvider } from "./index.js";
import {
  buildRouterUserPrompt,
  buildNarrativeUserPrompt,
  NARRATIVE_ROWS_MAX_BYTES,
} from "./prompts.js";
import { SAGE_ENDPOINT_CATALOG } from "../endpoint-catalog.js";

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
