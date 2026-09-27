/**
 * POST /sage/query — multi-turn LLM gateway. SSE-streamed.
 *
 * Event sequence per turn:
 *   thread → { thread_id }       (always; first event)
 *   route  → RouteOutput payload (router decision)
 *   table  → { columns, rows, row_count, truncated } (only if data was retrieved)
 *   chart  → { chart_type, x_col, y_col, … } (only if table emitted)
 *   narrative → { text }         (streamed token-by-token in `delta` events)
 *   delta  → { text }            (intermediate narrative tokens)
 *   usage  → cumulative usage telemetry
 *   error  → structured failure (terminal)
 *   done   → terminal success
 */

import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { ApiServerConfig } from "../types.js";
import type { AuthedUser } from "../middleware/bearer-auth.js";
import {
  SAGE_ENDPOINT_CATALOG,
  SAGE_SQL_SCHEMA_SUMMARY,
} from "./endpoint-catalog.js";
import {
  dispatchEndpoint,
  buildDigest,
  normalizeBody,
  isSingleRecordEndpoint,
  ID_COLUMN_RE,
} from "./dispatcher.js";
import { executeGatedSql, DEFAULT_ROW_CAP } from "./sql-gate.js";
import {
  API_KEY_OWNER,
  appendAudit,
  appendTurn,
  deleteThread,
  getThread,
  getThreadHead,
  type AuditEntry,
} from "./thread-store.js";
import {
  sageUsageOf,
  type NarrativeInput,
  type RouteOutput,
  type PriorTurnDigest,
  type UsageNormalized,
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
// Rows the `table` event carries when the caller sets no max_rows. The
// narrative digest still sees only its own 20 rows.
const TABLE_ROW_CAP = DEFAULT_ROW_CAP;
const TIMEOUT_MESSAGE = "La consulta tardó demasiado; intenta de nuevo.";
// Public messages persisted with a turn that died on an exception; the
// raw error text stays in the audit row.
const INTERNAL_MESSAGE = "Sage no pudo responder; intenta de nuevo.";
const ABORTED_MESSAGE = "La consulta se canceló.";
// Public message for a router pass that produced no usable decision
// (audit #84); the provider's detail stays in the audit row.
const ROUTER_ERROR_MESSAGE =
  "Sage no pudo decidir cómo responder; reformula la pregunta.";
// Strict UUID (audit #92): sage_threads.thread_id is a uuid column, so a
// looser pattern let a cast error surface as a 500.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Cap on sage_turns_audit.error_message (raw PG text stays server-side).
const AUDIT_ERROR_MAX = 500;

/**
 * The principal a thread belongs to (audit #11/#28): the JWT sub, or one
 * shared owner for the X-Api-Key path, which carries no identity.
 */
function ownerOf(c: Context): string {
  return (c.get("user") as AuthedUser | undefined)?.user_id ?? API_KEY_OWNER;
}

/**
 * Audit rows are written in the background (audit #208): a slow or failed
 * INSERT must not delay the SSE stream or fail the turn.
 */
function auditInBackground(config: ApiServerConfig, entry: AuditEntry): void {
  appendAudit({ dbContainer: config.dbContainer }, entry).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[sage] audit write failed: ${msg}\n`);
    },
  );
}

export interface SageQueryBody {
  thread_id?: string | null;
  question?: string;
  max_rows?: number;
}

/**
 * Render the result digest's most likely chart by inspecting columns.
 * Heuristics, not magic: if there are >=2 columns and one is numeric
 * and the other looks categorical, prefer a bar chart. Time-like cols
 * pick line. Otherwise table-only. The y axis is never a time column
 * or an ID-like column (cve_*, clave, cvegeo, scian, ranking).
 */
export function pickChartType(digest: {
  columns: string[];
  first_n_rows: unknown[];
  numeric_stats?: Record<string, { min: number; max: number; mean: number }>;
}): { chart_type: string; x_col?: string; y_col?: string } | null {
  if (digest.first_n_rows.length === 0) return null;

  const numericCols = Object.keys(digest.numeric_stats ?? {});
  const allCols = digest.columns;
  const nonNumeric = allCols.filter((c) => !numericCols.includes(c));

  // Time-series shape: column named like ano/year/fecha/mes. Searched
  // across ALL columns: ano/year is numeric on both routes.
  const isTime = (c: string) =>
    /^(ano|year|fecha|mes|month|date|periodo)$/i.test(c);
  const timeCol = allCols.find(isTime);
  const yCol = numericCols.find((c) => !isTime(c) && !ID_COLUMN_RE.test(c));
  if (timeCol && yCol) {
    return { chart_type: "line", x_col: timeCol, y_col: yCol };
  }

  // Default bar: first categorical (a name before an ID) × first measure
  const xCol = nonNumeric.find((c) => !ID_COLUMN_RE.test(c)) ?? nonNumeric[0];
  if (xCol && yCol) {
    return { chart_type: "bar", x_col: xCol, y_col: yCol };
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
    let maxRows: number | undefined;
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

    // A present but malformed thread_id is an error, not a silent new
    // thread (audit #92).
    if (
      body.thread_id !== undefined &&
      body.thread_id !== null &&
      (typeof body.thread_id !== "string" || !UUID_RE.test(body.thread_id))
    ) {
      return c.json({ error: "thread_id must be a UUID." }, 400);
    }
    const owner = ownerOf(c);
    const existingThreadId = body.thread_id ?? null;
    // A new thread's row is created by its first appendTurn (lazy
    // creation, audit #82/#207), so a turn that dies leaves no empty row.
    const threadId = existingThreadId ?? randomUUID();

    // One read gives both the cap check and the history window (audit
    // #88/#208); a thread created by this request has neither. A thread
    // that is gone or belongs to someone else is a 404 (audit #11/#28/#82).
    const head = existingThreadId
      ? await getThreadHead(
          { dbContainer: config.dbContainer },
          existingThreadId,
          owner,
          HISTORY_WINDOW,
        )
      : { turnCount: 0, lastTurns: [] };
    if (!head) {
      return c.json(
        { error: "thread not found.", code: "THREAD_NOT_FOUND" },
        404,
      );
    }

    // Reject when the thread is already at the cap so we don't pay LLM
    // cost for a turn we won't be able to persist.
    if (head.turnCount >= MAX_TURNS_PER_THREAD) {
      return c.json(
        {
          error: `thread has reached the cap of ${MAX_TURNS_PER_THREAD} turns; start a new thread.`,
          code: "THREAD_TURN_CAP",
        },
        429,
      );
    }

    const priorTurns = head.lastTurns.map<PriorTurnDigest>((t) => ({
      question: t.question,
      route: t.route,
      digest: {
        columns: t.digest.columns,
        row_count: t.digest.row_count,
        first_5_rows: t.digest.first_5_rows,
        numeric_stats: t.digest.numeric_stats,
      },
      narrative: t.narrative,
      ...(t.error ? { error: t.error } : {}),
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

        // Audit rows are queued and written when the turn ends, after its
        // thread row exists (lazy creation). Every failure branch queues
        // one too, with error_code/error_message (audit #83/#207).
        const audits: AuditEntry[] = [];
        let stage: AuditEntry["call_kind"] | "persist" = "router";
        const noUsage = (
          model: string,
          latency_ms: number,
        ): UsageNormalized => ({
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          latency_ms,
          provider: provider.name,
          model,
        });
        const emptyDigest = { columns: [], row_count: 0, first_5_rows: [] };
        // The route a failed turn is persisted with: "router" until the
        // router pass has returned one.
        let failedRoute: PriorTurnDigest["route"] = { kind: "router" };
        // A failed route is persisted as a turn with its public error, so
        // the next router pass sees it and the turn cap counts it (audit
        // #89). A failed write is logged; the client still gets the error.
        const persistFailedTurn = async (
          routeRec: PriorTurnDigest["route"],
          error: { code: string; message: string },
        ) => {
          try {
            await appendTurn(
              { dbContainer: config.dbContainer },
              threadId,
              owner,
              {
                question,
                route: routeRec,
                digest: emptyDigest,
                narrative: "",
                error,
              },
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[sage] failed-turn write failed: ${msg}\n`);
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
          const route: RouteOutput = routerResult.output;
          // No usable decision (no tool call, bad args, SDK error result):
          // an audited error, not a decline in a 200 stream (audit #84).
          if (route.kind === "error") {
            audits.push({
              thread_id: threadId,
              call_kind: "router",
              provider: routerResult.usage.provider,
              model: routerResult.usage.model,
              prompt: { question, history_n: priorTurns.length },
              output: route,
              usage: routerResult.usage,
              error_code: route.code,
              error_message: route.detail.slice(0, AUDIT_ERROR_MAX),
            });
            send("usage", routerResult.usage);
            await persistFailedTurn(failedRoute, {
              code: route.code,
              message: ROUTER_ERROR_MESSAGE,
            });
            send("error", { code: route.code, message: ROUTER_ERROR_MESSAGE });
            controller.close();
            return;
          }
          send("route", route);
          audits.push({
            thread_id: threadId,
            call_kind: "router",
            provider: routerResult.usage.provider,
            model: routerResult.usage.model,
            prompt: { question, history_n: priorTurns.length },
            output: route,
            usage: routerResult.usage,
            error_code: null,
            error_message: null,
          });
          send("usage", routerResult.usage);

          const routeRec: NarrativeInput["route"] = {
            kind: route.kind,
            endpoint_name:
              route.kind === "endpoint" ? route.endpoint_name : undefined,
            sql: route.kind === "sql" ? route.sql : undefined,
          };
          failedRoute = routeRec;

          // ----- 2. Execute the route --------------------------------
          let columns: string[] = [];
          let rows: unknown[] = [];
          let digestForNarrative: ReturnType<typeof buildDigest> & {
            truncated?: boolean;
          } = {
            columns: [],
            row_count: 0,
            first_n_rows: [],
          };

          if (route.kind === "decline" || route.kind === "clarify") {
            // Persisted like any other turn (audit #89). A clarify is the
            // model's own text reply (audit #84).
            send("narrative", { text: route.reasoning });
            stage = "persist";
            const declined = await appendTurn(
              { dbContainer: config.dbContainer },
              threadId,
              owner,
              {
                question,
                route: routeRec,
                digest: emptyDigest,
                narrative: route.reasoning,
              },
            );
            send("done", { turn_id: declined.turn_id });
            controller.close();
            return;
          }

          if (route.kind === "endpoint") {
            stage = "dispatch";
            const t0 = Date.now();
            const dispatched = await dispatchEndpoint(
              app,
              config.apiKey,
              route,
              abortCtrl.signal,
            );
            if (!dispatched.ok) {
              audits.push({
                thread_id: threadId,
                call_kind: "dispatch",
                provider: provider.name,
                model: provider.routerModel,
                prompt: {
                  endpoint_name: route.endpoint_name,
                  params: route.params,
                },
                output: null,
                usage: noUsage(provider.routerModel, Date.now() - t0),
                error_code: dispatched.code,
                error_message:
                  `${dispatched.status ? `HTTP ${dispatched.status}: ` : ""}${dispatched.message}`.slice(
                    0,
                    AUDIT_ERROR_MAX,
                  ),
              });
              await persistFailedTurn(routeRec, {
                code: dispatched.code,
                message: dispatched.message,
              });
              send("error", {
                code: dispatched.code,
                message: dispatched.message,
              });
              controller.close();
              return;
            }
            const bodyOpts = {
              singleRecord: isSingleRecordEndpoint(route.endpoint_name),
            };
            const digest = buildDigest(dispatched.body, undefined, bodyOpts);
            digestForNarrative = digest;
            columns = digest.columns;
            rows = normalizeBody(dispatched.body, bodyOpts).rows.slice(
              0,
              TABLE_ROW_CAP,
            );
            send("table", {
              columns,
              rows,
              row_count: digest.row_count,
              truncated: digest.row_count > rows.length,
            });
          } else {
            // SQL fallback. `maxRows` is the validated caller cap
            // (default TABLE_ROW_CAP). One extra row is fetched so the
            // table can say whether the cap cut the result.
            const cap = maxRows ?? TABLE_ROW_CAP;
            stage = "sql_gate";
            const t0 = Date.now();
            const result = await executeGatedSql(route.sql, {
              dbContainer: config.dbContainer,
              rowCap: cap + 1,
              signal: abortCtrl.signal,
            });
            if (!result.ok) {
              // The raw PG text (detail) goes to the audit only; the
              // client and the persisted turn get the redacted message.
              audits.push({
                thread_id: threadId,
                call_kind: "sql_gate",
                provider: provider.name,
                model: provider.routerModel,
                prompt: { sql: route.sql },
                output: null,
                usage: noUsage(provider.routerModel, Date.now() - t0),
                error_code: result.error.code,
                error_message: (
                  result.error.detail ?? result.error.message
                ).slice(0, AUDIT_ERROR_MAX),
              });
              await persistFailedTurn(routeRec, {
                code: result.error.code,
                message: result.error.message,
              });
              send("error", {
                code: result.error.code,
                message: result.error.message,
              });
              controller.close();
              return;
            }
            rows = result.data.rows.slice(0, cap);
            const truncated = result.data.rows.length > cap;
            const digest = {
              ...buildDigest(rows),
              ...(truncated ? { truncated } : {}),
            };
            digestForNarrative = digest;
            columns = result.data.columns;
            send("table", {
              columns,
              rows,
              row_count: rows.length,
              truncated,
            });
          }

          // ----- 3. Chart hint ---------------------------------------
          const chart = pickChartType(digestForNarrative);
          if (chart) send("chart", chart);

          // ----- 4. Narrative stream ---------------------------------
          stage = "narrative";
          const narrativeInput: NarrativeInput = {
            question,
            route: routeRec,
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
            audits.push({
              thread_id: threadId,
              call_kind: "narrative",
              provider: narrativeUsage.provider,
              model: narrativeUsage.model,
              prompt: { question },
              output: { text: fullNarrative },
              usage: narrativeUsage,
              error_code: null,
              error_message: null,
            });
            send("usage", narrativeUsage);
          }

          // ----- 5. Persist the turn ---------------------------------
          stage = "persist";
          const turnRec = await appendTurn(
            { dbContainer: config.dbContainer },
            threadId,
            owner,
            {
              question,
              route: routeRec,
              digest: {
                columns: digestForNarrative.columns,
                row_count: digestForNarrative.row_count,
                first_5_rows: digestForNarrative.first_n_rows.slice(0, 5),
                numeric_stats: digestForNarrative.numeric_stats,
                ...(digestForNarrative.truncated ? { truncated: true } : {}),
              },
              narrative: fullNarrative,
            },
          );
          send("done", { turn_id: turnRec.turn_id });
          controller.close();
        } catch (err) {
          // A client disconnect (our own signal) is the expected exit
          // path; don't emit an error because the client is already gone.
          // Any other abort is a provider timer: the SDK's AbortError
          // keeps name "Error", and the OpenAI path throws a DOMException
          // named "TimeoutError" (audit #90/#206).
          const aborted = abortCtrl.signal.aborted;
          const isTimeout =
            err instanceof AbortError ||
            (err as { name?: string } | null)?.name === "TimeoutError";
          const message = err instanceof Error ? err.message : String(err);
          const code = aborted
            ? "SAGE_ABORTED"
            : isTimeout
              ? "SAGE_TIMEOUT"
              : "SAGE_INTERNAL";
          // Audit the failed stage with whatever usage the provider had
          // spent (audit #83). A failed persist has no call to audit.
          if (stage !== "persist") {
            const model =
              stage === "narrative"
                ? provider.narrativeModel
                : provider.routerModel;
            const usage = sageUsageOf(err) ?? noUsage(model, 0);
            audits.push({
              thread_id: threadId,
              call_kind: stage,
              provider: usage.provider,
              model: usage.model,
              prompt: { question },
              output: null,
              usage,
              error_code: code,
              error_message: message.slice(0, AUDIT_ERROR_MAX),
            });
            // Persist the failed turn too, so the thread id the `thread`
            // event already handed out always has a row and the next
            // question on it is not a 404 (lazy creation, audit #89).
            await persistFailedTurn(failedRoute, {
              code,
              message: aborted
                ? ABORTED_MESSAGE
                : isTimeout
                  ? TIMEOUT_MESSAGE
                  : INTERNAL_MESSAGE,
            });
          }
          if (!aborted) {
            if (isTimeout) {
              send("error", { code: "SAGE_TIMEOUT", message: TIMEOUT_MESSAGE });
            } else {
              send("error", { code: "SAGE_INTERNAL", message });
            }
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        } finally {
          for (const entry of audits) auditInBackground(config, entry);
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
  return async (c: Context) => {
    const id = c.req.param("id") ?? "";
    if (!UUID_RE.test(id)) {
      return c.json({ error: "thread_id must be a UUID." }, 400);
    }
    const turns = await getThread(
      { dbContainer: config.dbContainer },
      id,
      ownerOf(c),
    );
    if (!turns) {
      return c.json(
        { error: "thread not found.", code: "THREAD_NOT_FOUND" },
        404,
      );
    }
    return c.json({ thread_id: id, turns });
  };
}

export function makeDeleteThreadHandler(config: ApiServerConfig) {
  return async (c: Context) => {
    const id = c.req.param("id") ?? "";
    if (!UUID_RE.test(id)) {
      return c.json({ error: "thread_id must be a UUID." }, 400);
    }
    const deleted = await deleteThread(
      { dbContainer: config.dbContainer },
      id,
      ownerOf(c),
    );
    if (!deleted) {
      return c.json(
        { error: "thread not found.", code: "THREAD_NOT_FOUND" },
        404,
      );
    }
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
