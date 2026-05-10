/**
 * Sage provider abstraction.
 *
 * Two implementations:
 *   - AnthropicProvider:     wraps @anthropic-ai/sdk. Demo-grade target.
 *   - OpenAICompatibleProvider: any /v1/chat/completions endpoint (Groq,
 *                              Fireworks, Together, OpenRouter, vLLM,
 *                              Ollama, OpenAI). Sell-time target.
 *
 * Tool-calling format differs between Anthropic and OpenAI specs; each
 * provider translates to/from the normalized RouteOutput shape at its
 * boundary. Callers never see provider-specific structures.
 *
 * Token budget: prompts are sized for the SMALLEST supported window
 * (32k, matching Qwen 3 32B). Anthropic deployments aren't penalized by
 * the cap — they just don't use the extra headroom. This keeps a single
 * prompt working everywhere.
 */

export type RouteKind = "endpoint" | "sql" | "decline";

export interface RouteOutputEndpoint {
  kind: "endpoint";
  endpoint_name: string;
  params: Record<string, string | number>;
  reasoning: string;
  confidence: number;
}

export interface RouteOutputSql {
  kind: "sql";
  sql: string;
  reasoning: string;
  confidence: number;
}

export interface RouteOutputDecline {
  kind: "decline";
  reasoning: string;
}

export type RouteOutput =
  | RouteOutputEndpoint
  | RouteOutputSql
  | RouteOutputDecline;

export interface EndpointSpec {
  name: string;
  description: string;
  /**
   * JSON Schema fragment for params. The provider passes this to the
   * model as a tool/function definition.
   */
  params_schema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface PriorTurnDigest {
  question: string;
  route: { kind: RouteKind; endpoint_name?: string; sql?: string };
  digest: {
    columns: string[];
    row_count: number;
    first_5_rows: unknown[];
    numeric_stats?: Record<string, { min: number; max: number; mean: number }>;
  };
  narrative: string;
}

export interface RouteInput {
  question: string;
  endpoints: EndpointSpec[];
  /**
   * Last N turns (digests only, never full result rows). Capped at 5.
   */
  history: PriorTurnDigest[];
  /**
   * Schema cribsheet of allowlisted views/MVs (column list + grain).
   * Used when the model decides to fall back to SQL.
   */
  sql_schema_summary: string;
}

export interface NarrativeInput {
  question: string;
  route: { kind: RouteKind; endpoint_name?: string; sql?: string };
  /** Result digest (NOT full rows; caps narrative prompt size). */
  digest: {
    columns: string[];
    row_count: number;
    first_n_rows: unknown[];
    numeric_stats?: Record<string, { min: number; max: number; mean: number }>;
  };
  /** Last N turns, for cohesion. */
  history: PriorTurnDigest[];
}

export interface UsageNormalized {
  input_tokens: number;
  output_tokens: number;
  /** Provider-reported cost; 0 when the upstream doesn't expose pricing. */
  cost_usd: number;
  latency_ms: number;
  provider: string;
  model: string;
}

export interface RouteResult {
  output: RouteOutput;
  usage: UsageNormalized;
}

export interface NarrativeStreamChunk {
  text: string;
  /** Final chunk emits usage; intermediate chunks have usage=null. */
  usage: UsageNormalized | null;
}

/**
 * Provider contract. All methods are async. countTokens is best-effort
 * (used for budget-planning, not for billing).
 */
export interface SageProvider {
  /** Identifier used in audit log + telemetry. */
  readonly name: string;
  /** Model id used by routeAndDraft. */
  readonly routerModel: string;
  /** Model id used by writeNarrative. */
  readonly narrativeModel: string;

  /** Pick an endpoint or draft a SQL query. Structured output. */
  routeAndDraft(input: RouteInput, signal?: AbortSignal): Promise<RouteResult>;

  /**
   * Stream a prose paragraph summarizing the result. The final chunk
   * carries usage telemetry; intermediate chunks carry partial text.
   * The optional AbortSignal lets the caller cancel the upstream LLM
   * stream when the client disconnects mid-narrative (closure audit
   * C1-perf).
   */
  writeNarrativeStream(
    input: NarrativeInput,
    signal?: AbortSignal,
  ): AsyncIterable<NarrativeStreamChunk>;

  /** Best-effort token count for budgeting. */
  countTokens(text: string): number;
}

/** Approximate token count (4 chars/token English baseline). */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
