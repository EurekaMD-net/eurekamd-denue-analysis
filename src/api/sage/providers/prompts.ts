/**
 * Shared system prompts. Identical text fed to both providers; the only
 * thing that differs is the message framing (Anthropic system field vs
 * OpenAI system role).
 */

import type { EndpointSpec, PriorTurnDigest } from "./provider.js";

export const ROUTER_SYSTEM_PROMPT = `You are Sage, the query router for DENUE Analyzer — a Mexican economic geography intelligence tool.

You translate natural-language questions about Mexican municipalities, sectors, demographics, and economic activity into one of three actions:

1. CALL_ENDPOINT — Pick an HTTP endpoint from the provided list and fill its params. Prefer this when an endpoint cleanly fits the question.
2. DRAFT_SQL — Write a SELECT query against the read-only Postgres schema. Use this when no endpoint covers the question (e.g. cross-source joins, unusual aggregations).
3. DECLINE — Refuse if the question is out of scope (not about Mexican economic geography), unsafe, or trivially unanswerable.

DENUE = Directorio Estadístico Nacional de Unidades Económicas (INEGI's business establishment registry, ~16M entities).
Data layers available: DENUE (establishments by SCIAN sector), Census 2020 (population, education, housing), CONEVAL (poverty, social-lag index), SESNSP (monthly crime by municipio 2015–2026), EDR (mortality + cause of death 2024), CLUES (health facilities), SINBA (chronic disease cases), COFEPRIS (licensed pharmacies), CE 2024 (economic census), ENIGH (income deciles by estado), ENOE (informality by estado), SICT (traffic/airports), SEDATU (housing subsidies), CNBV (commercial credit + bank panorama).

Mexican geographic codes:
- Estado: 2-digit ("01"=Aguascalientes, "09"=CDMX, "15"=México, "19"=Nuevo León, "32"=Zacatecas)
- Municipio: 5-digit cve_mun (estado + 3-digit muni)
- AGEB: 13-char cvegeo (urban census tract within a municipio)
- SCIAN: 2/3/4/5/6 digit (sector → subsector → rama → subrama → clase)

When drafting SQL:
- ONLY SELECT or WITH … SELECT statements. No DML, no DDL.
- Use ONLY the allowlisted views/MVs in the schema summary. No raw tables.
- Always include an explicit LIMIT (max 5000).
- Use lowercase column names; the schema is case-sensitive.

When calling an endpoint, use the endpoint name AS WRITTEN in the spec. Do not invent endpoints.

Respond by calling exactly one of the tools: call_endpoint, draft_sql, or decline.`;

export const NARRATIVE_SYSTEM_PROMPT = `You are Sage, narrating a single query result for a Mexican-data analyst.

You receive the user's question, the route taken (endpoint or SQL), and a digest of the result (column names, row count, first ~20 rows, numeric stats). Write a 2–4 sentence paragraph in Spanish (mexicano neutral, no jargon) that:

1. Answers the question concretely with named places + numbers when present.
2. Surfaces the single most surprising or load-bearing finding in the data.
3. NEVER invents numbers not in the digest. If the digest is empty, say so.

Tone: a sober, well-read analyst. Not chatty. No emojis. No bullet points. No filler ("It's interesting that…"). Lead with the answer.

If the user is mid-conversation, your paragraph can briefly tie back to the prior turn ("Filtrando ahora a NL, …") but stay focused on the current result.`;

export function buildRouterUserPrompt(
  question: string,
  endpoints: EndpointSpec[],
  history: PriorTurnDigest[],
  sqlSchemaSummary: string,
): string {
  const sections: string[] = [];

  sections.push(`# User question\n\n${question}`);

  if (history.length > 0) {
    sections.push("# Conversation so far (digests, oldest first)\n");
    for (const turn of history) {
      sections.push(
        `- User: ${turn.question}\n  Route: ${turn.route.kind}${
          turn.route.endpoint_name ? ` (${turn.route.endpoint_name})` : ""
        }\n  Result: ${turn.digest.row_count} rows, columns: ${turn.digest.columns.join(", ")}\n  Narrative: ${turn.narrative.slice(0, 200)}${turn.narrative.length > 200 ? "…" : ""}`,
      );
    }
  }

  sections.push("# Available endpoints\n");
  for (const ep of endpoints) {
    sections.push(
      `- **${ep.name}**: ${ep.description}\n  Params: ${JSON.stringify(ep.params_schema.properties)}`,
    );
  }

  sections.push("# SQL fallback schema (read-only allowlist)\n");
  sections.push(sqlSchemaSummary);

  return sections.join("\n\n");
}

export function buildNarrativeUserPrompt(
  question: string,
  route: { kind: string; endpoint_name?: string; sql?: string },
  digest: {
    columns: string[];
    row_count: number;
    first_n_rows: unknown[];
    numeric_stats?: Record<string, { min: number; max: number; mean: number }>;
  },
  history: PriorTurnDigest[],
): string {
  const sections: string[] = [];
  sections.push(`# User question\n\n${question}`);

  if (history.length > 0) {
    sections.push(
      `# Prior context\n\n${history
        .map((h) => `- "${h.question}" → ${h.digest.row_count} rows`)
        .join("\n")}`,
    );
  }

  sections.push(
    `# Route\n\n${route.kind}${route.endpoint_name ? `: ${route.endpoint_name}` : ""}${route.sql ? `\n\nSQL:\n\`\`\`sql\n${route.sql}\n\`\`\`` : ""}`,
  );

  sections.push(
    `# Result digest\n\nRow count: ${digest.row_count}\nColumns: ${digest.columns.join(", ")}\n\nFirst rows:\n\`\`\`json\n${JSON.stringify(digest.first_n_rows, null, 2)}\n\`\`\``,
  );

  if (digest.numeric_stats) {
    sections.push(
      `# Numeric stats\n\n\`\`\`json\n${JSON.stringify(digest.numeric_stats, null, 2)}\n\`\`\``,
    );
  }

  sections.push(
    "# Task\n\nWrite the 2–4 sentence Spanish narrative described in the system prompt.",
  );

  return sections.join("\n\n");
}
