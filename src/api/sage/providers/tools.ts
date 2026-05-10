/**
 * Tool / function definitions used by the router. Identical semantics
 * exported as both Anthropic tool-use schemas and OpenAI function-call
 * schemas — the JSON shape is the same, only the wrapper differs.
 *
 * Types are intentionally mutable (no `as const`) so the SDK overloads
 * accept the schemas without "readonly array not assignable" errors.
 */

interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const ROUTER_TOOLS: Record<string, ToolSchema> = {
  call_endpoint: {
    name: "call_endpoint",
    description:
      "Pick one of the HTTP endpoints listed in the prompt and fill its params. Use this when an endpoint cleanly answers the question.",
    input_schema: {
      type: "object",
      properties: {
        endpoint_name: {
          type: "string",
          description:
            "Exact name from the endpoints list (e.g. 'risk-summary').",
        },
        params: {
          type: "object",
          description:
            "Key-value params for the endpoint. Strings or numbers only. Match the endpoint's param schema.",
          additionalProperties: { type: ["string", "number"] },
        },
        reasoning: {
          type: "string",
          description:
            "One sentence on why this endpoint fits. Plain text, no markdown.",
        },
        confidence: {
          type: "number",
          description: "0.0 to 1.0",
        },
      },
      required: ["endpoint_name", "params", "reasoning", "confidence"],
    },
  },

  draft_sql: {
    name: "draft_sql",
    description:
      "Draft a SELECT (or WITH … SELECT) query against the allowlisted Postgres views. Use this when no endpoint fits — e.g. cross-source joins, unusual aggregations. ALWAYS include LIMIT.",
    input_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description:
            "A single SELECT statement. No DML, no DDL. Must include LIMIT.",
        },
        reasoning: {
          type: "string",
          description: "One sentence on why SQL was needed over an endpoint.",
        },
        confidence: {
          type: "number",
          description: "0.0 to 1.0",
        },
      },
      required: ["sql", "reasoning", "confidence"],
    },
  },

  decline: {
    name: "decline",
    description:
      "Refuse to answer. Use when the question is out of scope (not Mexican economic geography), unsafe, or fundamentally unanswerable with available data.",
    input_schema: {
      type: "object",
      properties: {
        reasoning: {
          type: "string",
          description: "Brief explanation in Spanish, addressed to the user.",
        },
      },
      required: ["reasoning"],
    },
  },
};

export type RouterToolName = "call_endpoint" | "draft_sql" | "decline";

export const ROUTER_TOOL_LIST: ToolSchema[] = Object.values(ROUTER_TOOLS);
