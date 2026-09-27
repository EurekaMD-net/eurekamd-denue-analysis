/**
 * Factory: pick a provider implementation by env. Called once at server
 * boot from src/api/server.ts and held on ApiServerConfig.
 *
 * Switching providers is one env-var change:
 *
 *   SAGE_PROVIDER=anthropic
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   SAGE_MODEL_ROUTER=claude-sonnet-4-6
 *   SAGE_MODEL_NARRATIVE=claude-sonnet-4-6
 *
 *   # OR
 *
 *   SAGE_PROVIDER=openai-compatible
 *   SAGE_BASE_URL=https://api.groq.com/openai/v1
 *   SAGE_API_KEY=gsk_...
 *   SAGE_MODEL_ROUTER=llama-3.3-70b-versatile
 *   SAGE_MODEL_NARRATIVE=qwen3-32b
 *   # optional, $ per million tokens; without it cost_usd is 0
 *   SAGE_PRICE_TABLE={"llama-3.3-70b-versatile":{"in":0.59,"out":0.79}}
 */

import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { SageProvider } from "./provider.js";

export type SageProviderName = "anthropic" | "openai-compatible";

export interface SageProviderEnv {
  SAGE_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  SAGE_BASE_URL?: string;
  SAGE_API_KEY?: string;
  SAGE_MODEL_ROUTER?: string;
  SAGE_MODEL_NARRATIVE?: string;
  SAGE_PRICE_TABLE?: string;
}

type PriceTable = Record<string, { in: number; out: number }>;

/**
 * SAGE_PRICE_TABLE (audit #211): JSON mapping model id to $/M-token
 * prices. Invalid JSON or shape throws, so a typo fails at boot instead
 * of silently auditing cost_usd=0.
 */
function parsePriceTable(raw: string | undefined): PriceTable | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SAGE_PRICE_TABLE is not valid JSON.");
  }
  const isPrice = (v: unknown): boolean =>
    v !== null &&
    typeof v === "object" &&
    [(v as { in?: unknown }).in, (v as { out?: unknown }).out].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    );
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every(isPrice)
  ) {
    throw new Error(
      'SAGE_PRICE_TABLE must map model ids to {"in": <$/M tokens>, "out": <$/M tokens>}.',
    );
  }
  return parsed as PriceTable;
}

export function buildSageProvider(env: SageProviderEnv): SageProvider {
  const which = (env.SAGE_PROVIDER ?? "anthropic").toLowerCase();
  // Validate the provider name BEFORE attempting to derive default
  // models — defaultRouterModel/Narrative throw on unknown providers
  // and would mask the more useful "Unknown SAGE_PROVIDER" error.
  if (which !== "anthropic" && which !== "openai-compatible") {
    throw new Error(
      `Unknown SAGE_PROVIDER "${env.SAGE_PROVIDER}". Use "anthropic" or "openai-compatible".`,
    );
  }
  const routerModel = env.SAGE_MODEL_ROUTER ?? defaultRouterModel(which);
  const narrativeModel =
    env.SAGE_MODEL_NARRATIVE ?? defaultNarrativeModel(which);

  if (which === "anthropic") {
    // Auth via ~/.claude/.credentials.json (Claude Agent SDK OAuth
    // session). No ANTHROPIC_API_KEY required — billing flows through
    // the host's Max Plan + Extra Usage subscription. If the credentials
    // file is missing the SDK throws at first query(), not here.
    return new AnthropicProvider({
      routerModel,
      narrativeModel,
    });
  }

  if (which === "openai-compatible") {
    const baseUrl = env.SAGE_BASE_URL;
    const apiKey = env.SAGE_API_KEY;
    if (!baseUrl || !apiKey) {
      throw new Error(
        "SAGE_PROVIDER=openai-compatible requires SAGE_BASE_URL and SAGE_API_KEY.",
      );
    }
    return new OpenAICompatibleProvider({
      baseUrl,
      apiKey,
      routerModel,
      narrativeModel,
      pricing: parsePriceTable(env.SAGE_PRICE_TABLE),
    });
  }

  throw new Error(
    `Unknown SAGE_PROVIDER "${env.SAGE_PROVIDER}". Use "anthropic" or "openai-compatible".`,
  );
}

function defaultRouterModel(provider: string): string {
  if (provider === "anthropic") return "claude-sonnet-4-6";
  // Most permissive sane default for openai-compat: leave it explicit.
  // We throw rather than picking a model that may not be available.
  throw new Error(
    `SAGE_MODEL_ROUTER is required when SAGE_PROVIDER=${provider}.`,
  );
}

function defaultNarrativeModel(provider: string): string {
  if (provider === "anthropic") return "claude-sonnet-4-6";
  throw new Error(
    `SAGE_MODEL_NARRATIVE is required when SAGE_PROVIDER=${provider}.`,
  );
}

export type { SageProvider };
