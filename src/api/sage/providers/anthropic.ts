/**
 * Anthropic provider — Claude Agent SDK path.
 *
 * Authenticates via ~/.claude/.credentials.json (same OAuth session as
 * Jarvis / mission-control). No ANTHROPIC_API_KEY env var required;
 * billing flows through the Max Plan + Extra Usage on the host's Claude
 * Code subscription.
 *
 * Router pass: registers call_endpoint / draft_sql / decline as MCP
 * tools via createSdkMcpServer. Only the first tool call counts: its
 * handler captures the route, aborts the query and the loop breaks, so
 * the tool result is never sent back for a second model call (audit
 * #78/#200; maxTurns=1 backs this up). Usage then comes from that first
 * assistant message. The endpoint catalog and SQL schema sit in the
 * system prompt before SYSTEM_PROMPT_DYNAMIC_BOUNDARY so they are cached
 * across requests; the user message carries only history + question
 * (audit #204). No tool call is a clarify (model text) or a router error,
 * never a silent decline (audit #84).
 *
 * Narrative pass: no MCP tools, no allowedTools. Just a systemPrompt +
 * user message. With includePartialMessages the SDK emits stream_event
 * text deltas as they are generated (audit #203).
 *
 * Usage sums input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens per the Anthropic Messages API spec ("total
 * input tokens in a request is the summation of those three") and keeps
 * the two cache buckets separately for the audit. Cost prefers the SDK's
 * total_cost_usd; the fallback prices each bucket at its own rate.
 *
 * The SDK child gets an allowlisted env, never the host's secrets
 * (audit #30).
 */

import {
  createSdkMcpServer,
  query,
  tool as sdkTool,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type Options as SdkOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  ROUTER_SYSTEM_PROMPT,
  NARRATIVE_SYSTEM_PROMPT,
  buildRouterCatalogPrompt,
  buildRouterUserPrompt,
  buildNarrativeUserPrompt,
} from "./prompts.js";
import {
  approximateTokens,
  attachSageUsage,
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

// Anthropic list prices ($/M tokens, checked 2026-09-27). The SDK's
// `total_cost_usd` is the canonical source; this table is the fallback
// for calls that end before a result message (the router, which stops at
// its first tool call, and thrown calls). Cache writes bill at 1.25x the
// input rate and cache reads at 0.1x unless `cacheRead` says otherwise
// (audit #91/#210).
const PRICE_TABLE: Record<
  string,
  { in: number; out: number; cacheRead?: number }
> = {
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-fable-5": { in: 10, out: 50 },
  "claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

const unpricedWarned = new Set<string>();

// Per-Anthropic Messages API: "Total input tokens in a request is the
// summation of input_tokens + cache_creation_input_tokens + cache_read_input_tokens."
// Recording only input_tokens underweights by the cache-hit portion.
interface SdkUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function fallbackPrice(model: string, u: SdkUsageShape): number {
  const p = PRICE_TABLE[model];
  if (!p) {
    if (!unpricedWarned.has(model)) {
      unpricedWarned.add(model);
      process.stderr.write(
        `[sage] no fallback price for model ${model}; cost_usd recorded as 0\n`,
      );
    }
    return 0;
  }
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.cache_creation_input_tokens ?? 0) * p.in * 1.25 +
      (u.cache_read_input_tokens ?? 0) * (p.cacheRead ?? p.in * 0.1) +
      (u.output_tokens ?? 0) * p.out) /
    1_000_000
  );
}

function normalizeSdkUsage(
  u: SdkUsageShape | undefined,
  model: string,
  latency_ms: number,
  totalCostUsd?: number,
): UsageNormalized {
  const read = u?.cache_read_input_tokens ?? 0;
  const write = u?.cache_creation_input_tokens ?? 0;
  return {
    input_tokens: (u?.input_tokens ?? 0) + write + read,
    output_tokens: u?.output_tokens ?? 0,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cost_usd:
      typeof totalCostUsd === "number"
        ? totalCostUsd
        : fallbackPrice(model, u ?? {}),
    latency_ms,
    provider: "anthropic",
    model,
  };
}

// Env the SDK child needs: the binary lookup, the credentials location
// and the auth variables it reads. Nothing else of the host env (audit
// #30: SUPABASE_*, API_KEY, DENUE_TOKEN never reach the child).
const SDK_ENV_KEYS = [
  "PATH",
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
] as const;

export function sdkEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SDK_ENV_KEYS) {
    const v = source[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

// A call that threw (timeout, client abort) before its result message:
// estimate what it spent from the prompt and the text already streamed,
// so the handler can still audit the cost (audit #83).
function estimatedUsage(
  model: string,
  promptText: string,
  outputChars: number,
  t0: number,
): UsageNormalized {
  const inTok = approximateTokens(promptText);
  const outTok = Math.ceil(outputChars / 4);
  return {
    input_tokens: inTok,
    output_tokens: outTok,
    cost_usd: fallbackPrice(model, {
      input_tokens: inTok,
      output_tokens: outTok,
    }),
    latency_ms: Date.now() - t0,
    provider: "anthropic",
    model,
  };
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
    // Static catalog + schema before the boundary (cacheable across
    // requests); only history + question vary (audit #204).
    const catalogPrompt = buildRouterCatalogPrompt(
      input.endpoints,
      input.sql_schema_summary,
    );
    const userPrompt = buildRouterUserPrompt(input.question, input.history);

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener("abort", () => abortController.abort());
    }
    const timer = setTimeout(() => abortController.abort(), 30_000);

    // Router decision: the FIRST tool call wins (audit #78). Its handler
    // aborts the query so the tool result never goes back to the model
    // for a second turn (audit #200).
    let captured = null as RouteOutput | null;
    const take = (route: RouteOutput) => {
      if (captured) return;
      captured = route;
      abortController.abort();
    };
    const ok = { content: [{ type: "text" as const, text: "ok" }] };

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
            take({
              kind: "endpoint",
              endpoint_name: String(args.endpoint_name ?? ""),
              params: (args.params as Record<string, string | number>) ?? {},
              reasoning: String(args.reasoning ?? ""),
              confidence: Number(args.confidence ?? 0),
            });
            return ok;
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
            take({
              kind: "sql",
              sql: String(args.sql ?? ""),
              reasoning: String(args.reasoning ?? ""),
              confidence: Number(args.confidence ?? 0),
            });
            return ok;
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
            take({
              kind: "decline",
              reasoning: String(args.reasoning ?? ""),
            });
            return ok;
          },
        ),
      ],
    });

    const allowedTools = [
      "mcp__sage_router__call_endpoint",
      "mcp__sage_router__draft_sql",
      "mcp__sage_router__decline",
    ];

    const options: SdkOptions = {
      model: this.routerModel,
      systemPrompt: [
        ROUTER_SYSTEM_PROMPT,
        catalogPrompt,
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      ],
      mcpServers: { sage_router: mcpServer },
      allowedTools,
      // Disable Claude Code built-ins; this is a pure tool-router call.
      tools: [],
      // Isolation: without an explicit [], the SDK loads the host user's
      // ~/.claude/CLAUDE.md + rules + memory into every call (~23k tokens of
      // operator config). Omitted ≠ none — [] is load-bearing.
      settingSources: [],
      permissionMode: "dontAsk",
      maxTurns: 1,
      abortController,
      persistSession: false,
      cwd: process.cwd(),
      thinking: { type: "disabled" },
      env: sdkEnv(),
    };

    const t0 = Date.now();
    // Usage of the first (only) assistant message; a result message, when
    // one arrives, replaces it with the SDK's own totals.
    // The abort at the first tool call lands before message_delta, so that
    // message carries message_start's placeholder output_tokens (1); floor it
    // at the captured tool call's size so the output charge is not lost.
    let assistantUsage: SdkUsageShape | undefined;
    let assistantText = "";
    let resultUsage: UsageNormalized | null = null;
    // Set when the query ended without any tool call (audit #84).
    let noToolOutcome: RouteOutput | null = null;
    const finalUsage = (): UsageNormalized =>
      resultUsage ??
      (assistantUsage
        ? normalizeSdkUsage(
            captured
              ? {
                  ...assistantUsage,
                  output_tokens: Math.max(
                    assistantUsage.output_tokens ?? 0,
                    approximateTokens(JSON.stringify(captured)),
                  ),
                }
              : assistantUsage,
            this.routerModel,
            Date.now() - t0,
          )
        : estimatedUsage(
            this.routerModel,
            ROUTER_SYSTEM_PROMPT + catalogPrompt + userPrompt,
            captured ? JSON.stringify(captured).length : assistantText.length,
            t0,
          ));

    try {
      const q = query({ prompt: userPrompt, options });
      for await (const message of q) {
        if (message.type === "assistant" && message.message) {
          assistantUsage = message.message.usage ?? assistantUsage;
          for (const block of message.message.content ?? []) {
            if (block.type === "text") assistantText += block.text;
          }
        } else if (message.type === "result") {
          resultUsage = normalizeSdkUsage(
            message.usage,
            this.routerModel,
            Date.now() - t0,
            message.total_cost_usd,
          );
          if (message.subtype === "success") {
            const text = (message.result || assistantText).trim();
            noToolOutcome = text
              ? { kind: "clarify", reasoning: text }
              : {
                  kind: "error",
                  code: "ROUTER_NO_TOOL",
                  detail: `no tool call and no text (stop_reason ${message.stop_reason ?? "none"})`,
                };
          } else {
            noToolOutcome = {
              kind: "error",
              code: "ROUTER_SDK_ERROR",
              detail: `${message.subtype}: ${(message.errors ?? []).join("; ")}`,
            };
          }
        }
        if (captured) break;
      }
    } catch (err) {
      // Our own abort after the first tool call is the success path; so
      // is an SDK throw after it already reported an error result.
      if (!captured && !noToolOutcome) {
        throw attachSageUsage(err, finalUsage());
      }
    } finally {
      clearTimeout(timer);
    }

    const output: RouteOutput =
      captured ??
      noToolOutcome ??
      (assistantText.trim()
        ? { kind: "clarify", reasoning: assistantText.trim() }
        : {
            kind: "error",
            code: "ROUTER_NO_TOOL",
            detail: "query ended without a tool call or a result",
          });
    return { output, usage: finalUsage() };
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
      // Isolation — see router options above; [] is load-bearing.
      settingSources: [],
      permissionMode: "dontAsk",
      maxTurns: 1,
      // Emit text deltas while the paragraph is generated (audit #203).
      includePartialMessages: true,
      abortController,
      persistSession: false,
      cwd: process.cwd(),
      thinking: { type: "disabled" },
      env: sdkEnv(),
    };

    const t0 = Date.now();
    let emittedLen = 0; // total chars yielded to the client so far
    let usage: UsageNormalized | null = null;

    try {
      const q = query({ prompt: userPrompt, options });
      for await (const message of q) {
        if (message.type === "stream_event") {
          const ev = message.event;
          if (
            ev.type === "content_block_delta" &&
            ev.delta.type === "text_delta" &&
            ev.delta.text
          ) {
            emittedLen += ev.delta.text.length;
            yield { text: ev.delta.text, usage: null };
          }
        } else if (message.type === "assistant" && message.message?.content) {
          // The complete message follows its stream events: yield only
          // text the deltas did not already deliver (none when streaming
          // worked), keeping deltas non-overlapping.
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
          // Success and error results both carry total_cost_usd (audit #91).
          usage = normalizeSdkUsage(
            message.usage,
            this.narrativeModel,
            Date.now() - t0,
            message.total_cost_usd,
          );
        }
      }
    } catch (err) {
      throw attachSageUsage(
        err,
        usage ??
          estimatedUsage(
            this.narrativeModel,
            NARRATIVE_SYSTEM_PROMPT + userPrompt,
            emittedLen,
            t0,
          ),
      );
    } finally {
      clearTimeout(timer);
    }
    yield { text: "", usage };
  }

  countTokens(text: string): number {
    return approximateTokens(text);
  }
}
