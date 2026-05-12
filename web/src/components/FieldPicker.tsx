import { Command } from "cmdk";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  FIELD_CATALOG,
  FIELD_SOURCES,
  isFieldReachable,
  type FieldDef,
  type FieldSource,
} from "../lib/fields";

/**
 * ⌘K-style command palette for picking a field from the 14-source catalog.
 *
 * Slot-aware: callers pass a `predicate` that filters the visible set. X
 * slot passes `f => f.xEligible`; Y/Z slot passes `f => f.columns[xGrain]
 * !== undefined` so the user only sees fields that are graphable against
 * the chosen X.
 *
 * Unreachable / incompatible fields (predicate false OR no Locust endpoint
 * yet) are kept in the list but rendered greyed-out with "próximamente"
 * so the user discovers what's coming without being able to pick it.
 */
export function FieldPicker({
  open,
  onClose,
  onPick,
  axisLabel,
  predicate,
  contextHint,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (field: FieldDef) => void;
  axisLabel: string;
  /** Filter callback; defaults to "any reachable field". */
  predicate?: (f: FieldDef) => boolean;
  /** Optional hint shown under the axis label (why some fields are greyed). */
  contextHint?: string | null;
}) {
  const [filter, setFilter] = useState<FieldSource | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setFilter(null);
      setQuery("");
    }
  }, [open]);

  // Compute per-field selectability. Surface every field in the catalog
  // (so users see what's coming), but disable any that fail the
  // predicate or have no endpoint wiring.
  const items = useMemo(() => {
    return FIELD_CATALOG.filter((f) => !filter || f.source === filter).map(
      (f) => {
        const reachable = isFieldReachable(f);
        const allowed = predicate ? predicate(f) : reachable;
        let disabledReason: string | null = null;
        if (!reachable) disabledReason = "próximamente";
        else if (!allowed) disabledReason = "no comparable con X";
        return { field: f, disabledReason };
      },
    );
  }, [filter, predicate]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 pt-24"
      onClick={onClose}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
    >
      <div
        className="w-full max-w-xl rounded-lg border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-500">
            {axisLabel}
          </span>
          <span className="flex-1 font-mono text-xs text-slate-500">
            {contextHint ?? "Elige un campo del catálogo"}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-xs text-slate-500 hover:text-slate-200"
          >
            esc
          </button>
        </div>

        {/* Source facet chips */}
        <div className="flex flex-wrap gap-1 border-b border-slate-800 px-3 py-2">
          <FacetChip
            label="Todos"
            active={filter === null}
            onClick={() => setFilter(null)}
          />
          {FIELD_SOURCES.map((s) => (
            <FacetChip
              key={s}
              label={s}
              active={filter === s}
              onClick={() => setFilter(s)}
            />
          ))}
        </div>

        <Command className="bg-slate-900" shouldFilter={true}>
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Buscar campo… (escolaridad, pobreza, farmacias, homicidios…)"
            className="w-full border-b border-slate-800 bg-slate-950 px-4 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none"
          />
          <Command.List className="max-h-80 overflow-auto p-2">
            <Command.Empty className="px-2 py-4 font-mono text-xs text-slate-500">
              Sin resultados.
            </Command.Empty>
            {items.map(({ field: f, disabledReason }) => (
              <Command.Item
                key={f.id}
                value={`${f.id} ${f.label} ${f.description}`}
                disabled={disabledReason !== null}
                onSelect={() => {
                  if (disabledReason !== null) return;
                  onPick(f);
                  onClose();
                }}
                className={`rounded px-2 py-1.5 font-mono text-xs aria-selected:bg-slate-800 ${
                  disabledReason !== null
                    ? "cursor-not-allowed text-slate-600"
                    : "cursor-pointer text-slate-200"
                }`}
                data-testid={`field-${f.id}`}
                data-disabled={disabledReason !== null ? "true" : undefined}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{f.label}</span>
                  <span className="flex shrink-0 gap-1 font-mono text-[9px]">
                    {disabledReason !== null && (
                      <span className="rounded bg-amber-900/40 px-1 text-amber-400">
                        {disabledReason}
                      </span>
                    )}
                    <span className="rounded bg-slate-800 px-1 text-slate-400">
                      {f.source}
                    </span>
                    <span
                      className={`rounded bg-slate-800 px-1 ${
                        disabledReason !== null
                          ? "text-slate-600"
                          : "text-cyan-400"
                      }`}
                    >
                      {f.grain}
                    </span>
                  </span>
                </div>
                <div
                  className={`mt-0.5 text-[10px] ${
                    disabledReason !== null
                      ? "text-slate-700"
                      : "text-slate-500"
                  }`}
                >
                  {f.description}
                </div>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function FacetChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 font-mono text-[10px] ${
        active
          ? "bg-cyan-700 text-cyan-50"
          : "bg-slate-800 text-slate-400 hover:bg-slate-700"
      }`}
    >
      {label}
    </button>
  );
}
