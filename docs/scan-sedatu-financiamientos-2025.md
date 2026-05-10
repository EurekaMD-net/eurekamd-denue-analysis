# Source Evaluation — SEDATU SNIIV Financiamientos a la Vivienda 2025

**URL:** `https://sistemas.sedatu.gob.mx/repositorio/proxy/alfresco-noauth/api/internal/shared/node/BOZvuxwVRmy62_qG966obQ/content/financiamientos_2025.csv?a=true`
**Codebook:** `https://sistemas.sedatu.gob.mx/repositorio/proxy/alfresco-noauth/api/internal/shared/node/NGC6R5CLQ6SCexmbnOq4ZA/content/diccionario_financiamiento.xlsx?&a=true`
**Publisher:** Secretaría de Desarrollo Agrario, Territorial y Urbano (SEDATU) — Sistema Nacional de Información e Indicadores de Vivienda (SNIIV).
**Aggregator:** Datos provienen de los Organismos Nacionales de Vivienda + CNBV.
**Period:** Enero–diciembre 2025 (12 months, fully reported as of 2026-05).
**Size:** ~21 MB / 325,649 raw rows / 16 columns.
**Encoding:** ISO-8859-1 (NOT UTF-8). `año` arrives as `a\xf1o`; pre-pass with `iconv -f ISO-8859-1 -t UTF-8`.

## What this is

SEDATU's authoritative annual census of every housing financing event in Mexico — broken down by lending organism (INFONAVIT / FOVISSSTE / CNBV banca / SHF / CONAVI / state institutos / military banks), modality (new build / used / improvement / other), destination (18 codes covering acquisition, payoff, reconstruction, leasing, urbanization, etc.), borrower demographics (sex, age, income decile in UMAs, housing-value tier).

Each row aggregates `(año, mes, cve_ent, cve_mun, organismo, modalidad, destino, tipo, sexo, edad_rango, ingresos_rango, vivienda_valor)` to `(acciones, monto)`. So a "row" is a **stratum-month-muni count + peso volume**, not a single loan.

Adds a **housing-credit flow dimension** to DENUE muni analytics that no current source covers. CNBV Panorama (v0.2.12) measures financial-inclusion infrastructure (sucursales, cajeros, cuentas) but treats credit as a single number; SEDATU breaks credit down by purpose, organism, and recipient demographics. A muni with high CNBV `creditos_total` but zero SEDATU `vivienda nueva` activity has a different commercial profile than a muni where most credit flows to new builds.

## Schema (raw, 16 cols)

| Col              | Type                          | Codebook                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `año`            | int (year)                    | `2025`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mes`            | int 1-12                      | month                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cve_ent`        | text 2-char                   | INEGI `01..32`. Empty = "No distribuido" national-roll (11 rows, $0 monto).                                                                                                                                                                                                                                                                                                                                 |
| `entidad`        | text                          | name                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cve_mun`        | text **1-3 char (variable!)** | INEGI muni-within-entidad code, NOT zero-padded. `'1'`, `'15'`, `'150'` all appear. Empty = state-level "No distribuido" (384 rows). Must `LPAD(cve_mun, 3, '0')` then concat with `cve_ent` for INEGI 5-char join.                                                                                                                                                                                         |
| `municipio`      | text                          | name                                                                                                                                                                                                                                                                                                                                                                                                        |
| `organismo`      | int 1-26                      | 1=INFONAVIT (66% of rows), 2=CNBV banca múltiple, 3=FOVISSSTE, 4=SHF, 5=CONAVI, 6=INVI CDMX, 7=Banjercito, 8=Hábitat México, 9=CFE, 10=ISSFAM, 11=PEMEX, 12=FONHAPO, 13-26=state housing institutos (INVI MX state, INFOVIR, INVIVIENDA, COVEG, etc.)                                                                                                                                                       |
| `modalidad`      | int 1-4                       | 1=Vivienda nueva, 2=Mejoramientos, 3=Vivienda usada, 4=Otros programas                                                                                                                                                                                                                                                                                                                                      |
| `destino`        | int 1-18                      | 1=Mejoramientos, 2=Vivienda nueva, 3=Vivienda usada, 4=Pago de pasivos, 5=Con disponibilidad de terreno, 6=Liquidez, 7=Adquisición de suelo, 8=Reconstrucción, 9=Ampliación, 10=Autoproducción, 11=Arrendamiento, 12=Insumos para vivienda, 13=Urbanización, 14=Lotes con servicios, 15=Garantías, 16=Programas institucionales, 17=Contragarantías, 18=Regularización (added 2022). Empty=No especificado. |
| `tipo`           | int 1-2                       | 1=Crédito individual, 2=Cofinanciamientos y subsidios. Empty=No disponible (14 rows).                                                                                                                                                                                                                                                                                                                       |
| `sexo`           | int 1-2                       | 1=Hombre, 2=Mujer. Empty=No disponible (399 rows ≈ 0.1%).                                                                                                                                                                                                                                                                                                                                                   |
| `edad_rango`     | int 1-3                       | 1=29 o menos, 2=30-59, 3=60+. Empty=No especificado (6,552 rows ≈ 2%).                                                                                                                                                                                                                                                                                                                                      |
| `ingresos_rango` | int 1-6                       | UMAs/mes. 1=≤2.6, 2=2.61-4, 3=4.01-6, 4=6.01-9, 5=9.01-12, 6=>12. Empty=No especificado (6,299 rows).                                                                                                                                                                                                                                                                                                       |
| `vivienda_valor` | int 1-6                       | 1=Económica (40m², 118 UMAs), 2=Popular (50m², 118-200 UMAs), 3=Tradicional (71m², 200-350 UMAs), 4=Media (102m², 350-750 UMAs), 5=Residencial (156m², 750-1500 UMAs), 6=Residencial plus (>156m², >1500 UMAs). Empty=No especificado (71,623 rows ≈ 22%).                                                                                                                                                  |
| `acciones`       | numeric (count)               | 0–2,278 per row. Total 998,745 nationally in 2025.                                                                                                                                                                                                                                                                                                                                                          |
| `monto`          | numeric (MXN)                 | 0–224M per row. Total $617B MXN nationally.                                                                                                                                                                                                                                                                                                                                                                 |

## Data-quality gotchas

1. **Variable-length cve_mun.** The codebook says "Texto 3 char" but the published CSV ships values as decimal-formatted ints stripped of leading zeros: `'1'` for muni 001 (Aguascalientes capital), `'15'` for 015, `'150'` for 150. Loader must `LPAD(cve_mun, 3, '0')` BEFORE concat. INEGI 5-char `cve_mun_full = cve_ent || LPAD(cve_mun, 3, '0')`.
2. **ISO-8859-1 encoding.** Raw bytes contain `0xf1` (`ñ`) and `0xe9` (`é`). `\copy ... FROM STDIN` with default UTF-8 server will silently corrupt these. Pre-pass: `iconv -f ISO-8859-1 -t UTF-8 in.csv > out.csv`. Same posture as `feedback_inegi_resaguebrub_jalisco_encoding`.
3. **"No distribuido" catch-all rows.** 11 rows with both `cve_ent` and `cve_mun` empty (national catch-all, $0 monto), 384 rows with valid `cve_ent` but empty `cve_mun` (state-level "No distribuido" — small program rolls that couldn't attribute to a specific muni, ~$700M total). View filters via `WHERE NULLIF(cve_ent, '') IS NOT NULL AND NULLIF(cve_mun, '') IS NOT NULL` — kept in raw for forensics.
4. **22% suppression on `vivienda_valor`.** Largest gap. Combined CNBV + state-instituto programs that don't classify housing tier. Surface as NULL — do NOT impute.
5. **No code labels in data.** Categorical IDs (`organismo=1`, `modalidad=3`) ship without labels. Loader pre-loads 4 lookup tables (`sedatu_organismos`, `sedatu_modalidades`, `sedatu_destinos`, `sedatu_vivienda_tiers`) hardcoded from the codebook XLSX — joined at view layer to surface human-readable names.

## Grain & DENUE fit

**Native grain:** stratum-month per (cve_ent, cve_mun, organismo, modalidad, destino, tipo, sexo, edad_rango, ingresos_rango, vivienda_valor).
**DENUE-target grain:** muni (5-char `cve_mun`).
**Bridge:** **direct join** via `cve_mun_full = cve_ent || LPAD(cve_mun, 3, '0')` — no spatial computation needed (contrast with v0.2.13 SICT). Mirror of CNBV Panorama / CONEVAL / SESNSP pattern.

**Coverage (live, post-load 2026-05-10):** 325,649 raw rows → 325,254 muni-attributed (99.9%) → **1,848 distinct munis (~75% of 2,469 nationally)**. Stronger than SICT (1,153 munis); housing finance reaches more than federal highways do. Munis without coverage: small remote munis where INFONAVIT/FOVISSSTE/state institutos placed zero loans in 2025.

## Aggregation strategy (`sedatu_financing_by_municipio`)

Per `cve_mun`:

- `acciones_total` — sum of all financings (count)
- `monto_total` — sum peso volume
- `monto_per_accion_avg` — `monto_total / NULLIF(acciones_total, 0)` (mean loan size)
- `top_organismo` — modal lender (organismo with most acciones), human-readable label
- `top_organismo_share` — % of muni acciones from the top organism
- Modality breakdown (% of acciones):
  - `pct_vivienda_nueva` (modalidad=1)
  - `pct_mejoramientos` (modalidad=2)
  - `pct_vivienda_usada` (modalidad=3)
  - `pct_otros` (modalidad=4)
- `pct_femenino` — % acciones with sexo=2 (excluding No-disponible)
- `pct_credito_individual` — % acciones with tipo=1 (vs cofinancing+subsidies)
- Housing-tier composition (% of acciones excluding No-especificado):
  - `pct_economica`, `pct_popular`, `pct_tradicional`, `pct_media`, `pct_residencial`, `pct_residencial_plus`

**Why not break out by organismo individually?** 26 organismo codes × 2,469 munis = 64k cells. Most cells are zero. We surface the modal lender + share — sufficient signal for muni-level analytics. Consumers needing per-organismo detail can query the underlying view directly.

## Materialization

`sedatu_financing_by_municipio` as MATERIALIZED VIEW with btree on `cve_mun`. Same posture as v0.2.13 SICT. The aggregation is GROUP BY over 325k rows × 8 dimension breakouts; ~hundreds of ms recomputed. Materializing once + indexing makes the analytics-handler JOIN O(log n).

## Endpoint integration

`MunicipioDetailResult.vivienda_financiamientos: ViviendaFinanciamientosResult | null`:

```ts
interface ViviendaFinanciamientosResult {
  acciones_total: number;
  monto_total: number; // MXN
  monto_per_accion_avg: number; // MXN
  top_organismo: { code: number; nombre: string; share: number };
  modalidad: {
    pct_vivienda_nueva: number;
    pct_mejoramientos: number;
    pct_vivienda_usada: number;
    pct_otros: number;
  };
  demografico: {
    pct_femenino: number | null;
    pct_credito_individual: number | null;
  };
  vivienda_tier: {
    pct_economica: number | null;
    pct_popular: number | null;
    pct_tradicional: number | null;
    pct_media: number | null;
    pct_residencial: number | null;
    pct_residencial_plus: number | null;
  } | null; // null when 100% of muni rows have empty vivienda_valor
  periodo: string; // "2025"
}
```

Estado-grain rollup (`EntidadDetailResult.vivienda_financiamientos`) deferred to v0.2.15 — needs separate `sedatu_financing_by_entidad` aggregation.

## Verification queries

```sql
-- Sanity: total acciones + monto match published national totals
SELECT
  SUM(acciones_total) AS total_acciones,
  SUM(monto_total) AS total_monto_mxn,
  COUNT(*) AS muni_count
FROM sedatu_financing_by_municipio;
-- Expected: ~998k acciones, ~$617B MXN, ~1,848 munis

-- Top-10 munis by housing finance volume
SELECT cve_mun, acciones_total, monto_total / 1e9 AS monto_b_mxn,
       top_organismo, pct_vivienda_nueva
FROM sedatu_financing_by_municipio
ORDER BY monto_total DESC LIMIT 10;

-- Modality % composition sums to ~100 (rounding noise allowed)
SELECT cve_mun,
       pct_vivienda_nueva + pct_mejoramientos + pct_vivienda_usada + pct_otros AS sum_pct
FROM sedatu_financing_by_municipio
ORDER BY sum_pct LIMIT 5;
```

## v0.2.14 commit checkpoint

Single commit bundle:

- `scripts/load-sedatu-financiamientos.ts` (raw + 4 lookup tables + view + MV in one atomic transaction)
- `scripts/load-sedatu-financiamientos.test.ts` (unit tests + DDL drift guards)
- `src/api/types.ts` (ViviendaFinanciamientosResult interface)
- `src/api/handlers/analytics.ts` (LEFT JOIN, marshaller, lookup join)
- `src/api/handlers/analytics.test.ts` (subtree assertions, NULL fallback, modality-sum invariant)
- `scripts/refresh-matviews.sh` (extended with sedatu_financing_by_municipio)
- `docs/v0.2-status.md` (v0.2.14 entry)

After: Datatur (v0.2.3-B) remains the sole open data layer.
