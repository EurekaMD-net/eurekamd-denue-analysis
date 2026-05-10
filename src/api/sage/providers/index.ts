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
