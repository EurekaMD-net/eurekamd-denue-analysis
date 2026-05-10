# Source Evaluation — CNBV EACP Municipal (Financial Inclusion)

> ⚠️ **SUPERSEDED 2026-05-10** by [`scan-cnbv-panorama-2025.md`](./scan-cnbv-panorama-2025.md).
> The Panorama Anual 2025 file (full-year 2024 data, 76 cols, all 4 institution types,
> native UTF-8 + zero-padded cve_geo) replaces this 2022 EACP-only quarterly file.
> Ingestion proceeds against the Panorama, not this. Document retained for evaluation history.

> Probed: 2026-05-10 | Status: NEW candidate, not in fuentes-datos-gubernamentales.md
> Provided URL: http://datosabiertos.cnbv.gob.mx/Documentos/DGPASF/51Junio_2022/BD%20Uso%20EACP%20Mun.csv

## TL;DR

Fits the existing v0.2.x pattern. Adds a **financial inclusion** dimension that no other ingested source covers. ~270 KB, 2,463 municipios, 6 penetration rates + 6 absolute counts. Standard caveats (Latin-1, ~7-row gap vs canonical 2,471 INEGI municipios, key normalization). Recommend ingest at `v0.2.12-A` priority alongside the open Datatur work.

EACP-only is the main scope limit — covers Sofipos and SOCAPs (popular savings/credit), not commercial banks. Sibling `BD Uso BM Mun.csv` (Banca Múltiple) returns 0 bytes / 404 at the same path; would need direct portal lookup if commercial-bank coverage is wanted.

## File shape

| Property          | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| Bytes             | 270,328                                                  |
| Encoding          | ISO-8859-1 (`í`, `ó` as 0xED, 0xF3)                      |
| Line endings      | CRLF                                                     |
| Rows              | 2,465 (1 header + 2,464 data)                            |
| Columns           | 21                                                       |
| Quoted-field rows | 59 (municipios with embedded commas, e.g. `"Llano, El"`) |
| Catch-all row     | 1 (`99999, 99, NA, "Sin identificar"`)                   |

## Schema (21 columns)

```
Clave_Municipio        4-5 digit int — state*1000 + mun (NOT zero-padded)
Clave_Estado           1-32, 99
Region                 6 broad regions (Occidente y Bajío, etc.)
Estado                 32 + "Sin identificar"
Municipio              str (commas in 59 names → quoted)
Superficie_km2         int km²
Poblacion              int
Poblacion_adulta       int
Tipo_de_poblacion      Metrópoli | Semi-metrópoli | Urbano | Semi-urbano | En Transición | Rural | Sin identificar

# Per-10k-adults rates (6 cols, can be "NA"):
Cuentas_deposito_ahorro_10mil_adultos_EACP
Cuentas_deposito_a_la_vista_10mil_adultos_EACP
Cuentas_deposito_a_plazo_10mil_adultos_EACP
Tarjeta_debito_10mil_adultos_EACP
Cuentas_credito_al_consumo_10mil_adultos_EACP
Cuentas_credito_a_la_vivienda_10mil_adultos_EACP

# Absolute counts (6 cols):
Contratos_deposito_al_ahorro_EACP                    sum nat'l: 10,354,974 + 12,752 unmapped
Contratos_deposito_a_la_vista_EACP                            8,163,557 +    566,933 unmapped
Contratos_deposito_a_plazo_EACP                               1,689,287 +     13,780 unmapped
Contratos_tarjeta_debito_EACP                                   699,210 +          0 unmapped
Contratos_credito_al_consumo_EACP                             2,916,818 +     70,539 unmapped
Contratos_credito_a_la_vivienda_EACP                             34,408 +        729 unmapped
```

The `Sin identificar` row carries non-trivial volume (5.5% of `vista` contracts, 2.4% of `consumo`) — keep in raw, exclude from the muni-grain view.

## Tipo_de_poblacion distribution

| Tipo            | Rows | %     |
| --------------- | ---- | ----- |
| Semi-urbano     | 701  | 28.4% |
| Rural           | 660  | 26.8% |
| En Transición   | 612  | 24.8% |
| Urbano          | 349  | 14.2% |
| Semi-metrópoli  | 68   | 2.8%  |
| Metrópoli       | 14   | 0.6%  |
| Sin identificar | 1    | 0.0%  |
| (catch-all 99)  | 1    | 0.0%  |

## Join strategy → INEGI cve_geo

CNBV `Clave_Municipio` is `state*1000 + municipio_residual` without zero-padding. Transform on load:

```sql
LPAD(clave_estado::text, 2, '0') || LPAD((clave_municipio - clave_estado*1000)::text, 3, '0') AS cve_geo
```

Sample mapping:

```
1001  →  01001  Aguascalientes
3008  →  03008  Cabos, Los
30001 →  30001  Acajete (Veracruz)
```

CDMX has 16 rows (matches modern demarcaciones). 2,463 mapped municipios vs INEGI canonical 2,471 ≈ **99.7% join coverage**. The 7-row gap is likely municipios decretados after June 2022 (Aldama/Honduras Bajan in Chiapas etc.) — document but don't block.

## Existing-pipeline placement

Mirror the established loader pattern (e.g. `load-bienestar-padron.ts` from v0.2.11). Suggested layout:

```
raw/cnbv/eacp_uso_municipal_<periodo>.csv          # checked-in or .gitignored
src/db/schema.sql                                  # +cnbv_eacp_uso_municipal_raw table
src/db/views.sql                                   # +cnbv_eacp_municipal view (cve_geo derivation, NA→NULL, exclude estado=99)
scripts/load-cnbv-eacp.ts                          # iconv→UTF-8, csv-parse with quoted-field handling, \copy
src/api/handlers/analytics.ts                      # extend /analytics/municipio-detail with financial_inclusion: { eacp: {...} }
                                                   # OR new /analytics/financial-inclusion-by-municipio
tests/integration/load-cnbv-eacp.test.ts           # ~14 tests mirroring bienestar pattern
```

Predicted endpoint surface: extending `municipio-detail` keeps the tres-grain symmetry (entidad/muni/locality). A new endpoint is only justified if you also pull `BD Uso EACP Estado.csv` (entidad-level rollup) to round out the entity grain.

## Gotchas (load-time defenses)

1. **Encoding** — file is Latin-1, csv-parse will silently corrupt accented municipio names if not iconv'd first. Same Jalisco AGEB bug pattern (`feedback_inegi_view_patterns`). Add iconv to loader header before parsing.
2. **Quoted CSV** — 59 rows have `"Llano, El"`-style commas. Use `csv-parse` package, NOT split. Existing loaders already do this.
3. **NA sentinels** — 6 rate columns use literal `"NA"` for `Sin identificar` row; cast `NULLIF(col, 'NA')::numeric`.
4. **Decimal-as-string traps** — none observed (all numerics are int64, no `1851607.0`-style decimal-formatted ints like Bienestar).
5. **Estado=99 catch-all** — exclude from view, retain in raw. Same defense-in-depth as Bienestar's `cveent != 99`.
6. **Key normalization** — see Join strategy above. Document the `LPAD-LPAD` derivation in the view header.

## Freshness / cadence

CNBV publishes quarterly with sequential issue numbers under `/Documentos/DGPASF/<N><Mes>_<Year>/`. Confirmed live URLs:

- ✅ `51Junio_2022/` (the file the user gave)
- ✅ `52Septiembre_2022/`
- ❌ `53Diciembre_2022/` through `67`-ish — all 404 at this path

CNBV likely restructured the URL pattern post-2022. Need to crawl `https://www.cnbv.gob.mx/Paginas/PortafolioDeInformacion.aspx` (which 401s under WebFetch — TLS chain issue) or hit the catalog manually for the current path. **Recommend**: pull the latest issue at ingest time, not 2022-06; the 4-year staleness is a real freshness concern. Operator action: paste the current portal URL and we'll re-evaluate.

## Risk vs Datatur (the open v0.2.3-B item)

| Aspect          | CNBV EACP                                                                     | Datatur                                            |
| --------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| Granularity     | Municipal native                                                              | Destino → cve_mun crosswalk needed                 |
| Effort          | ~0.5 day (mirrors Bienestar pattern)                                          | ~1 day                                             |
| Join coverage   | ~99.7%                                                                        | ~50/70 direct + 20 calibradores                    |
| Dimension added | Financial inclusion (cooperative banking)                                     | Tourism intensity + seasonality                    |
| Freshness       | URL pattern unknown post-Sep-2022                                             | Live                                               |
| Strategic fit   | Complements CONEVAL pobreza + SINBA — adds money-flow lens to demand modeling | Specific to retail/turismo customers; less general |

**Recommendation**: ingest CNBV EACP **only after operator confirms the current URL pattern**. The June-2022 file is fine for a first pass / schema validation, but shipping a 4-year-stale municipal panel as a production endpoint is a footgun. Datatur stays the higher-priority deferred item because it's actively maintained.

## What this does NOT cover

- Banca Múltiple (commercial banks) — `BD Uso BM Mun.csv` returns 0 bytes at the parallel path. Would need a separate URL discovery pass.
- SOFOMs / SOCAPs broken out individually (this is the EACP rollup; member-level breakdown is in CNBV's separate institutional file series).
- Time series — file is a single-period snapshot. To trend, you'd need to ingest each quarterly issue 51, 52, ... and partition on `(cve_geo, periodo)`.
- POS / ATM coverage — `BD Inclusion EACP Mun.csv` (different file series) carries the supply-side count of branches/cajeros.

## Decision points for operator

1. **Scope**: ship as `v0.2.12-A` (single-period EACP snapshot, ~0.5d) OR wait for time-series + Banca Múltiple bundle (~2d, larger surface)?
2. **Freshness**: stay on Jun-2022 fixture for first ingest, or block on confirming the latest URL?
3. **Surface**: extend `/analytics/municipio-detail` with nested `financial_inclusion` field (preferred — preserves tres-grain symmetry), OR add new dedicated endpoint?
4. **Period column**: add `periodo TEXT` to raw table from day one even for single-period ingest, so future quarterly appends don't require a migration.

## Suggested commit shape if greenlit

```
feat(cnbv): EACP financial inclusion at municipal grain (v0.2.12-A)

- Loader: scripts/load-cnbv-eacp.ts (Latin-1→UTF-8, csv-parse, NA→NULL,
  cve_geo from LPAD(estado,2)||LPAD(mun_residual,3))
- Raw: cnbv_eacp_uso_municipal_raw (21 cols + periodo + ingested_at)
- View: cnbv_eacp_municipal (filters estado=99, casts NA→NULL,
  derives cve_geo)
- Endpoint: /analytics/municipio-detail extended with
  financial_inclusion: { eacp: { rates: {...6}, contratos: {...6},
                                  tipo_poblacion } }
- Tests: tests/integration/load-cnbv-eacp.test.ts (~14 specs mirroring
  load-bienestar-padron pattern), analytics.test.ts +6 specs
```
