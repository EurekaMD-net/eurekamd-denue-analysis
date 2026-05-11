import { lazy, Suspense, useEffect, useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LoginGate } from "./components/LoginGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { LocustMode } from "./modes/LocustMode";
import { useUiStore } from "./store";

// MapMode pulls maplibre-gl + deck.gl (~1.5 MB JS). Lazy-loaded so the
// default /locust landing doesn't pay the cost. Audit P3-perf D fix
// (2026-05-04) — production build splits this into its own chunk;
// in dev mode the import is a single fetch on /map navigation.
//
// MapMode is a NAMED export, but React.lazy expects a module with a
// `default` export — the `.then(...)` adapter rewrites the shape.
// Chunk-load failures bubble up to the root <ErrorBoundary> rather
// than spinning forever in the Suspense fallback.
const MapMode = lazy(() =>
  import("./modes/MapMode").then((m) => ({ default: m.MapMode })),
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

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/locust" replace /> },
      { path: "locust", element: <LocustMode /> },
      {
        path: "map",
        element: (
          <Suspense fallback={<MapModeFallback />}>
            <MapMode />
          </Suspense>
        ),
      },
      {
        path: "sage",
        element: (
          <Suspense fallback={<SageModeFallback />}>
            <SageMode />
          </Suspense>
        ),
      },
      {
        path: "legacy/dashboard",
        element: (
          <Suspense fallback={<LazyRouteFallback />}>
            <LegacyDashboard />
          </Suspense>
        ),
      },
    ],
  },
]);

export function App() {
  // Per-instance QueryClient so vitest tests get isolated caches.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            retry: 1,
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
