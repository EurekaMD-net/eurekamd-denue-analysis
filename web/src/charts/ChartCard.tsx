import { type ReactNode } from "react";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  isEmpty?: boolean;
  emptyMessage?: string;
  children: ReactNode;
  /** Tailwind h-* class. Default h-80 (320px). */
  height?: string;
}

/**
 * Wraps every Locust-mode chart with a consistent panel + title + state.
 * Loading shows a pulsing skeleton; error shows a red header bar; empty
 * shows a centered hint. Body renders only when data is present.
 */
export function ChartCard({
  title,
  subtitle,
  isLoading,
  isError,
  errorMessage,
  isEmpty,
  emptyMessage = "Sin datos disponibles",
  children,
  height = "h-80",
}: ChartCardProps) {
  return (
    <section
      className={`flex flex-col rounded-md border border-slate-800 bg-slate-900 ${height}`}
    >
      <header className="flex items-baseline justify-between border-b border-slate-800 px-3 py-2">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-cyan-400">
          {title}
        </h2>
        {subtitle && (
          <span className="text-[11px] text-slate-500">{subtitle}</span>
        )}
      </header>
      <div className="relative flex-1 overflow-hidden p-2">
        {isLoading && (
          <div className="flex h-full items-center justify-center">
            <div className="font-mono text-xs text-slate-500">cargando…</div>
          </div>
        )}
        {isError && (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <div className="font-mono text-xs text-rose-400">
              {errorMessage ?? "error de red"}
            </div>
          </div>
        )}
        {!isLoading && !isError && isEmpty && (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <div className="font-mono text-xs text-slate-500">
              {emptyMessage}
            </div>
          </div>
        )}
        {!isLoading && !isError && !isEmpty && (
          <div className="h-full w-full">{children}</div>
        )}
      </div>
    </section>
  );
}
