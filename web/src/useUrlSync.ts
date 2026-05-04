import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useUiStore } from "./store";

// Mirrors backend ENTIDAD_RE + SCIAN_RE so a malicious or stale URL
// can't push garbage into the store and cascade 400s into every chart.
// (Backend re-validates on every request — this is defense in depth.)
const ENTIDAD_RE = /^(0[1-9]|[12][0-9]|3[0-2])$/;
const SCIAN_RE = /^[0-9]{2}$/;

/**
 * Two-way sync between the URL query string and Zustand's filter state.
 *
 *  - On mount: read `?entidad=` and `?sector=` once, validate against
 *    the backend regexes, push valid values into Zustand. Invalid
 *    values are dropped silently — the URL is not user-authored input,
 *    it's link-shareable state.
 *  - On entidad/sector change: mirror back to the URL via
 *    history.replaceState (so the back button doesn't accumulate
 *    intermediate states from every dropdown change).
 *
 * Designed to be called once per route (Locust + Map). Does NOT sync
 * apiKey — that stays in localStorage only and never reaches the URL.
 */
export function useUrlSync(): void {
  const [params, setParams] = useSearchParams();
  const entidad = useUiStore((s) => s.entidad);
  const sector = useUiStore((s) => s.sector);
  const setEntidad = useUiStore((s) => s.setEntidad);
  const setSector = useUiStore((s) => s.setSector);

  // Hydrate Zustand from URL on first mount only.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only hydration; capturing setEntidad/setSector once is intentional
  useEffect(() => {
    const ent = params.get("entidad");
    const sec = params.get("sector");
    if (ent && ENTIDAD_RE.test(ent)) setEntidad(ent);
    if (sec && SCIAN_RE.test(sec)) setSector(sec);
  }, []);

  // Mirror Zustand → URL on filter change. Deps deliberately limited
  // to the filters themselves (audit C1 fix). `params` is read inside
  // for the equality short-circuit but doesn't drive the effect — every
  // useSearchParams render returns a new params reference, so including
  // it would re-run the effect on every parent re-render with no
  // correctness benefit. `setParams` is referentially stable from
  // react-router. The eslint exception is the price of wanting the
  // effect driven by Zustand state alone, not by router churn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (entidad) next.set("entidad", entidad);
    else next.delete("entidad");
    if (sector) next.set("sector", sector);
    else next.delete("sector");
    if (next.toString() !== params.toString()) {
      setParams(next, { replace: true });
    }
  }, [entidad, sector]);
}
