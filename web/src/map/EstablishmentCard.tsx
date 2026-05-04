import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useUiStore } from "../store";
import { apiFetch } from "../api/client";

const ESTABLISHMENT_RESULT = z.object({
  clee: z.string(),
  data: z.record(z.string(), z.unknown()),
});

interface Props {
  clee: string | null;
  onClose: () => void;
}

/**
 * Side panel rendering full DENUE record for a clicked establishment.
 * Hits /establishment/:clee, validates with Zod, formats the most
 * useful fields. Unknown fields are listed verbatim at the bottom.
 */
export function EstablishmentCard({ clee, onClose }: Props) {
  const apiKey = useUiStore((s) => s.apiKey);
  const enabled = clee !== null && apiKey !== null;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["establishment", clee],
    queryFn: async () => {
      const res = await apiFetch(
        `/establishment/${encodeURIComponent(clee ?? "")}`,
        {},
        apiKey,
      );
      const body: unknown = await res.json();
      return ESTABLISHMENT_RESULT.parse(body);
    },
    enabled,
    staleTime: 5 * 60_000,
  });

  if (!clee) return null;

  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-80 flex-col border-l border-slate-800 bg-slate-950/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-cyan-400">
          Establecimiento
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-slate-700 px-2 py-0.5 font-mono text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
        >
          cerrar
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3 text-xs">
        {isLoading && <div className="font-mono text-slate-500">cargando…</div>}
        {isError && (
          <div className="font-mono text-rose-400">
            {error instanceof Error ? error.message : "error"}
          </div>
        )}
        {data && <Details data={data.data} clee={data.clee} />}
      </div>
    </aside>
  );
}

const HERO_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "nombre", label: "Nombre" },
  { key: "razon_social", label: "Razón social" },
  { key: "clase_actividad", label: "Actividad" },
  { key: "estrato", label: "Estrato" },
  { key: "entidad", label: "Entidad" },
  { key: "municipio", label: "Municipio" },
  { key: "ageb", label: "AGEB (CVEGEO)" },
  { key: "tipo_vialidad", label: "Tipo vialidad" },
  { key: "calle", label: "Calle" },
  { key: "num_exterior", label: "Núm ext" },
  { key: "colonia", label: "Colonia" },
  { key: "cp", label: "CP" },
  { key: "telefono", label: "Teléfono" },
  { key: "correo_e", label: "Correo" },
  { key: "www", label: "Web" },
  { key: "latitud", label: "Lat" },
  { key: "longitud", label: "Lon" },
];

function Details({
  data,
  clee,
}: {
  data: Record<string, unknown>;
  clee: string;
}) {
  const heroKeys = new Set(HERO_FIELDS.map((f) => f.key));
  const orphans = Object.entries(data).filter(([k]) => !heroKeys.has(k));

  return (
    <div className="space-y-3">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
          CLEE
        </div>
        <div className="break-all font-mono text-[11px] text-slate-200">
          {clee}
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-x-2 gap-y-2">
        {HERO_FIELDS.map(({ key, label }) => {
          const v = data[key];
          if (v === null || v === undefined || v === "") return null;
          return (
            <div key={key}>
              <dt className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                {label}
              </dt>
              <dd className="font-mono text-[11px] text-slate-200">
                {String(v)}
              </dd>
            </div>
          );
        })}
      </dl>
      {orphans.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300">
            Otros campos ({orphans.length})
          </summary>
          <dl className="mt-2 grid grid-cols-1 gap-x-2 gap-y-1.5">
            {orphans.map(([k, v]) => {
              if (v === null || v === undefined || v === "") return null;
              return (
                <div key={k}>
                  <dt className="font-mono text-[10px] uppercase tracking-wider text-slate-600">
                    {k}
                  </dt>
                  <dd className="break-all font-mono text-[10px] text-slate-300">
                    {typeof v === "object" ? JSON.stringify(v) : String(v)}
                  </dd>
                </div>
              );
            })}
          </dl>
        </details>
      )}
    </div>
  );
}
