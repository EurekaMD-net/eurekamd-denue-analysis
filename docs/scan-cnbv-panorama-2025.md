# Source Evaluation — CNBV Panorama Anual de Inclusión Financiera 2025

> Probed: 2026-05-10 | Status: NEW candidate, **supersedes** the 2022 EACP scan
> File: `Anexo_Panorama_2025.xlsx` (3.0 MB, modified 2026-04-28)
> Owner: peter.blades@gmail.com (Drive ID `1Oy_RQ3yy2VdJ6IaNb-GNADLMAW3Ld1RX`)

## TL;DR

This is the **right file** to ingest, and it deprecates the 2022 EACP file we evaluated yesterday. It's CNBV's flagship comprehensive annual inclusion report covering full-year 2024, with a `Detalle por municipio` annex of **2,472 municipios × 76 columns** spanning four institution types, six product families, gender breakdowns, and remittances. UTF-8 native (XLSX), zero-padded canonical cve_geo, near-complete INEGI coverage (99.96%). Recommend ingest as **v0.2.12-A**.

Replaces (a) the 2022 EACP file and (b) closes the freshness concern raised in `scan-cnbv-eacp.md`.

## Workbook layout (20 sheets)

| #    | Sheet                                                                                                                                                                                       | Rows × Cols    | Status                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------- |
| 0    | Contenido                                                                                                                                                                                   | 37 × 9         | TOC, skip                                                      |
| 1    | Indicadores                                                                                                                                                                                 | 152 × 8        | National rollup, useful for `Indicadores` panel later          |
| 2-15 | Sucursales / Corresponsales / Cajeros / TPV / Captación / Financiamiento / Ahorro retiro / Seguros / Medios Pago / Remesas / CONDUSEF / Reclamaciones BM / Ahorro bancario / Brechas Género | varies         | National + estado breakouts per product, narrower scope; defer |
| 16   | **Anexo-Estado**                                                                                                                                                                            | 41 × 73        | **Phase 2** — extends `/analytics/entidad-detail`              |
| 17   | Anexo-Institucion                                                                                                                                                                           | 251 × 36       | Per-institution view; not relevant to muni grain               |
| 18   | **Detalle por municipio**                                                                                                                                                                   | **2,480 × 76** | **Phase 1 — primary ingest target**                            |
| 19   | Anexo-Marzo 2025                                                                                                                                                                            | 24 × 5         | H1 2024 update note, ignore                                    |

## Detalle por municipio — schema (76 columns)

```
Identifiers (5):
  1. Clave Municipio (número)         int, e.g. 1001
  2. Clave Municipio (texto)          str, '01001' ← canonical INEGI cve_geo
  3. Estado                            str
  4. Municipio                         str
  5. Estado y municipio                str (display label)

Demographics (3, pre-joined from Censo 2020 + CONEVAL):
  6. Población*                        int (Censo 2020 — ALSO in our censo_municipios view)
  7. Población adulta*                 int
  8. Rezago social                     ordinal {Muy bajo, Bajo, Medio, Alto, Muy alto, No identificado}
                                       (ALSO in our coneval_irs_muni — verify alignment)

Infrastructure — by institution × type (21):
  9-13.  Sucursales            ×{BM, BD, SOCAP, SOFIPO, Total}
  14.    Corresponsales        Máximos (CNBV uses max-across-quarters convention)
  15-19. Cajeros automáticos   ×{BM, BD, SOCAP, SOFIPO, Total}
  20-28. Terminales punto venta ×{BM, BD, SOCAP, SOFIPO, Total banca y eacp,
                                  Agregadores, Adquirentes no bancarios, Total ag/adq, Total}
  29.    Al menos un punto de acceso (Suc + Cor + ATM)

Products — flow/stock counts (15):
  30-34. Cuentas    ×{BM, BD, SOCAP, SOFIPO, Total}
  35-39. Créditos   ×{BM, BD, SOCAP, SOFIPO, Total}
  40-44. Medios de pago - transacciones en TPV ×{BM, BD, SOCAP, SOFIPO, Total}

Remesas (2):
  45. Millones de dólares (anual 2024)
  46. Ingreso por remesas por persona (USD/persona)

Gender brechas — Cuentas (15):
  47-61. Mujeres / Hombres / Brecha for {BM, BD, SOCAP, SOFIPO, Total}

Gender brechas — Créditos (15):
  62-76. Mujeres / Hombres / Brecha for {BM, BD, SOCAP, SOFIPO, Total}
```

Where institution-type abbreviations:

- **BM** = Banca Múltiple (commercial banks)
- **BD** = Banca de Desarrollo (e.g. Bancomext, Nafin)
- **SOCAP** = Sociedades Cooperativas de Ahorro y Préstamo
- **SOFIPO** = Sociedades Financieras Populares

**This covers everything the 2022 EACP file covered (SOCAP + SOFIPO = EACP) plus Banca Múltiple, Banca de Desarrollo, infrastructure (sucursales/corresponsales/ATMs/TPVs), and gender breakdowns.**

## Coverage statistics (from raw scan)

```
Total rows in sheet:                2,480 (incl. header rows 1-4 + 3 footer note rows + blanks)
Data rows:                          2,473 (incl. 1 catch-all "99999 No identificado")
Real municipios with cve_geo:       2,472
Distinct cve_geos:                  2,469 (some rows share — likely concatenation artifact)
Coverage vs INEGI canonical 2,471:  ~99.96%

Rezago social distribution (matches CONEVAL):
  Muy bajo:     677
  Bajo:         893
  Medio:        504
  Alto:         243
  Muy alto:     152
  No identificado: 1

Coverage by indicator (# munis > 0 of 2,469 with data):
  Sucursales (any institution):  2,009 (81.4%)
  Corresponsales:                2,021 (81.8%)
  Cajeros automáticos:           2,051 (83.1%)
  TPV (any kind):                2,332 (94.4%)
  Al menos un punto de acceso:   2,214 (89.7%)  ← matches "89.7% cobertura" headline
  Cuentas (any institution):     2,467 (99.9%)
  Créditos (any institution):    2,468 (100%)
  Remesas > 0:                   1,938 (78.5%)

Gender brecha -999 sentinel rate: 9,146 / 24,690 cells (37.0% — n<100 floor)
```

## Why this supersedes `scan-cnbv-eacp.md`

| Aspect         | 2022 EACP file                               | 2025 Panorama (this)                                         |
| -------------- | -------------------------------------------- | ------------------------------------------------------------ |
| Cadence        | Quarterly (issue 51 = Jun 2022)              | Annual (Panorama 2025 = full-year 2024)                      |
| Freshness      | 2022Q2 (~4 yr stale)                         | 2024 close (~1 yr stale) ✓                                   |
| Scope          | EACP only (SOCAP + SOFIPO)                   | All 4 institution types (BM + BD + SOCAP + SOFIPO) ✓         |
| Surface        | 6 rates + 6 contracts                        | Infrastructure (5 types) + Products (3) + Remesas + Gender ✓ |
| Format         | CSV                                          | XLSX (multi-sheet, also has estado + institución + nat'l) ✓  |
| Encoding       | Latin-1 (iconv needed)                       | UTF-8 native (XLSX = XML) ✓                                  |
| Cve_geo        | `state*1000 + mun_residual` (need LPAD-LPAD) | Native zero-padded `'01001'` ✓                               |
| INEGI coverage | 2,463 / 2,471 (99.7%)                        | 2,472 / 2,471 (99.96%) ✓                                     |
| Sentinels      | `"NA"`, estado=99                            | `99999/"No identificado"`, brecha `-999` (n<100), notes rows |
| Demographics   | Población adulta only                        | Población + adulta + rezago_social ✓                         |

The 2022 file should not be ingested. This Panorama is the canonical CNBV inclusion source. **Recommend renaming `scan-cnbv-eacp.md` → `scan-cnbv-eacp.md.superseded` or appending a notice block pointing here.**

## Load-time defenses

1. **Skip footer rows** — rows ≥ 2478 are notes (`'Nota: ...'`, `'* La población ...'`, `'** En caso de que ...'`). Row 1 = title, rows 2-3 = section banners + `Totales`, row 4 = column headers, data starts at row 5.
2. **Catch-all row** — exclude `clave_num = 99999` from view (same defense-in-depth pattern as Bienestar `cveent != 99`).
3. **Brecha -999 sentinel** — replace with `NULL` (or carry as-is and document the n<100 statistical-validity floor). Per CNBV note: "En caso de que el número de créditos o cuentas sume menos de 100, la brecha se consideró como -999, para indicar 'no aplica'." 37% of brecha cells affected.

   **Brecha formula** (verified empirically against the live data, NOT stated by CNBV in the file): `brecha = (hombres − mujeres) / (hombres + mujeres) × 100` — a percentage-point delta in the symmetric-difference convention, range approximately [-100, +100]. Sign convention: **positive = men-favored** (more men than women), **negative = women-favored**. Live observation 2026-05-10: `g_cuentas_total_b` ranges -88.13 to +92.75 (mean -19.18, mostly women-favored at the cuentas grain); `g_creditos_total_b` ranges -44.87 to +60.20 (mean -6.47, also women-favored on aggregate but less skewed). This is a percentage-point delta, NOT a [-1, +1] ratio — surfaced via round-2 audit (R9) when the original mock test values used the wrong scale.

4. **Censo 2020 vs 2024 population reconciliation** — `Población*` here uses Censo 2020 (frozen). Our `censo_municipios` view also uses Censo 2020. Verify they match within ε; if not, prefer ours (we have higher fidelity per v0.2.10's wider variable surface) and treat CNBV's as a sanity-check column only.
5. **Rezago social ordinal** — same 5-level taxonomy as CONEVAL; verify alignment with our `coneval_irs_muni` table to detect any classification drift.
6. **Cve_geo dedup** — 3 rows-without-distinct-cve_geo to investigate during loader QA. Likely caused by Censo-2020 muni splits/merges.
7. **Anexo-Estado headers are 2-row stacked** (row 3 = numeric IDs, row 4 = text). Different parsing path than Detalle. Defer to Phase 2.

## Suggested ingest plan (v0.2.12-A)

```
raw/cnbv/Anexo_Panorama_2025.xlsx                      # checked-in (3MB) or .gitignored
src/db/schema.sql                                       # +cnbv_panorama_2025_municipal_raw table (76 cols + ingested_at)
src/db/views.sql                                        # +cnbv_panorama_municipal view (
                                                        #   filters clave_num = 99999,
                                                        #   NULLIF brecha cols on -999,
                                                        #   exposes infraestructura/productos/remesas/género as nested groups)
scripts/load-cnbv-panorama.ts                           # openpyxl-style xlsx parser (Python script invoked via tsx exec)
                                                        # OR exceljs (JS-native) — exceljs already used by ENIGH loader
src/api/handlers/analytics.ts                          # extend /analytics/municipio-detail with
                                                        #   inclusion_financiera: {
                                                        #     infraestructura: { sucursales, corresponsales, cajeros, tpv, puntos_acceso },
                                                        #     productos: { cuentas, creditos, transacciones_tpv },
                                                        #     remesas: { mdd_anual, ingreso_per_capita },
                                                        #     genero: { brecha_cuentas, brecha_creditos }
                                                        #   }
tests/integration/load-cnbv-panorama.test.ts            # ~16 tests mirroring load-bienestar-padron pattern
```

Endpoint surface decision: **extend `municipio-detail`** (preferred — preserves the tres-grain symmetry from v0.2.10). A new `/analytics/financial-inclusion-by-municipio` only justifies itself if you add filtered/ranked queries (e.g. "top 50 munis by cobertura desierta de TPV") — defer.

## Phase 2 — Anexo-Estado (entidad enrichment)

41 rows × 73 cols, 33 entidades = nat'l + 32 estados. Stacked 2-row header (row 3 = numeric IDs that match the `idconcepto` numbers from BIE-style tagging; row 4 = text labels). Maps cleanly to `/analytics/entidad-detail` via the same column families as Detalle. Defer to v0.2.12-B.

Estimated total effort: **0.75 day** for both (Phase 1 muni: 0.5d, Phase 2 estado: 0.25d).

## Implementation notes

- `exceljs` is already in the project (used by `load-enigh-2024.ts` and `load-enoe-2025.ts` for trimestre data). Reuse rather than introduce openpyxl.
- Loader pattern: read sheet → header row 4 → enumerate cols → INSERT INTO raw with one named param per col (76 cols) OR pivot to long-form `(cve_geo, institucion, indicador, valor)` and store narrow.
  - **Wide preferred** for query speed at endpoint time.
  - **Long preferred** for schema flexibility if Panorama 2026 changes columns.
  - Recommendation: **wide raw + long-friendly view** — same pattern as `bienestar_padron_estatal_trimestral_raw` + `bienestar_estatal_trimestral` view.
- `Periodo` column should be added to the raw table from day-one (`'2024-anual'` or `'panorama-2025'`) so future annual issues can append cleanly.

## Decision points for operator

1. **Confirm v0.2.12-A scope**: Phase 1 (muni) only, or Phase 1 + Phase 2 (muni + estado-anexo) bundled?
2. **Wide vs long storage**: keep raw as wide 76-col table (recommended for query speed), or pivot to long form on load?
3. **Source-eval doc cleanup**: I'll add a banner to `scan-cnbv-eacp.md` pointing here unless you object.
4. **Replace prior recommendation**: `next-sessions-queue.md` doesn't have CNBV listed yet (only Datatur is open). Should v0.2.12-A go in queue, and at what priority vs Datatur?
