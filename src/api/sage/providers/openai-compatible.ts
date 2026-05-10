/**
 * OpenAI-compatible provider — sell-time target.
 *
 * Talks to any /v1/chat/completions endpoint following the OpenAI spec.
 * Verified-compatible providers (2026-05):
 *   - Groq:        https://api.groq.com/openai/v1
 *   - Fireworks:   https://api.fireworks.ai/inference/v1
 *   - Together:    https://api.together.xyz/v1
 *   - OpenRouter:  https://openrouter.ai/api/v1
 *   - DeepInfra:   https://api.deepinfra.com/v1/openai
 *   - OpenAI:      https://api.openai.com/v1
 *   - vLLM:        http://host:port/v1
 *   - Ollama:      http://host:11434/v1
 *
 * Tool-calling format normalization: OpenAI sends tool calls under
 * `choices[0].message.tool_calls[]` whereas Anthropic uses content
 * blocks. We flatten to the shared RouteOutput shape at this boundary.
 *
 * Pricing: every provider reports usage differently. We rely on the
 * upstream's `usage` block when present; cost_usd computation requires
 * a SAGE_PRICE_TABLE override env (provider-specific) or stays 0.
 */

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

export interface OpenAICompatibleProviderConfig {
  baseUrl: string;
  apiKey: string;
  routerModel: string;
  narrativeModel: string;
  /**
   * Optional per-model pricing in $/M-tokens. When absent, cost_usd
   * stays 0 and the audit log shows "unpriced".
   */
  pricing?: Record<string, { in: number; out: number }>;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface ChatToolCall {
  id?: string;
  type?: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string | null; tool_calls?: ChatToolCall[] };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  model?: string;
}

export class OpenAICompatibleProvider implements SageProvider {
  readonly name: string;
  readonly routerModel: string;
  readonly narrativeModel: string;
  private baseUrl: string;
  private apiKey: string;
  private pricing: Record<string, { in: number; out: number }>;

  constructor(config: OpenAICompatibleProviderConfig) {
    // Normalize trailing slash so concatenation is predictable.
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.routerModel = config.routerModel;
    this.narrativeModel = config.narrativeModel;
    this.pricing = config.pricing ?? {};
    // Derive a human-friendly provider name from the host for logs.
    try {
      this.name = `openai-compat:${new URL(this.baseUrl).hostname}`;
    } catch {
      this.name = "openai-compat";
    }
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

    const tools: ChatToolDef[] = ROUTER_TOOL_LIST.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    // Cap per-request wall-clock at 30s and honor caller-supplied
    // AbortSignal so SSE-on-disconnect closes the upstream fetch.
    // Closure audit C3-perf.
    const t0 = Date.now();
    const fetchSignal = combineSignals(signal, AbortSignal.timeout(30_000));
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: fetchSignal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.routerModel,
        max_tokens: 1024,
        messages: [
          { role: "system", content: ROUTER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ] satisfies ChatMessage[],
        tools,
        tool_choice: "required",
      }),
    });
    const latency_ms = Date.now() - t0;

    if (!res.ok) {
      throw new Error(
        `OpenAI-compat router ${res.status}: ${await res.text()}`,
      );
    }

    const body = (await res.json()) as ChatCompletionResponse;
    const usage = this.normalizeUsage(
      this.routerModel,
      body.usage?.prompt_tokens ?? 0,
      body.usage?.completion_tokens ?? 0,
      latency_ms,
    );

    const toolCall = body.choices[0]?.message.tool_calls?.[0];
    if (!toolCall) {
      const text = body.choices[0]?.message.content ?? "";
      return {
        output: {
          kind: "decline",
          reasoning: text || "Modelo no devolvió tool_call; declinando.",
        },
        usage,
      };
    }

    let parsedArgs: unknown = {};
    try {
      parsedArgs = JSON.parse(toolCall.function.arguments);
    } catch {
      // Malformed JSON from the upstream — decline gracefully so the
      // caller can retry or fall back to a different provider/model.
      return {
        output: {
          kind: "decline",
          reasoning: `Tool args malformados: ${toolCall.function.arguments.slice(0, 200)}`,
        },
        usage,
      };
    }

    return {
      output: parseToolCall(toolCall.function.name, parsedArgs),
      usage,
    };
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

    // Streaming budget is wider (45s) — the narrative can take longer
    // than the router on slower providers. Caller-supplied AbortSignal
    // takes precedence when the client disconnects.
    const t0 = Date.now();
    const fetchSignal = combineSignals(signal, AbortSignal.timeout(45_000));
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: fetchSignal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.narrativeModel,
        max_tokens: 512,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: NARRATIVE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ] satisfies ChatMessage[],
      }),
    });

    if (!res.ok) {
      throw new Error(
        `OpenAI-compat narrative ${res.status}: ${await res.text()}`,
      );
    }
    if (!res.body) {
      throw new Error("OpenAI-compat narrative: empty response body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let totalIn = 0;
    let totalOut = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const text = obj.choices?.[0]?.delta?.content;
          if (text) yield { text, usage: null };
          if (obj.usage) {
            totalIn = obj.usage.prompt_tokens ?? totalIn;
            totalOut = obj.usage.completion_tokens ?? totalOut;
          }
        } catch {
          // Ignore non-JSON keepalive lines.
        }
      }
    }

    const latency_ms = Date.now() - t0;
    const usage = this.normalizeUsage(
      this.narrativeModel,
      totalIn,
      totalOut,
      latency_ms,
    );
    yield { text: "", usage };
  }

  countTokens(text: string): number {
    return approximateTokens(text);
  }

  private normalizeUsage(
    model: string,
    inTok: number,
    outTok: number,
    latency_ms: number,
  ): UsageNormalized {
    const p = this.pricing[model];
    const cost_usd = p ? (inTok * p.in + outTok * p.out) / 1_000_000 : 0;
    return {
      input_tokens: inTok,
      output_tokens: outTok,
      cost_usd,
      latency_ms,
      provider: this.name,
      model,
    };
  }
}

// Compose a caller-supplied AbortSignal with a timeout signal. Returns
// the timeout alone when no caller signal is provided.
function combineSignals(
  caller: AbortSignal | undefined,
  timeout: AbortSignal,
): AbortSignal {
  if (!caller) return timeout;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([caller, timeout]);
  }
  // Manual fan-in for environments without AbortSignal.any.
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  caller.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return ctrl.signal;
}

function parseToolCall(name: string, args: unknown): RouteOutput {
  const obj = (args ?? {}) as Record<string, unknown>;
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
