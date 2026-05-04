import { lazy, Suspense, useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiKeyGate } from "./components/ApiKeyGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { LocustMode } from "./modes/LocustMode";

// MapMode pulls maplibre-gl + deck.gl (~1.5 MB JS). Lazy-loaded so the
// default /locust landing doesn't pay the cost. Audit P3-perf D fix
// (2026-05-04) — production build splits this into its own chunk;
// in dev mode the import is a single fetch on /map navigation.
const MapMode = lazy(() =>
  import("./modes/MapMode").then((m) => ({ default: m.MapMode })),
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
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ApiKeyGate>
          <RouterProvider router={router} />
        </ApiKeyGate>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
