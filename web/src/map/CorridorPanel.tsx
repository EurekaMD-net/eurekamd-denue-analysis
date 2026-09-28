import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapInstance } from "maplibre-gl";
import { useUiStore } from "../store";
import { useMunicipiosAnalytics } from "../api/queries";
import {
  corridorErrorMessage,
  fetchCorridorDensity,
  pollStreetGeometry,
  resolveMunicipio,
} from "../api/corridor-client";
import {
  BUFFER_MAX_M,
  BUFFER_MIN_M,
  buildCorridorRequest,
  CLASE_PREFIX_RE,
  CVE_MUN_RE,
  FARMACIAS_PREFIX,
  STREET_Q_MAX,
  STREET_Q_MIN,
  type Position,
  type StreetMatch,
} from "../api/corridor-types";

/** Debounce between the last vertex/buffer/prefix edit and the query. */
export const CORRIDOR_DEBOUNCE_MS = 400;

const fmtInt = (n: number) => n.toLocaleString("es-MX");
const fmtKm = (m: number) =>
  (m / 1000).toLocaleString("es-MX", { maximumFractionDigits: 2 });

/** [[w, s], [e, n]] over every vertex, or null when empty. */
export function linesBounds(
  lines: Position[][],
): [[number, number], [number, number]] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

/**
 * Runs the density query 400 ms after the corridor inputs settle (≥ 2
 * vertices or a loaded street) and on `nonce` bumps (the "Calcular"
 * button, no debounce). A newer run aborts the older one; sign-out aborts
 * it through the store's abort registry.
 */
function useCorridorAutoRun(nonce: number) {
  const points = useUiStore((s) => s.corridor.points);
  const streetLines = useUiStore((s) => s.corridor.streetLines);
  const bufferM = useUiStore((s) => s.corridor.bufferM);
  const clasePrefix = useUiStore((s) => s.corridor.clasePrefix);
  const lastNonce = useRef(nonce);

  useEffect(() => {
    const req = buildCorridorRequest({
      points,
      streetLines,
      bufferM,
      clasePrefix,
    });
    const { patchCorridor, registerAbort } = useUiStore.getState();
    if (!req) {
      patchCorridor({ result: null, status: "idle", error: null });
      return;
    }
    const immediate = lastNonce.current !== nonce;
    lastNonce.current = nonce;
    const ctrl = new AbortController();
    const unregister = registerAbort(ctrl);
    const t = setTimeout(
      () => {
        patchCorridor({ status: "loading", error: null });
        fetchCorridorDensity(req, ctrl.signal).then(
          (result) => {
            if (!ctrl.signal.aborted)
              patchCorridor({ result, status: "ok", error: null });
          },
          (err: unknown) => {
            if (!ctrl.signal.aborted)
              patchCorridor({
                result: null,
                status: "error",
                error: corridorErrorMessage(err),
              });
          },
        );
      },
      immediate ? 0 : CORRIDOR_DEBOUNCE_MS,
    );
    return () => {
      clearTimeout(t);
      ctrl.abort();
      unregister();
    };
  }, [points, streetLines, bufferM, clasePrefix, nonce]);
}

export function CorridorPanel({ map }: { map: MapInstance | null }) {
  const c = useUiStore((s) => s.corridor);
  const patch = useUiStore((s) => s.patchCorridor);
  const clear = useUiStore((s) => s.clearCorridor);
  const setStreet = useUiStore((s) => s.setCorridorStreet);
  const [nonce, setNonce] = useState(0);
  useCorridorAutoRun(nonce);

  // Street search municipio: a typed 5-digit override, else the map
  // centre, re-resolved on every submit (the map may have moved).
  const [cveMun, setCveMun] = useState("");
  const [resolvedMun, setResolvedMun] = useState<string | null>(null);
  const streetCtrl = useRef<AbortController | null>(null);
  useEffect(() => () => streetCtrl.current?.abort(), []);
  const shownMun = CVE_MUN_RE.test(cveMun) ? cveMun : resolvedMun;
  const municipios = useMunicipiosAnalytics(shownMun ? shownMun.slice(0, 2) : null);
  const munName = useMemo(
    () =>
      municipios.data?.municipios.find((m) => m.cve_mun === shownMun)
        ?.municipio ?? null,
    [municipios.data, shownMun],
  );

  const prefix = c.clasePrefix.trim();
  const prefixInvalid = prefix !== "" && !CLASE_PREFIX_RE.test(prefix);
  const q = c.streetQuery.trim();
  const streetBusy =
    c.streetStatus === "resolving" ||
    c.streetStatus === "loading" ||
    c.streetStatus === "extracting";

  const runStreetSearch = async () => {
    if (q.length < STREET_Q_MIN || q.length > STREET_Q_MAX) return;
    streetCtrl.current?.abort();
    const ctrl = new AbortController();
    streetCtrl.current = ctrl;
    const unregister = useUiStore.getState().registerAbort(ctrl);
    try {
      let mun = cveMun;
      if (!CVE_MUN_RE.test(mun)) {
        if (!map) {
          patch({
            streetStatus: "error",
            streetMessage: "Escribe la clave de 5 dígitos del municipio",
          });
          return;
        }
        patch({
          streetStatus: "resolving",
          streetMessage: "Ubicando el municipio del centro del mapa…",
          streetMatches: [],
          streetTruncated: false,
        });
        const center = map.getCenter();
        mun = await resolveMunicipio(center.lng, center.lat, ctrl.signal);
        setResolvedMun(mun);
      }
      patch({
        streetStatus: "loading",
        streetMessage: null,
        streetMatches: [],
        streetTruncated: false,
      });
      const res = await pollStreetGeometry(mun, q, {
        signal: ctrl.signal,
        onExtracting: () =>
          patch({
            streetStatus: "extracting",
            streetMessage: `Extrayendo vialidades de ${mun}… (~1–2 min)`,
          }),
      });
      patch({
        streetStatus: "ok",
        streetMatches: res.matches,
        streetTruncated: res.truncated === true,
        streetMessage:
          res.matches.length === 0
            ? `Sin vialidades que contengan "${q}" en ${mun}`
            : null,
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      patch({
        streetStatus: "error",
        streetMessage: corridorErrorMessage(err, true),
      });
    } finally {
      unregister();
    }
  };

  const loadMatch = (m: StreetMatch) => {
    const lines = m.geometry.coordinates.map((l) =>
      l.map((p) => [p[0], p[1]] as Position),
    );
    setStreet(m.name, lines);
    const b = linesBounds(lines);
    if (map && b) map.fitBounds(b, { padding: 60, maxZoom: 16 });
  };

  const hasGeometry = c.points.length > 0 || c.streetLines !== null;

  return (
    <div className="absolute left-3 top-3 z-10 flex max-h-[calc(100%-1.5rem)] w-80 flex-col overflow-y-auto rounded border border-slate-800 bg-slate-950/95 font-mono text-[11px] text-slate-300 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-cyan-500">
          Corredor
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => patch({ drawing: !c.drawing })}
            aria-pressed={c.drawing}
            className={`rounded px-2 py-0.5 text-[10px] ${
              c.drawing
                ? "bg-amber-600 text-amber-50"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {c.drawing ? "Dibujando" : "Dibujar"}
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={!hasGeometry}
            className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-600"
          >
            Limpiar
          </button>
        </div>
      </div>

      <div className="border-b border-slate-800 px-3 py-2 text-[10px] text-slate-500">
        {c.streetName ? (
          <>
            vialidad: <span className="text-yellow-300">{c.streetName}</span>
          </>
        ) : c.drawing ? (
          <>click agrega vértice · ⌫ borra el último · Esc termina</>
        ) : (
          <>{c.points.length} vértices · «Dibujar» para editar</>
        )}
        {c.drawing && !c.streetName && (
          <span className="ml-1 text-slate-400">({c.points.length})</span>
        )}
      </div>

      <div className="space-y-2 border-b border-slate-800 px-3 py-2">
        <label className="flex items-center gap-2">
          <span className="w-16 text-[10px] uppercase text-slate-500">Buffer</span>
          <input
            type="range"
            min={BUFFER_MIN_M}
            max={BUFFER_MAX_M}
            step={10}
            value={c.bufferM}
            onChange={(e) => patch({ bufferM: Number(e.target.value) })}
            className="flex-1 accent-cyan-500"
          />
          <span className="w-12 text-right text-slate-200">{c.bufferM} m</span>
        </label>
        <div className="flex items-center gap-2">
          <span className="w-16 text-[10px] uppercase text-slate-500">SCIAN</span>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={c.clasePrefix}
            placeholder="todas"
            aria-label="Prefijo SCIAN (2 a 6 dígitos)"
            onChange={(e) =>
              patch({ clasePrefix: e.target.value.replace(/\D/g, "") })
            }
            className={`w-20 rounded border bg-slate-900 px-2 py-0.5 text-slate-100 focus:outline-none ${
              prefixInvalid
                ? "border-rose-600"
                : "border-slate-700 focus:border-cyan-500"
            }`}
          />
          <button
            type="button"
            onClick={() => patch({ clasePrefix: FARMACIAS_PREFIX })}
            className={`rounded px-2 py-0.5 text-[10px] ${
              prefix === FARMACIAS_PREFIX
                ? "bg-cyan-700 text-cyan-50"
                : "bg-slate-800 text-slate-400 hover:bg-slate-700"
            }`}
          >
            Farmacias {FARMACIAS_PREFIX}
          </button>
        </div>
        {prefixInvalid && (
          <div className="text-[10px] text-rose-400">
            prefijo SCIAN de 2 a 6 dígitos (vacío = todas las clases)
          </div>
        )}
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          disabled={!buildCorridorRequest(c)}
          className="w-full rounded bg-cyan-700 px-2 py-1 text-[11px] text-cyan-50 hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-600"
        >
          Calcular
        </button>
      </div>

      <CorridorResultView prefixInvalid={prefixInvalid} />

      <form
        className="space-y-1.5 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void runStreetSearch();
        }}
      >
        <span className="text-[10px] uppercase tracking-[0.2em] text-cyan-500">
          Buscar vialidad
        </span>
        <div className="flex gap-1">
          <input
            type="text"
            value={c.streetQuery}
            maxLength={STREET_Q_MAX}
            placeholder="p.ej. reforma"
            aria-label="Nombre de la vialidad"
            onChange={(e) => patch({ streetQuery: e.target.value })}
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-100 focus:border-cyan-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={streetBusy || q.length < STREET_Q_MIN}
            className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-600"
          >
            Buscar
          </button>
        </div>
        {q.length > 0 && q.length < STREET_Q_MIN && (
          <div className="text-[10px] text-slate-500">
            mínimo {STREET_Q_MIN} caracteres
          </div>
        )}
        <div className="flex items-center gap-1 text-[10px] text-slate-500">
          <span>municipio</span>
          <input
            type="text"
            inputMode="numeric"
            maxLength={5}
            value={cveMun}
            placeholder={resolvedMun ?? "centro"}
            aria-label="Clave de municipio (5 dígitos)"
            title="Clave de 5 dígitos; vacío = municipio del centro del mapa"
            onChange={(e) => setCveMun(e.target.value.replace(/\D/g, ""))}
            className="w-16 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-100 focus:border-cyan-500 focus:outline-none"
          />
          {munName && <span className="truncate text-slate-400">{munName}</span>}
          {cveMun !== "" && (
            <button
              type="button"
              onClick={() => setCveMun("")}
              className="text-slate-500 hover:text-slate-300"
              title="Usar el centro del mapa"
              aria-label="Usar el centro del mapa"
            >
              ×
            </button>
          )}
        </div>
        {c.streetMessage && (
          <div
            role="status"
            className={
              c.streetStatus === "error" ? "text-rose-400" : "text-amber-400"
            }
          >
            {c.streetMessage}
          </div>
        )}
        {c.streetMatches.length > 0 && (
          <ul className="space-y-0.5">
            {c.streetMatches.map((m, i) => (
              <li key={`${m.name}-${i}`}>
                <button
                  type="button"
                  onClick={() => loadMatch(m)}
                  className={`w-full rounded px-2 py-1 text-left hover:bg-slate-800 ${
                    c.streetName === m.name ? "bg-slate-800" : ""
                  }`}
                >
                  <div className="flex justify-between gap-2">
                    <span className="truncate text-slate-100">
                      {m.name}
                      {m.truncated && (
                        <span className="ml-1 text-amber-400">(recortada)</span>
                      )}
                    </span>
                    <span className="shrink-0 text-slate-400">
                      {fmtKm(m.length_m)} km
                    </span>
                  </div>
                  <div className="truncate text-[9px] text-slate-500">
                    {m.highway.join(", ")}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {c.streetTruncated && (
          <div className="text-[10px] text-amber-400">
            más de 20 coincidencias; afina la búsqueda
          </div>
        )}
      </form>
    </div>
  );
}

function CorridorResultView({ prefixInvalid }: { prefixInvalid: boolean }) {
  const status = useUiStore((s) => s.corridor.status);
  const error = useUiStore((s) => s.corridor.error);
  const r = useUiStore((s) => s.corridor.result);

  if (status === "error" && error) {
    return (
      <div className="border-b border-slate-800 px-3 py-2 text-rose-400" role="alert">
        {error}
      </div>
    );
  }
  if (!r) {
    // An invalid prefix already has its own hint above.
    if (prefixInvalid) return null;
    return (
      <div className="border-b border-slate-800 px-3 py-2 text-[10px] text-slate-500">
        {status === "loading"
          ? "calculando…"
          : "dibuja ≥ 2 vértices o carga una vialidad"}
      </div>
    );
  }
  return (
    <div className="border-b border-slate-800 px-3 py-2">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="km" value={fmtKm(r.length_m)} />
        <Stat label="UEs" value={fmtInt(r.total)} />
        <Stat
          label="por km"
          value={
            r.per_km === null
              ? "—"
              : r.per_km.toLocaleString("es-MX", { maximumFractionDigits: 1 })
          }
        />
      </div>
      {status === "loading" && (
        <div className="mt-1 text-[10px] text-cyan-400">recalculando…</div>
      )}
      {r.buffer_geojson === null && (
        <div className="mt-1 text-[10px] text-slate-500">
          Buffer no dibujado (corredor muy fragmentado); el conteo es exacto
        </div>
      )}
      {r.by_clase.length > 0 && (
        <table className="mt-2 w-full text-[10px]">
          <thead>
            <tr className="text-slate-500">
              <th className="text-left font-normal">clase</th>
              <th className="text-right font-normal">UEs</th>
            </tr>
          </thead>
          <tbody>
            {r.by_clase.map((row) => (
              <tr key={row.clase_actividad_id} className="align-top">
                <td className="py-0.5 pr-2">
                  <span className="text-slate-500">{row.clase_actividad_id}</span>{" "}
                  <span className="text-slate-300">{row.clase_actividad ?? ""}</span>
                </td>
                <td className="py-0.5 text-right text-slate-100">{fmtInt(row.n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm text-slate-100">{value}</div>
      <div className="text-[9px] uppercase text-slate-500">{label}</div>
    </div>
  );
}
