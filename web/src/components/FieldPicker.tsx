import { Command } from "cmdk";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  FIELD_CATALOG,
  FIELD_SOURCES,
  type FieldDef,
  type FieldSource,
} from "../lib/fields";

/**
 * ⌘K-style command palette for picking a field from the 14-source catalog.
 * Opens via a button in AxisPanel and is mountable elsewhere.
 *
 * Search: fuzzy over label + description + id; source facet chips at top.
 */
export function FieldPicker({
  open,
  onClose,
  onPick,
  axisLabel,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (field: FieldDef) => void;
  axisLabel: string;
}) {
  const [filter, setFilter] = useState<FieldSource | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setFilter(null);
      setQuery("");
    }
  }, [open]);

  const filtered = useMemo(() => {
    return FIELD_CATALOG.filter((f) => !filter || f.source === filter);
  }, [filter]);

  // R2 audit W5 — bind Escape so keyboard users have an exit.
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
            Elige un campo del catálogo
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
            {filtered.map((f) => (
              <Command.Item
                key={f.id}
                value={`${f.id} ${f.label} ${f.description}`}
                onSelect={() => {
                  onPick(f);
                  onClose();
                }}
                className="cursor-pointer rounded px-2 py-1.5 font-mono text-xs text-slate-200 aria-selected:bg-slate-800"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{f.label}</span>
                  <span className="flex shrink-0 gap-1 font-mono text-[9px]">
                    <span className="rounded bg-slate-800 px-1 text-slate-400">
                      {f.source}
                    </span>
                    <span className="rounded bg-slate-800 px-1 text-cyan-400">
                      {f.grain}
                    </span>
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-slate-500">
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
