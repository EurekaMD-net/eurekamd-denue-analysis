import { lazy, Suspense, useEffect, useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  type RouteObject,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LoginGate } from "./components/LoginGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { RouteError } from "./components/RouteError";
import { shouldRetryQuery } from "./api/client";
import { useUiStore } from "./store";

// MapMode pulls maplibre-gl + deck.gl (~1.5 MB JS). Lazy-loaded so the
// default /locust landing doesn't pay the cost. Audit P3-perf D fix
// (2026-05-04) — production build splits this into its own chunk;
// in dev mode the import is a single fetch on /map navigation.
//
// MapMode is a NAMED export, but React.lazy expects a module with a
// `default` export — the `.then(...)` adapter rewrites the shape.
// Chunk-load failures (and render errors) are caught by each route's
// <RouteError> errorElement, which reloads on a stale chunk (audit #178);
// they never reach the app-level <ErrorBoundary>.
const MapMode = lazy(() =>
  import("./modes/MapMode").then((m) => ({ default: m.MapMode })),
);

// LocustMode pulls echarts (~1.9 MB source). Lazy so the login screen
// and /map, /sage don't download it (audit #179).
const LocustMode = lazy(() =>
  import("./modes/LocustMode").then((m) => ({ default: m.LocustMode })),
);

const SageMode = lazy(() =>
  import("./modes/SageMode").then((m) => ({ default: m.SageMode })),
);

// Operator-only deep-dive route, kept reachable but unlinked.
const LegacyDashboard = lazy(() =>
  import("./modes/LegacyDashboard").then((m) => ({
    default: m.LegacyDashboard,
  })),
);

function MapModeFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-slate-950">
      <div className="font-mono text-xs text-slate-500">
        cargando MapLibre + deck.gl…
      </div>
    </div>
  );
}

function SageModeFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-slate-950">
      <div className="font-mono text-xs text-slate-500">cargando Sage…</div>
    </div>
  );
}

function LazyRouteFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-slate-950">
      <div className="font-mono text-xs text-slate-500">cargando…</div>
    </div>
  );
}

// Exported for the errorElement coverage test.
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        element: <Navigate to="/locust" replace />,
        errorElement: <RouteError />,
      },
      {
        path: "locust",
        element: (
          <Suspense fallback={<LazyRouteFallback />}>
            <LocustMode />
          </Suspense>
        ),
        errorElement: <RouteError />,
      },
      {
        path: "map",
        element: (
          <Suspense fallback={<MapModeFallback />}>
            <MapMode />
          </Suspense>
        ),
        errorElement: <RouteError />,
      },
      {
        path: "sage",
        element: (
          <Suspense fallback={<SageModeFallback />}>
            <SageMode />
          </Suspense>
        ),
        errorElement: <RouteError />,
      },
      {
        path: "legacy/dashboard",
        element: (
          <Suspense fallback={<LazyRouteFallback />}>
            <LegacyDashboard />
          </Suspense>
        ),
        errorElement: <RouteError />,
      },
    ],
  },
];

const router = createBrowserRouter(routes);

export function App() {
  // Per-instance QueryClient so vitest tests get isolated caches.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            retry: shouldRetryQuery,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  // Wire the QueryClient into the store so signOut() can cancel +
  // clear before the next user lands (audit C C3).
  const setQueryClient = useUiStore((s) => s.setQueryClient);
  useEffect(() => {
    setQueryClient(queryClient);
  }, [queryClient, setQueryClient]);
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <LoginGate>
          <RouterProvider router={router} />
        </LoginGate>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
