/**
 * Client for /sage/* SSE endpoints. Wraps fetch + manual SSE parsing
 * because EventSource doesn't support POST.
 *
 * One stream call yields a sequence of typed events. The caller drives
 * the conversation by collecting `thread_id` from the first event and
 * passing it back on subsequent queries.
 */

import { apiFetch } from "./client";

export type SageEvent =
  | { type: "thread"; thread_id: string }
  | { type: "route"; payload: SageRoute }
  | {
      type: "table";
      columns: string[];
      rows: unknown[];
      row_count: number;
    }
  | {
      type: "chart";
      chart_type: string;
      x_col?: string;
      y_col?: string;
    }
  | { type: "delta"; text: string }
  | { type: "narrative"; text: string }
  | {
      type: "usage";
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      latency_ms: number;
      provider: string;
      model: string;
    }
  | { type: "error"; code: string; message: string }
  | { type: "done"; turn_id: string | null };

export interface SageRoute {
  kind: "endpoint" | "sql" | "decline";
  endpoint_name?: string;
  params?: Record<string, string | number>;
  sql?: string;
  reasoning?: string;
  confidence?: number;
}

export interface SageHealth {
  configured: boolean;
  provider: string | null;
  router_model: string | null;
  narrative_model: string | null;
}

export async function fetchSageHealth(
  tokenOverride: string | null,
): Promise<SageHealth> {
  const res = await apiFetch("/sage/health", {}, tokenOverride);
  return (await res.json()) as SageHealth;
}

export async function* sageQueryStream(
  question: string,
  threadId: string | null,
  tokenOverride: string | null,
  signal?: AbortSignal,
): AsyncGenerator<SageEvent, void, void> {
  const res = await apiFetch(
    "/sage/query",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        thread_id: threadId,
      }),
      signal,
    },
    tokenOverride,
  );
  if (!res.ok || !res.body) {
    throw new Error(`Sage /query ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = parseEventBlock(block);
      if (event) yield event;
      idx = buf.indexOf("\n\n");
    }
  }
}

function parseEventBlock(block: string): SageEvent | null {
  let eventName = "message";
  let dataLine = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
  }
  if (!dataLine) return null;
  let data: unknown;
  try {
    data = JSON.parse(dataLine);
  } catch {
    return null;
  }
  const d = data as Record<string, unknown>;
  switch (eventName) {
    case "thread":
      return { type: "thread", thread_id: String(d["thread_id"] ?? "") };
    case "route":
      return { type: "route", payload: data as SageRoute };
    case "table":
      return {
        type: "table",
        columns: (d["columns"] as string[]) ?? [],
        rows: (d["rows"] as unknown[]) ?? [],
        row_count: Number(d["row_count"] ?? 0),
      };
    case "chart":
      return {
        type: "chart",
        chart_type: String(d["chart_type"] ?? "bar"),
        x_col: d["x_col"] as string | undefined,
        y_col: d["y_col"] as string | undefined,
      };
    case "delta":
      return { type: "delta", text: String(d["text"] ?? "") };
    case "narrative":
      return { type: "narrative", text: String(d["text"] ?? "") };
    case "usage":
      return {
        type: "usage",
        input_tokens: Number(d["input_tokens"] ?? 0),
        output_tokens: Number(d["output_tokens"] ?? 0),
        cost_usd: Number(d["cost_usd"] ?? 0),
        latency_ms: Number(d["latency_ms"] ?? 0),
        provider: String(d["provider"] ?? ""),
        model: String(d["model"] ?? ""),
      };
    case "error":
      return {
        type: "error",
        code: String(d["code"] ?? "UNKNOWN"),
        message: String(d["message"] ?? ""),
      };
    case "done":
      return {
        type: "done",
        turn_id: (d["turn_id"] as string | null) ?? null,
      };
    default:
      return null;
  }
}
