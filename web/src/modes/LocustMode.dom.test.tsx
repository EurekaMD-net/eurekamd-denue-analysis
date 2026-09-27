// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Importing the store pulls in the auth client.
vi.mock("../lib/supabase", () => ({ supabase: { auth: {} } }));
// FilterControls fetches /entidades and /sectors; the entidad is set on
// the store directly instead.
vi.mock("../components/FilterPanel", () => ({ FilterControls: () => null }));
// The real picker is a cmdk dialog; this stub offers the fields the tests
// pick by id.
vi.mock("../components/FieldPicker", async () => {
  const { findField } = await import("../lib/fields");
  return {
    FieldPicker: ({
      open,
      onPick,
      onClose,
    }: {
      open: boolean;
      onPick: (f: unknown) => void;
      onClose: () => void;
    }) =>
      open ? (
        <div>
          {["censo.cve_ageb", "censo.pobtot_ageb"].map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`pick-${id}`}
              onClick={() => {
                onPick(findField(id));
                onClose();
              }}
            />
          ))}
        </div>
      ) : null,
  };
});
// jsdom has no canvas; record what the chart would receive instead.
const chart = vi.hoisted(() => ({
  renders: [] as Array<Record<string, unknown>>,
  mounts: 0,
}));
vi.mock("../lib/echarts-core", async () => {
  const { useEffect } = await import("react");
  return {
    default: function ReactEChartsStub(props: Record<string, unknown>) {
      chart.renders.push(props);
      useEffect(() => {
        chart.mounts += 1;
      }, []);
      return <div data-testid="echarts" />;
    },
  };
});
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from "../api/client";
import { useUiStore } from "../store";
import { LocustMode } from "./LocustMode";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

function payloadFor(path: string): unknown {
  if (path.startsWith("/analytics/municipios?")) {
    return {
      entidad: "09",
      municipios: [
        {
          cve_mun: "09003",
          municipio: "Coyoacán",
          poblacion: 600000,
          establecimientos: 1,
          farmacias: 0,
          unidades_clues: 0,
          pobreza_pct: null,
          irs_grado: null,
          irs_indice: null,
        },
      ],
    };
  }
  if (path.startsWith("/analytics/locust-ageb")) {
    return { agebs: [{ cve_ageb: "0010", pobtot_ageb: 1200 }] };
  }
  const entidades = [
    {
      entidad: "09",
      nombre: "Ciudad de México",
      establecimientos: 451000,
      pobreza_pct_promedio: 27.1,
      pobreza_pct: 27.1,
    },
    {
      entidad: "31",
      nombre: "Yucatán",
      establecimientos: 95000,
      pobreza_pct_promedio: 40.4,
      pobreza_pct: 40.4,
    },
  ];
  return { entidades };
}

const callsTo = (path: string) =>
  fetchMock.mock.calls.filter((c) => c[0] === path).length;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}

function axisButton(slot: "X" | "Y" | "Z"): Element | null {
  const label = Array.from(container.querySelectorAll("span")).find(
    (s) => s.textContent === slot,
  );
  return label?.parentElement?.querySelector("button") ?? null;
}

function changeSelect(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function renderMode() {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <LocustMode />
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  chart.renders = [];
  chart.mounts = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (path: string) => ({
    json: async () => payloadFor(path),
  }));
  useUiStore.setState({
    session: { access_token: "test-token" } as Session,
    entidad: null,
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("LocustMode chart (#170 #169 #172)", () => {
  async function renderPreset() {
    await renderMode();
    const preset = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Pobreza × Establecimientos (estados)"),
    );
    click(preset ?? null);
    await flush();
    expect(container.querySelector('[data-testid="echarts"]')).not.toBeNull();
  }

  it("replaces the option instead of merging, and remounts on a chart-type switch", async () => {
    await renderPreset();
    const last = chart.renders.at(-1)!;
    expect(last.notMerge).toBe(true);

    const mountsBefore = chart.mounts;
    const toggle = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "treemap"),
    ) as HTMLSelectElement;
    changeSelect(toggle, "treemap");
    await flush();
    expect(chart.mounts).toBe(mountsBefore + 1);
    const option = chart.renders.at(-1)!.option as Record<string, unknown>;
    expect(option.xAxis).toBeUndefined();
  });

  it("does not rebuild the chart when an unrelated parent state changes", async () => {
    await renderPreset();
    const rendersBefore = chart.renders.length;
    // Opening the field picker re-renders LocustMode only.
    click(axisButton("Z"));
    expect(container.querySelector('[data-testid^="pick-"]')).not.toBeNull();
    expect(chart.renders.length).toBe(rendersBefore);
  });

  it("a chart click still pins a filter through the memoized handler", async () => {
    await renderPreset();
    const onEvents = chart.renders.at(-1)!.onEvents as {
      click: (e: { name?: string }) => void;
    };
    act(() => onEvents.click({ name: "Yucatán" }));
    expect(container.textContent).toContain("Entidad: Yucatán ×");
    // A second click on the same cell does not add a duplicate pin.
    act(() => onEvents.click({ name: "Yucatán" }));
    expect(container.textContent).toContain("1 filtro activo");
  });

  it("has no drill buttons that only wipe the filter pins", async () => {
    await renderPreset();
    expect(container.querySelector('[title="drill up"]')).toBeNull();
    expect(container.querySelector('[title="drill down"]')).toBeNull();
  });
});

describe("LocustMode AGEB municipio (#183 #184 #168)", () => {
  async function renderAgeb() {
    useUiStore.setState({ entidad: "09" });
    await renderMode();
    click(axisButton("X"));
    click(container.querySelector('[data-testid="pick-censo.cve_ageb"]'));
    click(axisButton("Y"));
    click(container.querySelector('[data-testid="pick-censo.pobtot_ageb"]'));
    await flush();
  }

  it("lists municipios through the shared analytics query", async () => {
    await renderAgeb();
    expect(
      queryClient.getQueryData(["analytics", "municipios", "09"]),
    ).toBeDefined();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: ["municipios-list"] }),
    ).toHaveLength(0);
    expect(container.textContent).toContain("Coyoacán");
  });

  async function pickMunicipio() {
    const muniSelect = Array.from(container.querySelectorAll("select")).find(
      (s) => Array.from(s.options).some((o) => o.value === "09003"),
    ) as HTMLSelectElement;
    changeSelect(muniSelect, "09003");
    await flush();
  }
  const agebPath = "/analytics/locust-ageb?cve_mun=09003";

  it("keys the dataset on the request path alone", async () => {
    await renderAgeb();
    await pickMunicipio();
    const keys = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["locust"] })
      .map((q) => q.queryKey);
    // Picking X, then Y, then the municipio resolves to one URL; field
    // ids and the entidad are not part of the key.
    expect(keys.every((k) => k.length === 2)).toBe(true);
    expect(keys).toContainEqual(["locust", agebPath]);
  });

  it("sends no request for the old municipio after an entidad change", async () => {
    await renderAgeb();
    await pickMunicipio();
    expect(callsTo(agebPath)).toBe(1);

    act(() => useUiStore.setState({ entidad: "15" }));
    await flush();
    expect(callsTo(agebPath)).toBe(1);
    expect(container.textContent).toContain("Selecciona un municipio arriba");
  });
});
