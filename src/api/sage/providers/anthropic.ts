/**
 * Anthropic provider — demo target.
 *
 * Uses @anthropic-ai/sdk with tool-calling. Streams narrative via the
 * `stream` parameter. Cost computed at write-time from a model→price
 * table; if a model id isn't in the table, cost_usd stays 0 and a
 * console warning fires.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  ROUTER_SYSTEM_PROMPT,
  NARRATIVE_SYSTEM_PROMPT,
  buildRouterUserPrompt,
  buildNarrativeUserPrompt,
} from "./prompts.js";
import { ROUTER_TOOL_LIST } from "./tools.js";
import {
  approximateTokens,
  type NarrativeInput,
  type NarrativeStreamChunk,
  type RouteInput,
  type RouteOutput,
  type RouteResult,
  type SageProvider,
  type UsageNormalized,
} from "./provider.js";

interface AnthropicProviderConfig {
  apiKey: string;
  routerModel: string;
  narrativeModel: string;
}

// Model → ($/M input, $/M output). Sonnet 4.6 + Haiku 4.5 prices as of
// 2026-05. Edit when Anthropic ships new pricing or models.
const PRICE_TABLE: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-4-6-1m": { in: 6, out: 22.5 },
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-opus-4-7-1m": { in: 30, out: 112.5 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function priceUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICE_TABLE[model];
  if (!p) {
    console.warn(`[sage/anthropic] no price entry for model "${model}"`);
    return 0;
  }
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

export class AnthropicProvider implements SageProvider {
  readonly name = "anthropic";
  readonly routerModel: string;
  readonly narrativeModel: string;
  private client: Anthropic;

  constructor(config: AnthropicProviderConfig) {
    // Cap per-request wall-clock at 30s (SDK default is 10 min, which
    // would hold the SSE channel open while burning full-narrative cost
    // on flaky upstreams). One retry max. Closure audit C2-perf.
    this.client = new Anthropic({
      apiKey: config.apiKey,
      timeout: 30_000,
      maxRetries: 1,
    });
    this.routerModel = config.routerModel;
    this.narrativeModel = config.narrativeModel;
  }

  async routeAndDraft(
    input: RouteInput,
    signal?: AbortSignal,
  ): Promise<RouteResult> {
    const userPrompt = buildRouterUserPrompt(
      input.question,
      input.endpoints,
      input.history,
      input.sql_schema_summary,
    );

    const t0 = Date.now();
    const response = await this.client.messages.create(
      {
        model: this.routerModel,
        max_tokens: 1024,
        system: ROUTER_SYSTEM_PROMPT,
        tools: ROUTER_TOOL_LIST,
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: userPrompt }],
      },
      signal ? { signal } : undefined,
    );
    const latency_ms = Date.now() - t0;

    const usage: UsageNormalized = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cost_usd: priceUsd(
        this.routerModel,
        response.usage.input_tokens,
        response.usage.output_tokens,
      ),
      latency_ms,
      provider: this.name,
      model: this.routerModel,
    };

    // The model must emit exactly one tool_use block. If it didn't (rare,
    // happens if tool_choice slipped or the model fell back to text), we
    // treat that as decline + return the text as reasoning.
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      const textBlock = response.content.find((b) => b.type === "text");
      const reasoning =
        textBlock && textBlock.type === "text"
          ? textBlock.text
          : "Modelo no devolvió ningún tool_use; declinando.";
      return {
        output: { kind: "decline", reasoning },
        usage,
      };
    }

    const output = parseToolUse(toolUse.name, toolUse.input);
    return { output, usage };
  }

  async *writeNarrativeStream(
    input: NarrativeInput,
    signal?: AbortSignal,
  ): AsyncIterable<NarrativeStreamChunk> {
    const userPrompt = buildNarrativeUserPrompt(
      input.question,
      input.route,
      input.digest,
      input.history,
    );

    const t0 = Date.now();
    const stream = this.client.messages.stream(
      {
        model: this.narrativeModel,
        max_tokens: 512,
        system: NARRATIVE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      },
      signal ? { signal } : undefined,
    );

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { text: event.delta.text, usage: null };
      }
    }

    const final = await stream.finalMessage();
    const latency_ms = Date.now() - t0;
    const usage: UsageNormalized = {
      input_tokens: final.usage.input_tokens,
      output_tokens: final.usage.output_tokens,
      cost_usd: priceUsd(
        this.narrativeModel,
        final.usage.input_tokens,
        final.usage.output_tokens,
      ),
      latency_ms,
      provider: this.name,
      model: this.narrativeModel,
    };
    yield { text: "", usage };
  }

  countTokens(text: string): number {
    return approximateTokens(text);
  }
}

function parseToolUse(name: string, input: unknown): RouteOutput {
  const obj = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "call_endpoint":
      return {
        kind: "endpoint",
        endpoint_name: String(obj["endpoint_name"] ?? ""),
        params: (obj["params"] as Record<string, string | number>) ?? {},
        reasoning: String(obj["reasoning"] ?? ""),
        confidence: Number(obj["confidence"] ?? 0),
      };
    case "draft_sql":
      return {
        kind: "sql",
        sql: String(obj["sql"] ?? ""),
        reasoning: String(obj["reasoning"] ?? ""),
        confidence: Number(obj["confidence"] ?? 0),
      };
    case "decline":
    default:
      return {
        kind: "decline",
        reasoning: String(obj["reasoning"] ?? "Sin razón provista."),
      };
  }
}
