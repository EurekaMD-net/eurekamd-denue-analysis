/**
 * Anthropic provider — Claude Agent SDK path.
 *
 * Authenticates via ~/.claude/.credentials.json (same OAuth session as
 * Jarvis / mission-control). No ANTHROPIC_API_KEY env var required;
 * billing flows through the Max Plan + Extra Usage on the host's Claude
 * Code subscription.
 *
 * Router pass: registers call_endpoint / draft_sql / decline as MCP
 * tools via createSdkMcpServer. The model picks exactly one (allowedTools
 * lists all three, maxTurns=1 prevents follow-up turns). The tool handler
 * captures the chosen tool name + args via closure; we return immediately
 * after the first tool call surfaces.
 *
 * Narrative pass: no MCP tools, no allowedTools. Just a systemPrompt +
 * user message. Stream text deltas from assistant messages as they arrive.
 *
 * Both calls collect usage from the SDK result message, summing
 * input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * per the Anthropic Messages API spec ("total input tokens in a request
 * is the summation of those three"). Without this you under-count by
 * the cache-hit portion which can be 90%+ of the prompt.
 */

import {
  createSdkMcpServer,
  query,
  tool as sdkTool,
  type Options as SdkOptions,
  type SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  ROUTER_SYSTEM_PROMPT,
  NARRATIVE_SYSTEM_PROMPT,
  buildRouterUserPrompt,
  buildNarrativeUserPrompt,
} from "./prompts.js";
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
  /** Routing model id, e.g. "claude-sonnet-4-6". */
  routerModel: string;
  /** Narrative model id, e.g. "claude-sonnet-4-6". */
  narrativeModel: string;
}

// Per-Anthropic public pricing 2026-05 ($/M tokens). The Claude Agent
// SDK reports a `total_cost_usd` in the result message which is the
// canonical source; this table is a fallback when that field is absent
// on a particular SDK version.
const PRICE_TABLE: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

function fallbackPrice(model: string, inTok: number, outTok: number): number {
  const p = PRICE_TABLE[model];
  if (!p) return 0;
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

// Per-Anthropic Messages API: "Total input tokens in a request is the
// summation of input_tokens + cache_creation_input_tokens + cache_read_input_tokens."
// Recording only input_tokens underweights by the cache-hit portion.
interface SdkUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
function totalInputTokens(u: SdkUsageShape | undefined): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}

export class AnthropicProvider implements SageProvider {
  readonly name = "anthropic";
  readonly routerModel: string;
  readonly narrativeModel: string;

  constructor(config: AnthropicProviderConfig) {
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

    // Captured router decision — set by exactly one of the three tool
    // handlers below when the model picks. Default decline if the model
    // somehow returns without calling any tool.
    let captured: RouteOutput = {
      kind: "decline",
      reasoning: "El modelo no eligió una acción.",
    };

    const mcpServer = createSdkMcpServer({
      name: "sage_router",
      version: "1.0.0",
      tools: [
        sdkTool(
          "call_endpoint",
          "Pick one of the HTTP endpoints listed in the prompt and fill its params.",
          {
            endpoint_name: z
              .string()
              .describe("Exact name from the endpoints list."),
            params: z
              .record(z.string(), z.union([z.string(), z.number()]))
              .describe("Key-value params; strings or numbers only."),
            reasoning: z.string().describe("One sentence on why."),
            confidence: z.number().describe("0.0 to 1.0"),
          },
          async (args) => {
            captured = {
              kind: "endpoint",
              endpoint_name: String(args.endpoint_name ?? ""),
              params: (args.params as Record<string, string | number>) ?? {},
              reasoning: String(args.reasoning ?? ""),
              confidence: Number(args.confidence ?? 0),
            };
            return { content: [{ type: "text", text: "ok" }] };
          },
        ),
        sdkTool(
          "draft_sql",
          "Draft a SELECT (or WITH … SELECT) query against the allowlisted Postgres views.",
          {
            sql: z.string().describe("A single SELECT statement with LIMIT."),
            reasoning: z
              .string()
              .describe("One sentence on why SQL was needed."),
            confidence: z.number().describe("0.0 to 1.0"),
          },
          async (args) => {
            captured = {
              kind: "sql",
              sql: String(args.sql ?? ""),
              reasoning: String(args.reasoning ?? ""),
              confidence: Number(args.confidence ?? 0),
            };
            return { content: [{ type: "text", text: "ok" }] };
          },
        ),
        sdkTool(
          "decline",
          "Refuse the question (out of scope, unsafe, or unanswerable with available data).",
          {
            reasoning: z
              .string()
              .describe("Brief Spanish explanation addressed to the user."),
          },
          async (args) => {
            captured = {
              kind: "decline",
              reasoning: String(args.reasoning ?? ""),
            };
            return { content: [{ type: "text", text: "ok" }] };
          },
        ),
      ],
    });

    const allowedTools = [
      "mcp__sage_router__call_endpoint",
      "mcp__sage_router__draft_sql",
      "mcp__sage_router__decline",
    ];

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener("abort", () => abortController.abort());
    }
    const timer = setTimeout(() => abortController.abort(), 30_000);

    const options: SdkOptions = {
      model: this.routerModel,
      systemPrompt: ROUTER_SYSTEM_PROMPT,
      mcpServers: { sage_router: mcpServer },
      allowedTools,
      // Disable Claude Code built-ins; this is a pure tool-router call.
      tools: [],
      permissionMode: "dontAsk",
      maxTurns: 2,
      abortController,
      persistSession: false,
      cwd: process.cwd(),
      thinking: { type: "disabled" },
      env: { ...process.env },
    };

    const t0 = Date.now();
    let usage: UsageNormalized = {
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: 0,
      provider: this.name,
      model: this.routerModel,
    };

    try {
      const q = query({ prompt: userPrompt, options });
      for await (const message of q) {
        if (message.type === "result") {
          const latency_ms = Date.now() - t0;
          if (message.subtype === "success") {
            const success = message as SDKResultSuccess;
            const inTok = totalInputTokens(success.usage);
            const outTok = success.usage?.output_tokens ?? 0;
            usage = {
              input_tokens: inTok,
              output_tokens: outTok,
              cost_usd:
                (success as { total_cost_usd?: number }).total_cost_usd ??
                fallbackPrice(this.routerModel, inTok, outTok),
              latency_ms,
              provider: this.name,
              model: (success as { model?: string }).model ?? this.routerModel,
            };
          } else {
            // Error subtype: capture latency, leave token counts at 0 if
            // the SDK didn't expose them on this error path.
            const errUsage = (message as { usage?: SdkUsageShape }).usage;
            const inTok = totalInputTokens(errUsage);
            const outTok = errUsage?.output_tokens ?? 0;
            usage = {
              input_tokens: inTok,
              output_tokens: outTok,
              cost_usd: fallbackPrice(this.routerModel, inTok, outTok),
              latency_ms,
              provider: this.name,
              model: this.routerModel,
            };
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }

    return { output: captured, usage };
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

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener("abort", () => abortController.abort());
    }
    const timer = setTimeout(() => abortController.abort(), 45_000);

    const options: SdkOptions = {
      model: this.narrativeModel,
      systemPrompt: NARRATIVE_SYSTEM_PROMPT,
      mcpServers: {},
      allowedTools: [],
      tools: [],
      permissionMode: "dontAsk",
      maxTurns: 1,
      abortController,
      persistSession: false,
      cwd: process.cwd(),
      thinking: { type: "disabled" },
      env: { ...process.env },
    };

    const t0 = Date.now();
    let emittedLen = 0; // total chars yielded to the client so far
    let usage: UsageNormalized | null = null;

    try {
      const q = query({ prompt: userPrompt, options });
      for await (const message of q) {
        if (message.type === "assistant" && message.message?.content) {
          // Each assistant message carries the cumulative text so far.
          // Diff vs what we already yielded to keep deltas non-overlapping.
          let totalText = "";
          for (const block of message.message.content) {
            if (
              typeof block === "object" &&
              "type" in block &&
              block.type === "text" &&
              "text" in block &&
              typeof block.text === "string"
            ) {
              totalText += block.text;
            }
          }
          if (totalText.length > emittedLen) {
            const delta = totalText.slice(emittedLen);
            emittedLen = totalText.length;
            yield { text: delta, usage: null };
          }
        } else if (message.type === "result") {
          const latency_ms = Date.now() - t0;
          if (message.subtype === "success") {
            const success = message as SDKResultSuccess;
            const inTok = totalInputTokens(success.usage);
            const outTok = success.usage?.output_tokens ?? 0;
            usage = {
              input_tokens: inTok,
              output_tokens: outTok,
              cost_usd:
                (success as { total_cost_usd?: number }).total_cost_usd ??
                fallbackPrice(this.narrativeModel, inTok, outTok),
              latency_ms,
              provider: this.name,
              model:
                (success as { model?: string }).model ?? this.narrativeModel,
            };
          } else {
            const errUsage = (message as { usage?: SdkUsageShape }).usage;
            const inTok = totalInputTokens(errUsage);
            const outTok = errUsage?.output_tokens ?? 0;
            usage = {
              input_tokens: inTok,
              output_tokens: outTok,
              cost_usd: fallbackPrice(this.narrativeModel, inTok, outTok),
              latency_ms,
              provider: this.name,
              model: this.narrativeModel,
            };
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    yield { text: "", usage };
  }

  countTokens(text: string): number {
    return approximateTokens(text);
  }
}
