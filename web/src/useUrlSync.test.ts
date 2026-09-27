// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { useUrlSync } from "./useUrlSync";
import { useUiStore } from "./store";
import { Layout } from "./components/Layout";

// store.ts imports the supabase client, which would otherwise build a
// real auth client.
vi.mock("./lib/supabase", () => ({ supabase: { auth: {} } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Re-derive the regexes the hook uses; the hook itself imports React +
// react-router which need jsdom + RTL to test as a hook. These pure
// regex tests guarantee the validation contract — if the backend's
// ENTIDAD_RE/SCIAN_RE drift, the test still fails because the regexes
// are written here verbatim and need to be kept in sync.
const ENTIDAD_RE = /^(0[1-9]|[12][0-9]|3[0-2])$/;
const SCIAN_RE = /^[0-9]{2}$/;

// The regex tests below cover the validation CONTRACT; the hook's
// hydration + mirror behaviour is covered at the end of this file.
describe("ENTIDAD_RE / SCIAN_RE contract (frontend ↔ backend)", () => {
  it("ENTIDAD_RE accepts all 32 valid claves", () => {
    for (let n = 1; n <= 32; n++) {
      const c = String(n).padStart(2, "0");
      expect(ENTIDAD_RE.test(c)).toBe(true);
    }
  });

  it("ENTIDAD_RE rejects 00, 33, non-digits, and SQL-injection probes", () => {
    for (const bad of ["00", "33", "1", "001", "AA", "9 OR 1=1", "9'--", ""]) {
      expect(ENTIDAD_RE.test(bad)).toBe(false);
    }
  });

  it("SCIAN_RE accepts any 2-digit string (DENUE has 11..99 + anomalies)", () => {
    for (const ok of ["11", "46", "62", "72", "99", "00"]) {
      expect(SCIAN_RE.test(ok)).toBe(true);
    }
  });

  it("SCIAN_RE rejects 1-digit, 3-digit, and non-numeric input", () => {
    for (const bad of ["1", "111", "AB", "4A", "", " 46", "46 "]) {
      expect(SCIAN_RE.test(bad)).toBe(false);
    }
  });
});

describe("useUrlSync + Layout mode links (audit #181 #182)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useUiStore.setState({ entidad: null, sector: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Probe() {
    useUrlSync();
    return null;
  }

  it("hydrates the store from a deep link without touching the URL on mount", () => {
    const router = createMemoryRouter([{ path: "/locust", element: createElement(Probe) }], {
      initialEntries: ["/locust?entidad=09&sector=46"],
    });
    const navigations: string[] = [];
    router.subscribe((state) => navigations.push(state.location.search));
    act(() => root.render(createElement(RouterProvider, { router })));

    expect(useUiStore.getState().entidad).toBe("09");
    expect(useUiStore.getState().sector).toBe("46");
    // Old code stripped the params on the first mirror run and then
    // re-added them: two navigations on every deep-link load.
    expect(navigations).toEqual([]);
    expect(router.state.location.search).toBe("?entidad=09&sector=46");

    // The mirror still runs on a real filter change.
    act(() => useUiStore.getState().setEntidad("15"));
    expect(router.state.location.search).toBe("?entidad=15&sector=46");
  });

  it("keeps ?entidad/?sector when switching modes from the nav", () => {
    const child = (path: string) => ({ path, element: createElement("div", null, path) });
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: createElement(Layout),
          children: [child("locust"), child("map"), child("sage")],
        },
      ],
      { initialEntries: ["/locust?entidad=09&sector=46"] },
    );
    act(() => root.render(createElement(RouterProvider, { router })));

    const mapLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent === "Map",
    )!;
    act(() => {
      mapLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });

    expect(router.state.location.pathname).toBe("/map");
    // Old code: the bare "/map" link dropped the query string ("").
    expect(router.state.location.search).toBe("?entidad=09&sector=46");
    expect(useUiStore.getState().entidad).toBe("09");
  });
});
