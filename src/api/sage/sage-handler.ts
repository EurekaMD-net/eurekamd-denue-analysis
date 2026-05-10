/**
 * POST /sage/query — multi-turn LLM gateway. SSE-streamed.
 *
 * Event sequence per turn:
 *   thread → { thread_id }       (always; first event)
 *   route  → RouteOutput payload (router decision)
 *   table  → { columns, rows }   (only if data was retrieved)
 *   chart  → { chart_type, x_col, y_col, … } (only if table emitted)
 *   narrative → { text }         (streamed token-by-token in `delta` events)
 *   delta  → { text }            (intermediate narrative tokens)
 *   usage  → cumulative usage telemetry
 *   error  → structured failure (terminal)
 *   done   → terminal success
 */

import type { Context } from "hono";
import type { ApiServerConfig } from "../types.js";
import {
  SAGE_ENDPOINT_CATALOG,
  SAGE_SQL_SCHEMA_SUMMARY,
} from "./endpoint-catalog.js";
import { dispatchEndpoint, buildDigest } from "./dispatcher.js";
import { executeGatedSql } from "./sql-gate.js";
import {
  appendAudit,
  appendTurn,
  createThread,
  deleteThread,
  getThread,
} from "./thread-store.js";
import type {
  NarrativeInput,
  RouteOutput,
  PriorTurnDigest,
} from "./providers/provider.js";
import type { Hono } from "hono";

const HISTORY_WINDOW = 5;
// Hard cap on turns per thread — beyond this writes are rejected. This
// is BOTH a DoS defense (unbounded JSONB growth on a single thread row)
// AND a guard against runaway prompts (closure audit W5-sec).
const MAX_TURNS_PER_THREAD = 50;
// Min/max for caller-supplied row cap on SQL fallback. Even though the
// SQL gate validates parseable SQL, an attacker who passes a non-integer
// max_rows would otherwise see it injected into `LIMIT ${cap}`. The
// integer/range check below kills that pathway (closure audit W3-sec).
const MIN_ROW_CAP = 1;
const MAX_ROW_CAP = 5000;

export interface SageQueryBody {
  thread_id?: string | null;
  question?: string;
  max_rows?: number;
}

/**
 * Render the result digest's most likely chart by inspecting columns.
 * Heuristics, not magic: if there are >=2 columns and one is numeric
 * and the other looks categorical, prefer a bar chart. Time-like cols
 * pick line. Otherwise table-only.
 */
function pickChartType(digest: {
  columns: string[];
  first_n_rows: unknown[];
  numeric_stats?: Record<string, { min: number; max: number; mean: number }>;
}): { chart_type: string; x_col?: string; y_col?: string } | null {
  if (digest.first_n_rows.length === 0) return null;

  const numericCols = Object.keys(digest.numeric_stats ?? {});
  const allCols = digest.columns;
  const nonNumeric = allCols.filter((c) => !numericCols.includes(c));

  // Time-series shape: column named like ano/year/fecha/mes
  const timeCol = nonNumeric.find((c) =>
    /^(ano|year|fecha|mes|month|date|periodo)$/i.test(c),
  );
  if (timeCol && numericCols[0]) {
    return { chart_type: "line", x_col: timeCol, y_col: numericCols[0] };
  }

  // Default bar: first categorical × first numeric
  if (nonNumeric[0] && numericCols[0]) {
    return { chart_type: "bar", x_col: nonNumeric[0], y_col: numericCols[0] };
  }
  return null;
}

export function makeSageQueryHandler(app: Hono, config: ApiServerConfig) {
  return async (c: Context) => {
    const provider = config.sageProvider;
    if (!provider) {
      return c.json(
        { error: "Sage provider not configured on this server." },
        503,
      );
    }

    let body: SageQueryBody;
    try {
      body = (await c.req.json()) as SageQueryBody;
    } catch {
      return c.json({ error: "Body must be JSON." }, 400);
    }
    const question = (body.question ?? "").trim();
    if (question.length < 3) {
      return c.json({ error: "question must be at least 3 chars." }, 400);
    }
    if (question.length > 2000) {
      return c.json({ error: "question must be under 2000 chars." }, 400);
    }
    // Validate max_rows BEFORE it reaches the SQL gate. Without this
    // check, a non-integer payload (e.g. "5000); DROP TABLE x; --") would
    // be interpolated into `LIMIT ${cap}` in applyRowCap; the SQL parser
    // rejects the resulting query, but the wrapped-SQL single-statement
    // invariant is violated upstream. Closure audit W3-sec.
    let maxRows: number = MAX_ROW_CAP;
    if (body.max_rows !== undefined && body.max_rows !== null) {
      if (
        !Number.isInteger(body.max_rows) ||
        body.max_rows < MIN_ROW_CAP ||
        body.max_rows > MAX_ROW_CAP
      ) {
        return c.json(
          {
            error: `max_rows must be an integer in [${MIN_ROW_CAP}, ${MAX_ROW_CAP}].`,
          },
          400,
        );
      }
      maxRows = body.max_rows;
    }

    const threadId =
      body.thread_id && /^[0-9a-f-]{36}$/i.test(body.thread_id)
        ? body.thread_id
        : createThread({ dbContainer: config.dbContainer });

    // Reject when the thread is already at the cap so we don't pay LLM
    // cost for a turn we won't be able to persist.
    const existingTurnCount = getThread(
      { dbContainer: config.dbContainer },
      threadId,
    ).length;
    if (existingTurnCount >= MAX_TURNS_PER_THREAD) {
      return c.json(
        {
          error: `thread has reached the cap of ${MAX_TURNS_PER_THREAD} turns; start a new thread.`,
          code: "THREAD_TURN_CAP",
        },
        429,
      );
    }

    const priorTurns = getThread({ dbContainer: config.dbContainer }, threadId)
      .slice(-HISTORY_WINDOW)
      .map<PriorTurnDigest>((t) => ({
        question: t.question,
        route: t.route,
        digest: {
          columns: t.digest.columns,
          row_count: t.digest.row_count,
          first_5_rows: t.digest.first_5_rows,
          numeric_stats: t.digest.numeric_stats,
        },
        narrative: t.narrative,
      }));

    // AbortController for the whole turn: SSE cancel() aborts it, which
    // in turn cancels the upstream LLM call, in-process app.fetch, and
    // the gated SQL execution. Without this, a client disconnect during
    // the narrative stream would leave the Anthropic stream open for up
    // to the 30s SDK timeout while accruing audit + cost rows
    // (closure audit C1-perf + W7-sec).
    const abortCtrl = new AbortController();

    // Stream SSE.
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown) => {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          try {
            controller.enqueue(enc.encode(payload));
          } catch {
            // Controller already closed (client disconnected); silently
            // swallow so the downstream cleanup proceeds.
          }
        };

        try {
          send("thread", { thread_id: threadId });

          // ----- 1. Router pass --------------------------------------
          const routerResult = await provider.routeAndDraft(
            {
              question,
              endpoints: SAGE_ENDPOINT_CATALOG,
              history: priorTurns,
              sql_schema_summary: SAGE_SQL_SCHEMA_SUMMARY,
            },
            abortCtrl.signal,
          );
          appendAudit(
            { dbContainer: config.dbContainer },
            {
              thread_id: threadId,
              call_kind: "router",
              provider: routerResult.usage.provider,
              model: routerResult.usage.model,
              prompt: { question, history_n: priorTurns.length },
              output: routerResult.output,
              usage: routerResult.usage,
              error_code: null,
              error_message: null,
            },
          );
          send("route", routerResult.output);
          send("usage", routerResult.usage);

          const route: RouteOutput = routerResult.output;

          // ----- 2. Execute the route --------------------------------
          let columns: string[] = [];
          let rows: unknown[] = [];
          let digestForNarrative: ReturnType<typeof buildDigest> = {
            columns: [],
            row_count: 0,
            first_n_rows: [],
          };

          if (route.kind === "decline") {
            send("narrative", { text: route.reasoning });
            send("done", { turn_id: null });
            controller.close();
            return;
          }

          if (route.kind === "endpoint") {
            const dispatched = await dispatchEndpoint(
              app,
              config.apiKey,
              route,
            );
            if (!dispatched.ok) {
              send("error", {
                code: dispatched.code,
                message: dispatched.message,
              });
              controller.close();
              return;
            }
            const digest = buildDigest(dispatched.body);
            digestForNarrative = digest;
            columns = digest.columns;
            rows = digest.first_n_rows;
            send("table", { columns, rows, row_count: digest.row_count });
          } else {
            // SQL fallback. `maxRows` is the validated caller cap; the
            // gate clamps to MAX_ROW_CAP=5000 anyway via its own default.
            const result = await executeGatedSql(route.sql, {
              dbContainer: config.dbContainer,
              rowCap: maxRows,
            });
            if (!result.ok) {
              send("error", {
                code: result.error.code,
                message: result.error.message,
              });
              controller.close();
              return;
            }
            const digest = buildDigest(result.data.rows);
            digestForNarrative = digest;
            columns = result.data.columns;
            rows = digest.first_n_rows;
            send("table", {
              columns,
              rows,
              row_count: result.data.rows.length,
            });
          }

          // ----- 3. Chart hint ---------------------------------------
          const chart = pickChartType(digestForNarrative);
          if (chart) send("chart", chart);

          // ----- 4. Narrative stream ---------------------------------
          const narrativeInput: NarrativeInput = {
            question,
            route: {
              kind: route.kind,
              endpoint_name:
                route.kind === "endpoint" ? route.endpoint_name : undefined,
              sql: route.kind === "sql" ? route.sql : undefined,
            },
            digest: digestForNarrative,
            history: priorTurns,
          };
          let fullNarrative = "";
          let narrativeUsage = null as null | typeof routerResult.usage;
          for await (const chunk of provider.writeNarrativeStream(
            narrativeInput,
            abortCtrl.signal,
          )) {
            if (chunk.text) {
              fullNarrative += chunk.text;
              send("delta", { text: chunk.text });
            }
            if (chunk.usage) narrativeUsage = chunk.usage;
          }
          send("narrative", { text: fullNarrative });
          if (narrativeUsage) {
            appendAudit(
              { dbContainer: config.dbContainer },
              {
                thread_id: threadId,
                call_kind: "narrative",
                provider: narrativeUsage.provider,
                model: narrativeUsage.model,
                prompt: { question },
                output: { text: fullNarrative },
                usage: narrativeUsage,
                error_code: null,
                error_message: null,
              },
            );
            send("usage", narrativeUsage);
          }

          // ----- 5. Persist the turn ---------------------------------
          const turnRec = appendTurn(
            { dbContainer: config.dbContainer },
            threadId,
            {
              question,
              route: {
                kind: route.kind,
                endpoint_name:
                  route.kind === "endpoint" ? route.endpoint_name : undefined,
                sql: route.kind === "sql" ? route.sql : undefined,
              },
              digest: {
                columns: digestForNarrative.columns,
                row_count: digestForNarrative.row_count,
                first_5_rows: digestForNarrative.first_n_rows.slice(0, 5),
                numeric_stats: digestForNarrative.numeric_stats,
              },
              narrative: fullNarrative,
            },
          );
          send("done", { turn_id: turnRec.turn_id });
          controller.close();
        } catch (err) {
          // AbortError on caller disconnect is the expected exit path;
          // don't bother emitting an error event because the client is
          // already gone.
          const isAbort =
            err !== null &&
            typeof err === "object" &&
            "name" in err &&
            (err as { name?: string }).name === "AbortError";
          if (!isAbort) {
            const message = err instanceof Error ? err.message : String(err);
            send("error", { code: "SAGE_INTERNAL", message });
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        // Client disconnected (browser tab closed, network drop). Abort
        // the upstream LLM stream and any in-flight DB query so we
        // stop accruing cost / holding connections.
        abortCtrl.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  };
}

export function makeGetThreadHandler(config: ApiServerConfig) {
  return (c: Context) => {
    const id = c.req.param("id") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return c.json({ error: "thread_id must be a UUID." }, 400);
    }
    const turns = getThread({ dbContainer: config.dbContainer }, id);
    return c.json({ thread_id: id, turns });
  };
}

export function makeDeleteThreadHandler(config: ApiServerConfig) {
  return (c: Context) => {
    const id = c.req.param("id") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return c.json({ error: "thread_id must be a UUID." }, 400);
    }
    deleteThread({ dbContainer: config.dbContainer }, id);
    return c.json({ thread_id: id, deleted: true });
  };
}

export function sageHealthHandler(config: ApiServerConfig) {
  return (c: Context) => {
    const provider = config.sageProvider;
    return c.json({
      configured: !!provider,
      provider: provider?.name ?? null,
      router_model: provider?.routerModel ?? null,
      narrative_model: provider?.narrativeModel ?? null,
    });
  };
}
