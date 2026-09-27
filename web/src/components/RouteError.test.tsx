// @vitest-environment jsdom
import { act, lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  type RouteObject,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isChunkLoadError, reloadForStaleChunk, RouteError } from "./RouteError";
import { ErrorBoundary } from "./ErrorBoundary";
import { reloadPage } from "../lib/reload";

// jsdom's location.reload is non-configurable; the app reloads through
// this module so the tests can observe it.
vi.mock("../lib/reload", () => ({ reloadPage: vi.fn() }));
// App.tsx (imported below for its route table) pulls in LoginGate,
// which would otherwise build a real auth client.
vi.mock("../lib/supabase", () => ({ supabase: { auth: {} } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const reloadMock = reloadPage as unknown as ReturnType<typeof vi.fn>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  reloadMock.mockClear();
  window.sessionStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("isChunkLoadError", () => {
  it("matches the Chrome, Safari and Firefox chunk-load messages", () => {
    expect(
      isChunkLoadError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://x/assets/MapMode-abc.js",
        ),
      ),
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError("Importing a module script failed.")),
    ).toBe(true);
    expect(
      isChunkLoadError(
        new TypeError("error loading dynamically imported module: https://x/a.js"),
      ),
    ).toBe(true);
  });

  it("does not match ordinary render errors", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of null"))).toBe(
      false,
    );
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("reloadForStaleChunk", () => {
  it("reloads once, then refuses within 10 s so a missing chunk cannot loop", () => {
    expect(reloadForStaleChunk(1_000_000)).toBe(true);
    expect(reloadForStaleChunk(1_005_000)).toBe(false);
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(reloadForStaleChunk(1_011_000)).toBe(true);
    expect(reloadMock).toHaveBeenCalledTimes(2);
  });
});

function Shell() {
  return (
    <div>
      <header>DENUE Analyzer</header>
      <Outlet />
    </div>
  );
}

function Boom(): never {
  throw new Error("render exploded");
}

async function renderAt(children: RouteObject[]) {
  const router = createMemoryRouter(
    [{ path: "/", element: <Shell />, errorElement: <RouteError />, children }],
    { initialEntries: ["/child"] },
  );
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  // Let a rejected lazy import settle and re-render.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("RouteError as a child errorElement (audit #178)", () => {
  it("keeps the Layout header up and shows the error, without reloading", async () => {
    await renderAt([
      { path: "child", element: <Boom />, errorElement: <RouteError /> },
    ]);
    expect(container.textContent).toContain("DENUE Analyzer");
    expect(container.textContent).toContain("render exploded");
    expect(container.textContent).not.toContain("Unexpected Application Error");
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("reloads the page when a lazy route chunk fails to load", async () => {
    const Stale = lazy(() =>
      Promise.reject(
        new TypeError(
          "Failed to fetch dynamically imported module: https://x/assets/MapMode-old.js",
        ),
      ),
    );
    await renderAt([
      {
        path: "child",
        element: (
          <Suspense fallback={null}>
            <Stale />
          </Suspense>
        ),
        errorElement: <RouteError />,
      },
    ]);
    expect(container.textContent).toContain("DENUE Analyzer");
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});

describe("App routes", () => {
  it("give every route a RouteError errorElement", async () => {
    const { routes } = await import("../App");
    const missing: string[] = [];
    const walk = (rs: RouteObject[]) => {
      for (const r of rs) {
        const el = r.errorElement as { type?: unknown } | undefined;
        if (el?.type !== RouteError) missing.push(r.path ?? "(index)");
        if (r.children) walk(r.children);
      }
    };
    walk(routes);
    expect(routes.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

describe("ErrorBoundary retry", () => {
  it("reloads the page instead of re-rendering a cached rejected lazy()", async () => {
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Reintentar");
    await act(async () => {
      button?.click();
    });
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
