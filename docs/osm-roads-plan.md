# OSM Roads per-AGEB aggregates

First satellite / external-spatial layer in the warehouse.

## Why

The warehouse already joins 7+ datasets on `cvegeo` (13-char AGEB) and `cve_mun` (5-char municipio): DENUE, Censo 2020, CONEVAL, CLUES, CE 2024, EDR, SESNSP, ENIGH, ENOE, SINBA. Missing: an accessibility signal. OSM road density is the cheapest, highest-ROI proxy — captures whether an AGEB is on a thoroughfare or stranded, whether it has highway-grade connectivity, and whether commercial logistics are physically reachable.

Pre-aggregated path was picked over raw OSM load (~5-8 GB in PostGIS) because every existing warehouse pattern is "one row per AGEB, joined widely." Raw OSM breaks that pattern and adds 150× the disk for marginal flexibility — see the disk comparison in the original scope.

## Schema

```sql
osm_ageb_aggregates (
  cvegeo                       TEXT PRIMARY KEY REFERENCES ageb_polygons(cvegeo),
  road_length_m                NUMERIC,    -- SUM of road segments intersecting the AGEB, geodesic m
  road_density_km_per_km2      NUMERIC,    -- (road_length_m / 1000) / (ageb_area_m2 / 1e6)
  dist_to_major_road_m         NUMERIC,    -- MIN distance to nearest motorway/trunk/primary, geodesic m
  has_major_road_within_5km    BOOLEAN,
  road_class_counts            JSONB,      -- {"residential":42, "secondary":3, ...}
  loaded_at                    TIMESTAMPTZ DEFAULT now()
)
```

Steady-state: 80k rows × 6 cols ≈ 10 MB on disk.

## Pipeline

```
scripts/fetch-osm-mexico.sh                      # ~10 min, 750 MB PBF
  ↓
osmium tags-filter w/highway                     # ~2 min, 80 MB filtered PBF
  ↓
osmium export --output-format=geojsonseq         # ~3 min, 150 MB
  ↓
sed -i 's/\x1e//g'                               # strip RFC 8142 RS prefix
  ↓
docker cp → container:/tmp/osm_roads.geojsonseq  # ~1 min
  ↓
psql session (single txn):
  CREATE TEMP osm_roads_loader (feat JSONB)      # ON COMMIT DROP
  \copy ... DELIMITER=0x01 QUOTE=0x02
  CREATE TEMP osm_roads_staging AS SELECT ...    # ON COMMIT DROP
  CREATE INDEX ... USING GIST (geom)
  CREATE INDEX ... USING GIST (geom) WHERE highway IN ('motorway','trunk','primary')
  INSERT INTO osm_ageb_aggregates SELECT ...
  COMMIT                                         # temps gone
  ↓
docker rm /tmp/osm_roads.geojsonseq              # cleanup
```

Total runtime: ~22 min. Steady-state disk added: 10 MB.

## Pre-condition

`ageb_polygons` table must exist (loaded once via ogr2ogr from INEGI Marco Geoestadístico 2020 — same prereq as `backfill-ageb.ts`).

## Refresh cadence

Weekly via `ops/osm-refresh.timer` (Sun 06:00 UTC). OSM road network edits in Mexico land on a multi-week timescale; daily is churn. Monthly would also be defensible.

## Auditor catches folded same-bundle

This pipeline shipped with 5 audit findings folded in the same bundle:

- **C1**: `\copy` with QUOTE=0x1E collides with osmium's RFC 8142 RS-prefix → switched QUOTE to 0x02 (STX, illegal in JSON strings) AND added `sed -i` strip step.
- **C2**: KNN `<->` operands wrapped in `ST_SetSRID` defeated the GIST index → unwrapped + added partial GIST on major-road subset.
- **W2**: removed `seg_sum_unused` aggregation artifact from inner subquery.
- **W5**: try/finally cleanup now covers `docker cp` step (not just aggregate), so a partial 150 MB file in the container is reaped on cp failure.
- **W6**: added `SET statement_timeout = '25min'` inside the aggregate txn so PG kills a runaway plan before systemd kills the wrapper at 30 min.
- **R4** (companion): verified `/usr/bin/node` and `/usr/bin/npx` are on the systemd `PATH=`; added inline comment in the unit.

Sage role grant (`scripts/sage-role.sql`) was extended with `GRANT SELECT ON osm_ageb_aggregates TO denue_sage;` so the LLM-drafted SQL path can read it. Not on `FORBIDDEN_RELATIONS` (small final aggregate table, queried directly by analytics endpoints — same pattern as `clues`).

## Deferred follow-ups (next ships)

Same `osm_ageb_aggregates` pattern, additive table columns / sibling tables:

- **Buildings** (`building=*`): per-AGEB total footprint area m², count, mean footprint size. Largest of the OSM layers — separate loader.
- **POIs** (`amenity=*`, `shop=*`): cross-validation vs DENUE coverage; per-AGEB count by class. Tiny.
- **Land use** (`landuse=*`): per-AGEB area share of residential / commercial / industrial / retail. Medium.

Each ships as its own `load-osm-<layer>.ts` + `osm_ageb_<layer>` table — keeps the per-loader runtime bounded and the schema additive.

Also deferred: an integration test that runs `buildAggregateSql` against a real PostGIS with a 2-feature fixture (audit R1). The current 26 unit tests assert string shapes; an integration test would have caught C1 + C2 at build time. Worth adding before the buildings loader ships, since that loader will reuse the same `\copy` framing.
