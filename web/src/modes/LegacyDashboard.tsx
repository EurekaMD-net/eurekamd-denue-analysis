import { useEntidades } from "../api/queries";
import { useUiStore } from "../store";
import { useUrlSync } from "../useUrlSync";
import { NationalTreemap } from "../charts/NationalTreemap";
import { SectorGradeMatrix } from "../charts/SectorGradeMatrix";
import { TopSectoresBar } from "../charts/TopSectoresBar";
import { DensidadPobrezaScatter } from "../charts/DensidadPobrezaScatter";
import { SaludCobertura } from "../charts/SaludCobertura";
import { FilterControls } from "../components/FilterPanel";
import { SearchBar } from "../components/SearchBar";

/**
 * Locust mode — analytics dashboard reading 4 sources (DENUE × Censo ×
 * CONEVAL × CLUES) as a single story.
 *
 * Layout:
 *   - Sticky toolbar: search · entidad picker · provenance tagline
 *   - Section "Panorama nacional": treemap + sector×IRS heatmap
 *   - Section "Detalle estatal" (header reflects selected entidad):
 *     top sectores · scatter · salud cobertura
 */
export function LegacyDashboard() {
  useUrlSync();
  const entidad = useUiStore((s) => s.entidad);
  const { data: entidadesData } = useEntidades();
  const entidadNombre = entidadesData?.entidades.find(
    (e) => e.clave === entidad,
  )?.nombre;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-slate-950">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-slate-950/80">
        <SearchBar />
        <span className="hidden h-5 w-px bg-slate-800 sm:block" />
        <FilterControls />
        <div className="flex-1" />
        <span className="font-mono text-[10px] text-slate-600">
          DENUE × Censo 2020 × CONEVAL × CLUES
        </span>
      </div>

      <SectionHeader
        eyebrow="01 / Panorama nacional"
        title="Tejido económico y rezago social a nivel nacional"
      />
      <div className="grid grid-cols-1 gap-3 px-3 pb-4 md:grid-cols-2 xl:gap-5 xl:px-5 xl:pb-6">
        <NationalTreemap />
        <SectorGradeMatrix />
      </div>

      <SectionHeader
        eyebrow="02 / Detalle estatal"
        title={
          entidadNombre
            ? `Foco en ${entidadNombre}`
            : "Selecciona una entidad arriba para enfocar"
        }
        muted={!entidadNombre}
      />
      <div className="grid grid-cols-1 gap-3 px-3 pb-6 lg:grid-cols-3 xl:gap-5 xl:px-5 xl:pb-8">
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

interface SectionHeaderProps {
  eyebrow: string;
  title: string;
  muted?: boolean;
}

function SectionHeader({ eyebrow, title, muted = false }: SectionHeaderProps) {
  return (
    <div className="flex items-baseline gap-3 px-4 pb-1 pt-4 xl:px-6 xl:pt-6">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-500/80">
        {eyebrow}
      </span>
      <h2
        className={`font-mono text-xs ${
          muted ? "text-slate-600" : "text-slate-300"
        }`}
      >
        {title}
      </h2>
    </div>
  );
}
