import { useCallback, useEffect, useRef, useState } from "react";
import { useUiStore } from "../store";
import { ApiError } from "../api/client";
import {
  fetchSageHealth,
  fetchSageThread,
  sageQueryStream,
  type SageRoute,
  type SageStoredTurn,
} from "../api/sage-client";
import { useQuery } from "@tanstack/react-query";
import {
  listSavedThreads,
  removeThread,
  upsertThread,
  type SavedThreadIndexEntry,
} from "../lib/sage-threads-store";

interface ChatTurn {
  question: string;
  route: SageRoute | null;
  columns: string[];
  rows: unknown[];
  rowCount: number;
  chart: { chart_type: string; x_col?: string; y_col?: string } | null;
  narrative: string;
  error: { code: string; message: string } | null;
  done: boolean;
}

/**
 * Sage mode — LLM gateway. Multi-turn refinement persists thread_id in
 * component state; refreshing the page starts a new thread (the
 * persisted thread is recoverable via GET /sage/thread/:id but the
 * "load thread" UI is out of scope for the demo).
 */
export function SageMode() {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  const userId = useUiStore((s) => s.session?.user.id ?? null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  // RH-4: per-user saved-thread sidebar, fed by localStorage. Hydrated
  // once on mount and after every turn so the user sees their threads
  // appear in real time.
  const [savedThreads, setSavedThreads] = useState<SavedThreadIndexEntry[]>(
    () => listSavedThreads(userId),
  );
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  // Transient error surfaced under the sidebar when a `loadThread` call
  // fails. Pruning vs. retainment of the local index is decided in
  // `loadThread` itself; this state only drives the human-facing copy.
  const [loadErrorMsg, setLoadErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Re-hydrate the sidebar when the signed-in user changes (sign-out /
  // sign-in cycle in the same tab). Without this, User B would briefly
  // see User A's thread index until they refreshed.
  useEffect(() => {
    setSavedThreads(listSavedThreads(userId));
  }, [userId]);

  const health = useQuery({
    queryKey: ["sage", "health"],
    queryFn: () => fetchSageHealth(accessToken),
    enabled: accessToken !== null,
    staleTime: 60_000,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  const sendQuery = useCallback(
    async (question: string) => {
      if (!question.trim() || streaming) return;
      setStreaming(true);
      const placeholder: ChatTurn = {
        question,
        route: null,
        columns: [],
        rows: [],
        rowCount: 0,
        chart: null,
        narrative: "",
        error: null,
        done: false,
      };
      setTurns((t) => [...t, placeholder]);
      setInput("");
      const idx = turns.length;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      // Register with the global abort registry so signOut() can cancel
      // this stream — without this, an in-flight SSE keeps consuming
      // bytes using the (still valid until exp) JWT after sign-out
      // (audit C C2).
      const unregister = useUiStore.getState().registerAbort(ctrl);
      try {
        for await (const ev of sageQueryStream(
          question,
          threadId,
          accessToken,
          ctrl.signal,
        )) {
          setTurns((current) => {
            const next = [...current];
            const t = next[idx] ?? placeholder;
            switch (ev.type) {
              case "thread":
                setThreadId(ev.thread_id);
                break;
              case "route":
                next[idx] = { ...t, route: ev.payload };
                break;
              case "table":
                next[idx] = {
                  ...t,
                  columns: ev.columns,
                  rows: ev.rows,
                  rowCount: ev.row_count,
                };
                break;
              case "chart":
                next[idx] = {
                  ...t,
                  chart: {
                    chart_type: ev.chart_type,
                    x_col: ev.x_col,
                    y_col: ev.y_col,
                  },
                };
                break;
              case "delta":
                next[idx] = { ...t, narrative: t.narrative + ev.text };
                break;
              case "narrative":
                next[idx] = { ...t, narrative: ev.text };
                break;
              case "error":
                next[idx] = {
                  ...t,
                  error: { code: ev.code, message: ev.message },
                  done: true,
                };
                break;
              case "done":
                next[idx] = { ...t, done: true };
                break;
              default:
                break;
            }
            return next;
          });
        }
      } catch (err) {
        // Operator-initiated abort (Nuevo hilo) zeroes the turns array
        // and ctrl.abort()s the stream. Don't emit a phantom error card
        // into the freshly-cleared thread (R2 audit C2).
        const isAbort =
          err !== null &&
          typeof err === "object" &&
          "name" in err &&
          (err as { name?: string }).name === "AbortError";
        if (!isAbort) {
          const message = err instanceof Error ? err.message : String(err);
          // Surface HTTP-status errors with a real code (R2 audit W4).
          // apiFetch throws Error("<status> ...") for 4xx/5xx; pull a
          // recognizable code out so the user sees RATE_LIMITED for 429.
          let code = "NETWORK";
          const statusMatch = /\b(\d{3})\b/.exec(message);
          if (statusMatch) {
            const s = Number(statusMatch[1]);
            if (s === 429) code = "RATE_LIMITED";
            else if (s === 401) code = "UNAUTHENTICATED";
            else if (s === 503) code = "PROVIDER_UNAVAILABLE";
            else code = `HTTP_${s}`;
          }
          setTurns((current) => {
            const next = [...current];
            const t = next[idx] ?? placeholder;
            next[idx] = {
              ...t,
              error: { code, message },
              done: true,
            };
            return next;
          });
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
        unregister();
      }
    },
    [accessToken, threadId, turns.length, streaming],
  );

  // Whenever the conversation state settles (streaming finished AND we
  // have a thread_id + at least one turn), upsert into the per-user
  // saved-threads index. Using the latest `turns` value here is fine —
  // it reflects the final shape because the SSE stream has drained.
  useEffect(() => {
    if (streaming) return;
    if (!threadId) return;
    if (turns.length === 0) return;
    const firstQ = turns[0]?.question ?? "";
    const lastQ = turns[turns.length - 1]?.question ?? firstQ;
    const next = upsertThread(userId, {
      thread_id: threadId,
      first_question: firstQ,
      last_question: lastQ,
      turn_count: turns.length,
      updated_at: Date.now(),
    });
    setSavedThreads(next);
  }, [streaming, threadId, turns, userId]);

  const newThread = useCallback(() => {
    abortRef.current?.abort();
    setThreadId(null);
    setTurns([]);
  }, []);

  const loadThread = useCallback(
    async (id: string) => {
      // Don't trample a streaming turn — the user must end it first.
      if (streaming) return;
      if (id === threadId) return; // already loaded
      abortRef.current?.abort();
      setLoadingThreadId(id);
      setLoadErrorMsg(null);
      try {
        const fetched = await fetchSageThread(id, accessToken);
        // Hydrate ChatTurn[] from the stored digest. Each saved turn
        // carries narrative + a slim digest (columns + first_5_rows,
        // server-truncated). We do NOT re-execute the SQL or hit the
        // endpoint — the goal is to let the user re-read prior
        // conversation, not re-run it. `chart` and `error` are not
        // persisted by the backend today, so they always restore as
        // null (audit C1 / W5).
        const hydrated: ChatTurn[] = fetched.turns.map((t: SageStoredTurn) => ({
          question: t.question,
          route: t.route,
          columns: t.digest?.columns ?? [],
          rows: t.digest?.first_5_rows ?? [],
          rowCount: t.digest?.row_count ?? 0,
          chart: null,
          narrative: t.narrative,
          error: null,
          done: true,
        }));
        setTurns(hydrated);
        setThreadId(fetched.thread_id);
      } catch (err) {
        // Audit W1: only treat 404 as "thread was deleted server-side"
        // and prune the local index. Transient 5xx / network / timeout
        // / 401-during-refresh must leave the entry alone — pruning on
        // every error would silently erase the user's history at the
        // first network blip.
        const status = err instanceof ApiError ? err.status : null;
        if (status === 404) {
          const next = removeThread(userId, id);
          setSavedThreads(next);
          setLoadErrorMsg("Este hilo ya no existe en el servidor.");
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn("[sage] failed to load thread", id, status, msg);
          setLoadErrorMsg(
            "No se pudo cargar el hilo. Reintenta en unos segundos.",
          );
        }
      } finally {
        setLoadingThreadId(null);
      }
    },
    [accessToken, streaming, threadId, userId],
  );

  const forgetThread = useCallback(
    (id: string) => {
      // localStorage-only — does NOT call DELETE /sage/thread/:id. The
      // user is "forgetting" this thread from their personal list, not
      // erasing it from the audit log.
      const next = removeThread(userId, id);
      setSavedThreads(next);
      if (id === threadId) {
        setThreadId(null);
        setTurns([]);
      }
    },
    [threadId, userId],
  );

  return (
    <div className="flex h-full bg-slate-950">
      {/* RH-4: saved-thread sidebar (localStorage-backed, per-user). */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-500">
            Hilos
          </span>
          <button
            type="button"
            onClick={newThread}
            disabled={streaming}
            className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 hover:border-cyan-700 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
            title="Inicia un hilo nuevo"
          >
            +
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {savedThreads.length === 0 ? (
            <p className="px-3 py-2 font-mono text-[10px] text-slate-600">
              Aún sin hilos guardados. Cada conversación se guarda en este
              navegador.
            </p>
          ) : (
            savedThreads.map((t) => (
              <ThreadRow
                key={t.thread_id}
                entry={t}
                active={t.thread_id === threadId}
                loading={t.thread_id === loadingThreadId}
                disabled={streaming}
                onPick={() => void loadThread(t.thread_id)}
                onForget={() => forgetThread(t.thread_id)}
              />
            ))
          )}
        </div>
        {loadErrorMsg && (
          <div
            className="border-t border-amber-900/50 bg-amber-950/40 px-3 py-1 font-mono text-[10px] text-amber-300"
            role="status"
          >
            {loadErrorMsg}
          </div>
        )}
        <div className="border-t border-slate-800 px-3 py-1 font-mono text-[9px] text-slate-600">
          máx. 20 hilos guardados
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-2">
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-cyan-500">
            Sage
          </span>
          {health.data && (
            <span className="font-mono text-[10px] text-slate-500">
              {health.data.configured ? (
                <>
                  {health.data.provider} · {health.data.router_model}
                </>
              ) : (
                <span className="text-amber-400">provider no configurado</span>
              )}
            </span>
          )}
          <div className="flex-1" />
          {threadId && (
            <button
              type="button"
              onClick={newThread}
              className="rounded border border-slate-700 px-2 py-0.5 font-mono text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
            >
              Nuevo hilo
            </button>
          )}
        </div>

        {/* Conversation */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-4 py-3 [scrollbar-color:#334155_transparent]"
        >
          {turns.length === 0 && <EmptyState onPick={(q) => sendQuery(q)} />}
          {turns.map((t, i) => (
            <TurnCard key={i} turn={t} />
          ))}
        </div>

        {/* Input */}
        <form
          className="border-t border-slate-800 bg-slate-900 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            sendQuery(input);
          }}
        >
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  sendQuery(input);
                }
              }}
              placeholder="Pregunta sobre municipios mexicanos, sectores, demografía, riesgo, salud, crédito…  (⌘+↵ para enviar)"
              disabled={streaming || !health.data?.configured}
              rows={2}
              className="flex-1 resize-none rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-600 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={streaming || !input.trim() || !health.data?.configured}
              className="rounded bg-cyan-700 px-4 font-mono text-xs text-slate-50 hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {streaming ? "…" : "Enviar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ThreadRowProps {
  entry: SavedThreadIndexEntry;
  active: boolean;
  loading: boolean;
  disabled: boolean;
  onPick: () => void;
  onForget: () => void;
}

function ThreadRow({
  entry,
  active,
  loading,
  disabled,
  onPick,
  onForget,
}: ThreadRowProps) {
  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1 ${
        active ? "bg-cyan-950/50" : "hover:bg-slate-800/60"
      }`}
    >
      <button
        type="button"
        onClick={onPick}
        disabled={disabled || loading}
        className={`flex-1 truncate text-left font-mono text-[10px] ${
          active ? "text-cyan-200" : "text-slate-300"
        } disabled:cursor-not-allowed disabled:opacity-50`}
        title={`${entry.first_question}\n${entry.turn_count} turno${entry.turn_count === 1 ? "" : "s"} · ${new Date(entry.updated_at).toLocaleString("es-MX")}`}
      >
        {loading ? "cargando…" : entry.first_question.slice(0, 60)}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onForget();
        }}
        disabled={disabled || loading}
        className="rounded px-1 font-mono text-[10px] text-slate-600 opacity-0 hover:text-rose-400 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
        title="Quitar de este navegador (no borra el servidor)"
      >
        ×
      </button>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  const examples = [
    "¿Qué municipios de Veracruz tienen más farmacias con controlados?",
    "Top 10 entidades por ingreso medio según ENIGH",
    "Tendencia de homicidios dolosos 2015–2025 en Iztapalapa",
    "AGEBs con más oportunidad de farmacia en Iztacalco",
  ];
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pt-12">
      <p className="font-mono text-sm text-slate-400">
        Pregúntale a Sage sobre los datos del análisis. Te devuelvo tabla,
        gráfica y narrativa.
      </p>
      <div className="flex flex-col gap-2">
        {examples.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onPick(q)}
            className="rounded border border-slate-800 bg-slate-900 px-3 py-2 text-left font-mono text-xs text-slate-300 hover:border-cyan-700 hover:bg-slate-800"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function TurnCard({ turn }: { turn: ChatTurn }) {
  const [tab, setTab] = useState<"table" | "narrative" | "route">("narrative");
  return (
    <div className="mb-4 rounded border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-800 px-3 py-2 font-mono text-xs text-slate-200">
        💬 {turn.question}
      </div>
      <div className="px-3 py-2">
        {turn.error ? (
          <div className="rounded bg-red-950 px-2 py-1 font-mono text-[11px] text-red-300">
            {turn.error.code}: {turn.error.message}
          </div>
        ) : (
          <>
            <div className="mb-2 flex gap-1 font-mono text-[10px]">
              <TabButton
                active={tab === "narrative"}
                onClick={() => setTab("narrative")}
              >
                Narrativa
              </TabButton>
              <TabButton
                active={tab === "table"}
                onClick={() => setTab("table")}
              >
                Tabla{turn.rowCount > 0 ? ` (${turn.rowCount})` : ""}
              </TabButton>
              <TabButton
                active={tab === "route"}
                onClick={() => setTab("route")}
              >
                Ruta
              </TabButton>
            </div>
            {tab === "narrative" && (
              <div className="whitespace-pre-wrap font-mono text-xs text-slate-100">
                {turn.narrative || <span className="text-slate-500">…</span>}
              </div>
            )}
            {tab === "table" && <ResultTable turn={turn} />}
            {tab === "route" && <RouteCard route={turn.route} />}
          </>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 uppercase tracking-wider ${
        active
          ? "bg-cyan-800 text-cyan-100"
          : "bg-slate-800 text-slate-400 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function ResultTable({ turn }: { turn: ChatTurn }) {
  if (turn.rowCount === 0) {
    return (
      <div className="font-mono text-[11px] text-slate-500">— sin filas —</div>
    );
  }
  // `turn.rows` is fewer than `turn.rowCount` in two cases: a restored
  // thread (backend digest keeps only the first 5 rows) or a live turn
  // with >100 rows (we render at most 100). Surface the gap so the
  // badge count and the visible rows don't silently disagree.
  const shown = Math.min(turn.rows.length, 100);
  const isSample = shown < turn.rowCount;
  return (
    <div>
      <div className="max-h-72 overflow-auto rounded border border-slate-800">
        <table className="w-full font-mono text-[11px] text-slate-300">
          <thead className="sticky top-0 bg-slate-950 text-slate-500">
            <tr>
              {turn.columns.map((c) => (
                <th
                  key={c}
                  className="border-b border-slate-800 px-2 py-1 text-left"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {turn.rows.slice(0, 100).map((r, i) => (
              <tr key={i} className="even:bg-slate-950/50">
                {turn.columns.map((c) => (
                  <td key={c} className="border-b border-slate-900 px-2 py-1">
                    {formatCell((r as Record<string, unknown>)[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isSample && (
        <div className="mt-1 font-mono text-[10px] text-slate-500">
          muestra: {shown.toLocaleString("es-MX")} de{" "}
          {turn.rowCount.toLocaleString("es-MX")} filas
        </div>
      )}
    </div>
  );
}

function RouteCard({ route }: { route: SageRoute | null }) {
  if (!route)
    return (
      <div className="font-mono text-[11px] text-slate-500">— sin ruta —</div>
    );
  if (route.kind === "endpoint") {
    return (
      <div className="font-mono text-[11px] text-slate-300">
        <div>
          endpoint: <span className="text-cyan-300">{route.endpoint_name}</span>
        </div>
        <div className="mt-1">
          params:{" "}
          <code className="rounded bg-slate-950 px-1">
            {JSON.stringify(route.params ?? {})}
          </code>
        </div>
        {route.reasoning && (
          <div className="mt-1 text-slate-400">{route.reasoning}</div>
        )}
      </div>
    );
  }
  if (route.kind === "sql") {
    return (
      <pre className="whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-[11px] text-emerald-300">
        {route.sql}
      </pre>
    );
  }
  return (
    <div className="font-mono text-[11px] text-amber-300">
      Sage declinó: {route.reasoning}
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "·";
  if (typeof v === "number")
    return Math.abs(v) > 999 ? v.toLocaleString("es-MX") : String(v);
  if (typeof v === "string") return v.length > 60 ? v.slice(0, 57) + "…" : v;
  return JSON.stringify(v);
}
