# Source Evaluation — SICT Datos Viales (TDPA) 2024

**URL:** `https://repodatos.atdt.gob.mx/api_update/secretaria_comunicaciones/datos_viales/datos_viales_2024.csv`
**Publisher:** Secretaría de Infraestructura, Comunicaciones y Transportes (SICT, ex-SCT) — Dirección General de Servicios Técnicos.
**Period:** Enero–diciembre 2024 (annual roll-up; single periodo across all rows).
**Last-Modified:** 2026-03-24 (production CSV; we re-pull on each ingest).
**Size:** ~1.99 MB / 10,326 data rows / 26 columns.

## What this is

TDPA = **Tránsito Diario Promedio Anual** — the average vehicles-per-day flowing past each road-side automatic counter station on Mexico's federal highway network during 2024. Each row is one (station × directional segment) pairing. SICT also publishes the per-row **vehicle-class breakdown** (motos / autos / buses / 4 truck-axle classes / "otros") as percentages of TDPA, plus traffic-engineering coefficients (`k'`, `d`).

This adds a **road-traffic-intensity dimension** to DENUE muni analytics that no current source covers: a muni traversed by MEX-095D at TDPA 80,000 has very different commercial economics than a peer muni reached only by a state road at TDPA 1,200 — even at identical population and IRS.

## Schema (raw, 26 cols)

| Col                                  | Type                | Notes                                                                                                                                |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `periodo`                            | text                | Always `Enero-diciembre 2024` for this file. Will vary per annual pull.                                                              |
| `estado`                             | text                | Estado name (Spanish, with accents).                                                                                                 |
| `carretera`                          | text                | Highway name (e.g. `Acceso a Pabellon de Arteaga`). 987 distinct.                                                                    |
| `clave`                              | text/numeric        | Station ID. Format `1234.0`. Some rows: literal string `sin dato` (no station code) — 495 rows.                                      |
| `ruta`                               | text                | Route code (e.g. `MEX-045`).                                                                                                         |
| `punto_generador`                    | text                | Reference point / direction. Suffixes vary: `(Alta)`, `(Baja)`, `(Cuota)`, `(Libre)`, `(Norte)`, etc.                                |
| `km`                                 | numeric             | Kilometer marker.                                                                                                                    |
| `te`                                 | numeric             | Tipo de estación (engineering classification). 1188 nulls.                                                                           |
| `sc`                                 | numeric             | Subsection code. 1188 nulls.                                                                                                         |
| `tdpa`                               | numeric             | **The core metric**: vehicles/day annual avg. Range 4..111,097. 1188 nulls.                                                          |
| `m,a,b,c2,c3,t3s2,t3s3,t3s2r4,otros` | numeric (% of TDPA) | Vehicle-class composition. Sums to ~88.5% on average (intentional — class % do not include all unaccounted categories; rounding).    |
| `a1,b1,c`                            | numeric (% of TDPA) | Roll-ups: `a1`=autos+motos, `b1`=buses, `c`=trucks total. Same ~88.5% sum.                                                           |
| `k'`                                 | numeric             | Traffic-engineering peak-hour-factor coefficient. **Note**: column header literally `k'` (apostrophe). Renamed to `k_prime` on load. |
| `d`                                  | numeric             | Directional split coefficient.                                                                                                       |
| `latitud`                            | numeric             | WGS84 latitude. 14.630..32.703 (Mexico bounds ✓). 1186 nulls.                                                                        |
| `longitud`                           | numeric             | WGS84 longitude. -117.121..-86.889 (Mexico bounds ✓). 1186 nulls.                                                                    |

## Data-quality gotchas

1. **Border stations are double-reported.** 2,296 (clave, punto_generador, km, te, sc) tuples appear in TWO rows that differ only in the `estado` column — same lat/lon, same TDPA, same everything else. SICT publishes border stations under both estados (each estado claims them for its road-network inventory). We dedupe via `DISTINCT ON (latitud, longitud, clave, punto_generador, km, te, sc)` in the load view and let the PostGIS spatial join assign the station to ONE muni based on coordinates.
2. **1,188 rows have empty measurement data** (and no lat/lon). They retain ID columns (estado/carretera/clave/ruta/punto_generador/km) but `te`, `sc`, `tdpa`, all class %s, `k'`, `d`, `latitud`, `longitud` are blank. Probably stations with no 2024 measurements (decommissioned, instrumentation failure, recently added). Loaded as raw with NULLs; excluded from view via `WHERE tdpa IS NOT NULL AND latitud IS NOT NULL`.
3. **`clave='sin dato'`** appears in 495 rows. These are valid measurement points without an assigned station code (perhaps temporary or special-purpose counters). Kept in raw.
4. **`k'` apostrophe in header.** Pandas/openpyxl accept; PostgreSQL identifier rules don't. Pre-pass renames to `k_prime`.
5. **Class % sums to ~100% in cleaned data**, but the **raw-file** average appears to be ~88.5% — that figure is dragged down by the 1,188 empty-measurement rows whose class cells are blank (treated as 0 in arithmetic). Once those rows are filtered (`WHERE tdpa IS NOT NULL`), per-row sums fall in 99.5..100.5 (rounding noise). TDPA-weighted muni aggregates land in 99.98..100.02. Don't re-normalize.

## Grain & DENUE fit

**Native grain:** road station × directional segment.
**DENUE-target grain:** muni (`cve_mun` = 5-digit cvegeo).
**Bridge:** **PostGIS spatial join.** Each station has lat/lon → `ST_Contains(mun_polygons.geom, ST_SetSRID(ST_MakePoint(longitud, latitud), 4326))` resolves to exactly one muni.

This is the FIRST DENUE source where the bridge is geometric rather than (a) native cve_mun [CNBV / CONEVAL / Censo / SESNSP], (b) curated lookup [aeropuertos], or (c) AGEB-level [RESAGEBURB / GRS / SINBA]. We already have `mun_polygons` (SRID 4326, GIST-indexed) loaded from v0.1 — no new geometry to ingest.

**Coverage (live, post-load 2026-05-10):** 10,326 raw rows → 6,827 unique geo-located stations after dedupe + filter → 1,153 distinct munis (~46% of 2,469 munis nationally). Federal highways don't reach every muni.

## Aggregation strategy (`sict_traffic_by_municipio`)

Per `cve_mun`:

- `station_count` — number of TDPA stations in this muni
- `tdpa_total` — sum of TDPA across all stations (gross daily traffic intensity)
- `tdpa_max` — busiest single station (peak corridor)
- `tdpa_mean` — average TDPA per station
- Weighted-by-TDPA vehicle composition: `pct_motos`, `pct_autos`, `pct_buses`, `pct_camiones` (= sum c2+c3+t3s2+t3s3+t3s2r4), `pct_otros`
- `route_count` — distinct `ruta` values
- `routes_top` — top-3 routes by station count (text array)

**Why weighted-by-TDPA?** A muni with 1 station at 80k TDPA carrying 70% trucks and 1 station at 800 TDPA carrying 20% trucks is _commercially_ a heavy-truck corridor (78.5% truck share weighted by traffic), not the simple-mean's 45% truck share. Weighting reflects what an observer at the road would actually see.

## Materialization

**Plan:** `sict_traffic_by_municipio` as a **MATERIALIZED VIEW** with btree on `cve_mun`. The point-in-polygon spatial join across 9k stations × 2.4k muni polygons is O(N×M) without spatial indexing; with the existing GIST on `mun_polygons.geom` it drops to ~O(N×log M) but is still ~hundreds of ms. Materializing once + indexing makes the analytics-handler JOIN O(log n).

This deviates from the CNBV/CONEVAL pattern (regular views) but matches `ce2024_municipal` (already materialized). Justification: spatial cost.

## Endpoint integration

`MunicipioDetailResult.datos_viales` (new optional subtree, NULL if no traffic data for this muni):

```ts
interface DatosVialesResult {
  station_count: number;
  tdpa_total: number;
  tdpa_max: number;
  tdpa_mean: number;
  composition: {
    pct_motos: number;
    pct_autos: number;
    pct_buses: number;
    pct_camiones: number;
    pct_otros: number;
  };
  route_count: number;
  routes_top: string[];
}
```

Estado grain (`EntidadDetailResult`) deferred to v0.2.14 — needs separate aggregation (sum across all stations in the entidad, not just those geocoded to muni).

## Brecha-style gotchas to pin

None (no gendered metrics in this source). The relevant pin is the **border-double-reporting** finding — adds to the data-authoring patterns cluster.

## Verification queries

```sql
-- 1) Sanity: post-dedup station count and muni coverage
SELECT
  (SELECT COUNT(*) FROM sict_estaciones_viales) AS station_rows,
  (SELECT COUNT(DISTINCT cve_mun) FROM sict_estaciones_viales) AS distinct_muni,
  (SELECT COUNT(*) FROM sict_traffic_by_municipio) AS muni_with_traffic;

-- 2) Top-10 busiest munis by total TDPA
SELECT cve_mun, station_count, tdpa_total, tdpa_max, route_count
FROM sict_traffic_by_municipio
ORDER BY tdpa_total DESC
LIMIT 10;

-- 3) Verify weighted composition sums approximate the per-station mean
SELECT cve_mun,
       pct_motos + pct_autos + pct_buses + pct_camiones + pct_otros AS sum_pct
FROM sict_traffic_by_municipio
ORDER BY sum_pct;
-- Expect: 99.98..100.02 (rounding noise in 2dp weighted aggregates).
```

## v0.2.13 commit checkpoint

Single commit bundle:

- `scripts/sict-datos-viales-csv-clean.py` (pre-pass: rename `k'` → `k_prime`, sentinel for empty)
- `scripts/load-sict-datos-viales.ts` (raw + materialized view + indexes)
- `scripts/load-sict-datos-viales.test.ts` (unit tests + DDL drift guard)
- `src/api/types.ts` (DatosVialesResult interface)
- `src/api/handlers/analytics.ts` (LEFT JOIN, marshaller)
- `src/api/handlers/analytics.test.ts` (subtree assertions, NULL-fallback, regression)
- `docs/v0.2-status.md` (v0.2.13 entry)

After: Datatur is the only remaining open layer.
