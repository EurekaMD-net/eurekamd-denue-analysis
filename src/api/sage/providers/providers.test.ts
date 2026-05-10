import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildSageProvider } from "./index.js";

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
