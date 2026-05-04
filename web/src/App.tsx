import { useState } from "react";
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
import { MapMode } from "./modes/MapMode";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/locust" replace /> },
      { path: "locust", element: <LocustMode /> },
      { path: "map", element: <MapMode /> },
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
