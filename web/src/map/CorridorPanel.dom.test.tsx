// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session } from "@supabase/supabase-js";
import type { Map as MapInstance } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Importing the store pulls in the auth client.
vi.mock("../lib/supabase", () => ({ supabase: { auth: {} } }));
// The municipio-name lookup is a TanStack query; the panel only needs a
// name for the resolved cve_mun.
vi.mock("../api/queries", () => ({
  useMunicipiosAnalytics: (entidad: string | null) => ({
    data: entidad
      ? { entidad, municipios: [{ cve_mun: "09015", municipio: "Cuauhtémoc" }] }
      : undefined,
  }),
}));

import { useUiStore } from "../store";
import { CorridorPanel, CORRIDOR_DEBOUNCE_MS } from "./CorridorPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CORRIDOR_200 = {
  length_m: 2000,
  buffer_m: 100,
  total: 9,
  per_km: 4.5,
  by_clase: [
    { clase_actividad_id: "464111", clase_actividad: "Farmacias sin minisúper", n: 9 },
  ],
  buffer_geojson: { type: "Polygon", coordinates: [] },
};
const STREET_200 = {
  cve_mun: "09015",
  q: "reforma",
  status: "ok",
  matches: [
    {
      name: "Paseo de la Reforma",
      highway: ["primary"],
      length_m: 3500,
      segments: 4,
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-99.17, 19.43],
            [-99.16, 19.427],
          ],
        ],
      },
    },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = global.fetch;
const fakeMap = {
  getCenter: () => ({ lng: -99.1332, lat: 19.4326 }),
  fitBounds: vi.fn(),
};

function urls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}
function text(): string {
  return container.textContent ?? "";
}
function button(label: string): HTMLButtonElement {
  const b = [...container.querySelectorAll("button")].find(
    (x) => x.textContent?.trim() === label,
  );
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}
function byLabel(label: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!el) throw new Error(`no input "${label}"`);
  return el;
}
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  useUiStore.setState({ session: { access_token: "jwt" } as Session, hydrated: true });
  useUiStore.getState().resetCorridor();
  useUiStore.getState().patchCorridor({ open: true, drawing: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<CorridorPanel map={fakeMap as unknown as MapInstance} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  global.fetch = originalFetch;
  vi.useRealTimers();
});

describe("CorridorPanel auto-run", () => {
  it("waits for 2 vertices, then debounces 400 ms and coalesces edits", async () => {
    fetchMock.mockImplementation(async () => json(CORRIDOR_200));
    act(() => useUiStore.getState().addCorridorPoint([-99.17, 19.43]));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => useUiStore.getState().addCorridorPoint([-99.16, 19.42]));
    await act(() => vi.advanceTimersByTimeAsync(CORRIDOR_DEBOUNCE_MS - 50));
    act(() => useUiStore.getState().addCorridorPoint([-99.15, 19.41]));
    await act(() => vi.advanceTimersByTimeAsync(CORRIDOR_DEBOUNCE_MS - 1));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.geometry.coordinates).toHaveLength(3);
    expect(body).toMatchObject({ buffer_m: 100, clase_prefix: "4641" });

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(useUiStore.getState().corridor.status).toBe("ok");
    expect(text()).toContain("Farmacias sin minisúper");
    expect(text()).toContain("4.5");
  });

  it("does not run with an invalid prefix; Calcular runs without the debounce", async () => {
    fetchMock.mockImplementation(async () => json(CORRIDOR_200));
    act(() =>
      useUiStore.getState().patchCorridor({
        clasePrefix: "4",
        points: [
          [-99.17, 19.43],
          [-99.16, 19.42],
        ],
      }),
    );
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text()).toContain("prefijo SCIAN de 2 a 6 dígitos");
    expect(text()).not.toContain("dibuja ≥ 2 vértices");
    expect(button("Calcular").disabled).toBe(true);

    act(() => button("Farmacias 4641").click());
    await act(() => vi.advanceTimersByTimeAsync(CORRIDOR_DEBOUNCE_MS));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => button("Calcular").click());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows a 400 message verbatim", async () => {
    const msg = "La geometría mide 62.3 km; el máximo es 50 km.";
    fetchMock.mockImplementation(async () =>
      json({ error: msg, code: "validation.geometry.length" }, 400),
    );
    act(() =>
      useUiStore.getState().patchCorridor({
        points: [
          [-99.17, 19.43],
          [-99.16, 19.42],
        ],
      }),
    );
    await act(() => vi.advanceTimersByTimeAsync(CORRIDOR_DEBOUNCE_MS));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(msg);
  });
});

describe("CorridorPanel null buffer (> 500 vertices)", () => {
  const pts = (n: number) =>
    Array.from({ length: n }, (_, i): [number, number] => [-99.17 + i * 1e-5, 19.43]);

  it("shows the no-buffer note only when buffer_geojson is null", async () => {
    fetchMock.mockImplementationOnce(async () =>
      json({ ...CORRIDOR_200, buffer_geojson: null }),
    );
    act(() => useUiStore.getState().patchCorridor({ points: pts(501) }));
    await act(() => vi.advanceTimersByTimeAsync(CORRIDOR_DEBOUNCE_MS));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(text()).toContain("Buffer no dibujado (corredor muy fragmentado); el conteo es exacto");
    expect(text()).toContain("Farmacias sin minisúper");

    fetchMock.mockImplementationOnce(async () => json(CORRIDOR_200));
    act(() => useUiStore.getState().patchCorridor({ points: pts(3) }));
    await act(() => vi.advanceTimersByTimeAsync(CORRIDOR_DEBOUNCE_MS));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(text()).not.toContain("Buffer no dibujado");
  });

  it("shows the area error with its hint", async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: "Área excedida.", code: "validation.geometry.area" }, 400),
    );
    act(() => useUiStore.getState().patchCorridor({ points: pts(2), bufferM: 1000 }));
    await act(() => vi.advanceTimersByTimeAsync(CORRIDOR_DEBOUNCE_MS));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Área excedida. — reduce el buffer o acorta el corredor",
    );
  });
});

describe("CorridorPanel street search", () => {
  it("resolves the centre municipio, polls through a 202, loads a match as the corridor", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/resolve/ageb"))
        return json({ cvegeo: "0901500010010", cve_mun: "09015" });
      if (url.startsWith("/api/analytics/street-geometry")) {
        const n = urls().filter((u) => u.includes("street-geometry")).length;
        return n === 1
          ? json({ status: "extracting", cve_mun: "09015", retry_after_s: 30 }, 202)
          : json(STREET_200);
      }
      return json(CORRIDOR_200);
    });

    const q = byLabel("Nombre de la vialidad");
    act(() => setInput(q, "reforma"));
    act(() => button("Buscar").click());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(urls()[0]).toBe("/api/resolve/ageb?lat=19.432600&lon=-99.133200");
    expect(text()).toContain("Extrayendo vialidades de 09015… (~1–2 min)");
    expect(text()).toContain("Cuauhtémoc");

    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(urls().filter((u) => u.includes("street-geometry"))).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(urls().filter((u) => u.includes("street-geometry"))).toHaveLength(2);
    expect(text()).toContain("Paseo de la Reforma");
    expect(text()).toContain("3.5 km");

    const match = [...container.querySelectorAll("li button")][0] as HTMLButtonElement;
    act(() => match.click());
    const c = useUiStore.getState().corridor;
    expect(c.streetName).toBe("Paseo de la Reforma");
    expect(c.streetLines).toHaveLength(1);
    expect(fakeMap.fitBounds).toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(CORRIDOR_DEBOUNCE_MS));
    const corridorCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("corridor-density"),
    )!;
    expect(JSON.parse(corridorCall[1].body as string).geometry.type).toBe(
      "MultiLineString",
    );
  });

  it("uses a typed 5-digit municipio and shows the OSM text on 502", async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: "Upstream query failed", code: "osm.extract_failed" }, 502),
    );
    const mun = byLabel("Clave de municipio (5 dígitos)");
    const q = byLabel("Nombre de la vialidad");
    act(() => setInput(mun, "09014"));
    act(() => setInput(q, "insurgentes"));
    act(() => button("Buscar").click());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(urls()).toEqual([
      "/api/analytics/street-geometry?cve_mun=09014&q=insurgentes",
    ]);
    expect(text()).toContain("El servicio OSM falló; reintenta");
  });

  it("never writes the resolved centre into the override; each empty submit re-resolves", async () => {
    let centreMun = "09015";
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/resolve/ageb"))
        return json({ cvegeo: `${centreMun}00010010`, cve_mun: centreMun });
      return json({ ...STREET_200, cve_mun: centreMun, matches: [] });
    });
    const q = byLabel("Nombre de la vialidad");
    const mun = byLabel("Clave de municipio (5 dígitos)");
    act(() => setInput(q, "reforma"));
    act(() => button("Buscar").click());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(mun.value).toBe("");
    expect(mun.placeholder).toBe("09015");

    centreMun = "09014";
    act(() => button("Buscar").click());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(urls().filter((u) => u.startsWith("/api/resolve/ageb"))).toHaveLength(2);
    expect(urls().at(-1)).toBe("/api/analytics/street-geometry?cve_mun=09014&q=reforma");
    expect(mun.value).toBe("");
  });

  it("stops polling when the panel unmounts during a 202 wait", async () => {
    fetchMock.mockImplementation(async () =>
      json({ status: "extracting", cve_mun: "09014", retry_after_s: 30 }, 202),
    );
    act(() => setInput(byLabel("Clave de municipio (5 dígitos)"), "09014"));
    act(() => setInput(byLabel("Nombre de la vialidad"), "insurgentes"));
    act(() => button("Buscar").click());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // afterEach unmounts again; give it a fresh root.
    root = createRoot(container);
  });

  it("flags truncated matches and an over-long result list", async () => {
    fetchMock.mockImplementation(async () =>
      json({
        ...STREET_200,
        truncated: true,
        matches: [{ ...STREET_200.matches[0], truncated: true }],
      }),
    );
    act(() => setInput(byLabel("Clave de municipio (5 dígitos)"), "09015"));
    act(() => setInput(byLabel("Nombre de la vialidad"), "reforma"));
    act(() => button("Buscar").click());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(text()).toContain("Paseo de la Reforma(recortada)");
    expect(text()).toContain("más de 20 coincidencias; afina la búsqueda");
  });

  it("blocks queries shorter than 4 characters with a hint", async () => {
    const q = byLabel("Nombre de la vialidad");
    act(() => setInput(q, "  ref "));
    expect(text()).toContain("mínimo 4 caracteres");
    expect(button("Buscar").disabled).toBe(true);
    act(() => q.form!.requestSubmit());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => setInput(q, "refo"));
    expect(text()).not.toContain("mínimo 4 caracteres");
    expect(button("Buscar").disabled).toBe(false);
  });
});
