import { useEntidades } from "../api/queries";
import { useUiStore } from "../store";
import { NationalTreemap } from "../charts/NationalTreemap";
import { SectorGradeMatrix } from "../charts/SectorGradeMatrix";
import { TopSectoresBar } from "../charts/TopSectoresBar";
import { DensidadPobrezaScatter } from "../charts/DensidadPobrezaScatter";
import { SaludCobertura } from "../charts/SaludCobertura";
import { FilterPanel } from "../components/FilterPanel";
import { SearchBar } from "../components/SearchBar";

/**
 * Locust mode — analytics dashboard reading 4 sources (DENUE × Censo ×
 * CONEVAL × CLUES) as a single story.
 *
 * Layout:
 *   - Top bar: search box (debounced /search)
 *   - Row 1 (national, no filter): treemap + sector×IRS heatmap
 *   - Filter panel (entidad picker)
 *   - Row 2 (per-entidad): top sectores · scatter · salud cobertura
 */
export function LocustMode() {
  const entidad = useUiStore((s) => s.entidad);
  const { data: entidadesData } = useEntidades();
  const entidadNombre = entidadesData?.entidades.find(
    (e) => e.clave === entidad,
  )?.nombre;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-slate-950">
      <div className="flex items-center gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2">
        <SearchBar />
        <div className="flex-1" />
        <span className="font-mono text-[10px] text-slate-600">
          DENUE × Censo 2020 × CONEVAL × CLUES
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
        <NationalTreemap />
        <SectorGradeMatrix />
      </div>

      <FilterPanel />

      <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-3">
        <TopSectoresBar entidad={entidad} entidadNombre={entidadNombre} />
        <DensidadPobrezaScatter
          entidad={entidad}
          entidadNombre={entidadNombre}
        />
        <SaludCobertura entidad={entidad} entidadNombre={entidadNombre} />
      </div>
    </div>
  );
}
