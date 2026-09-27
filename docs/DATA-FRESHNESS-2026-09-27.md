# Data freshness recon, 2026-09-27

Read-only recon of every loaded dataset against its original publisher, run
after the audit refactor landed (main `65263e5`). Three parallel agents, one
per source family; DB queries under `default_transaction_read_only=on`; no
downloads (HEAD and byte-range probes only). Verified by the orchestrator:
the OSM finding (section 3) was re-checked directly.

## 1. Summary

| Priority | Dataset | Loaded | Available now | Action |
| --- | --- | --- | --- | --- |
| P0 | OSM road aggregates | **table absent** (README says shipped 05-24) | Geofabrik 2026-09-27 (646 MB) | Investigate the failed May load; retry from the local May PBF first (no download) |
| P1 | SESNSP incidencia | through 2026-03 | enero–agosto 2026 (published 09-18, SharePoint) | Manual browser download, rename, re-run loader |
| P1 | CLUES | 2026-04 | 2026-08 (26.5 MB xlsx, 09-23) | xlsx→csv, re-run loader |
| P1 | COFEPRIS farmacias | PDF 1020177 (licences to 2025-07) | PDF 1079227 dated 2026-05-15 | PDF→csv, geocode, loader; fix URL in loader header |
| P2 | SEDATU financiamientos | 2025 full year | `Financiamientos_2026.csv` ene–jun (9.9 MB) | Parametrise the year-locked loader, add 2026 alongside 2025 |
| P2 | CNBV crédito vivienda | 2025 full year | `CNBV_2026.csv` ene–jun (3.4 MB) | Same as SEDATU (same `_2025` hardcoding) |
| P2 | Encuesta Intercensal 2025 | not loaded (new) | released 2026-09-22, state + municipio | New loader; 2,478 municipios vs 2,469 keys |
| P3 | DENUE | 11/2025 (inferred from `created_at`) | 05/2026; **11/2026 due 2026-11-25** | One API re-extract after 11-25 covers both |
| P3 | Aeropuertos | March-of-year 2006–2026 | AFAC through July 2026 | Semantics decision first (March-only pivot) |
| P3 | Marco Geoestadístico | MG 2020 | MG 2025 (2.9 GB, 2025-12-15; 2,478 municipios) | Load alongside 2020, not replace; key bridge needed |
| watch | EDR defunciones | 2024 definitive | 2025 preliminary (Aug 2026); definitive ~Nov 2026 | `--append` 2025 when the open-data zip appears |
| watch | ENOE | 2025 Q1–Q4 | 2026 Q2 | Wait for full-year 2026 (~Feb 2027) |
| watch | CNBV Panorama | 2025 edition (data 2024) | 2026 edition not published | Re-check ~Dec 2026 |
| watch | CONEVAL pobreza / IRS municipal | 2020 | INEGI now owns it; municipal 2025 follows EIC 2025 (~2027) | New source, new schema |
| current | CE 2024 | definitive (2025-07-24) | same | Next census CE 2029 |
| current | Censo 2020 ITER + AGEB | CPV 2020 | files unchanged since 2021/2022 | Nothing |
| current | ENIGH | 2024 | 2024 (2026 fieldwork started Aug 2026, results ~Jul 2027) | Nothing |
| current | SINBA EC | 2023 | DA_EC_SIS_2023 still newest (2024/2025 zips 404) | Nothing |
| current | Bienestar padrón | 2019Q1–2024Q3 | same file (114,046 bytes) | Nothing; dataset stalled |
| current | SICT datos viales | 2024 TDPA | DV2025 edition carries 2024 counts; repodatos WAF blocks curl | Nothing; check in a browser |
| current | GRS por AGEB | 2020 | none expected (census-year product) | Nothing |

## 2. Data-quality findings surfaced by the recon (not fixed)

- `mv_mortalidad_municipal_yearly` contains `ano = 9999`: the EDR sentinel
  for "año no especificado" passes the `^[0-9]{4}$` filter (332 raw rows,
  55 MV rows). The analytics handlers fence it (`ano <= current year`,
  BETWEEN 2010 AND 2039), but Sage SQL over the MV can pick it up.
  Fix: `AND anio_ocur <> '9999'` in `scripts/perf-matviews.sql`.
- The same MV mixes occurrence years from one registration-year file:
  years before 2024 only hold late-registration tails.
- DENUE edition is not recorded anywhere: `fecha_alta` is empty on all rows
  (the API does not return it). Vintage can only be inferred from
  `created_at`. Consider a `dataset_versions` ledger table.
- `docs/v0.2-status.md:99` says CLUES is the "ENERO 2026" cut; the data
  carries movements to 2026-04-21.
- `scripts/backfill-ageb.ts` points to `docs/loading-marco-geoestadistico.md`,
  which does not exist; the polygons have no loader script.
- Link rot: coneval.org.mx GRS zip serves HTML; gob.mx attachments and
  SICT repodatos refuse curl; INEGI open-data URLs return a 2,263-byte
  decoy with HTTP 200 for missing files (check Content-Length, not status).
- SNIIV has a JSON API that returns the alfresco file URL:
  `https://sniiv.sedatu.gob.mx/api/ReporteAPI/GetDocumentoAnio/{tipo}/{anio}/{fmt}`
  (tipo 2 = financiamientos, 7 = CNBV; fmt 1 = csv). Removes the manual
  node-id hunt.

## 3. OSM layer: absent in production

- No relation matching `%osm%` exists in `postgres`. No API handler reads
  road metrics; only the loader and migration 002 (grants, "optional")
  reference `osm_ageb_aggregates`. The README (line 41) and the project
  memory both say it shipped 2026-05-24 with a weekly refresh; no
  `osm-refresh.timer` is installed.
- `raw/osm/` still holds the May 24 intermediates (`mexico-latest.osm.pbf`
  626 MB, `mexico-roads.osm.pbf` 364 MB, `mexico-roads.geojsonseq` 1.8 GB),
  which the pipeline deletes only after a successful load. The load most
  likely failed after the export step.
- Retry path without any download: run `scripts/load-osm-ageb.ts` against
  the existing `raw/osm/mexico-roads.geojsonseq`; find out why the May load
  failed first. A fresh Geofabrik pull (646 MB) needs operator approval
  under the bulk-transfer rule.

## 4. Suggested order

1. OSM: diagnose + retry from local files (no download).
2. SESNSP ene–ago 2026, CLUES 2026-08, COFEPRIS 2026-05: three loader
   re-runs with manual pre-steps; no code change except the COFEPRIS URL.
3. Parametrise the SEDATU and CNBV loaders by year; load 2026 H1 next to
   2025 (analytics views need a year dimension or a "latest" convention).
4. EIC 2025 municipal layer (new loader; decide the 2,478→2,469 key bridge
   together with the MG 2025 question).
5. After 2026-11-25: DENUE 11/2026 re-extract (hours of API paging);
   after ~Nov 2026: EDR 2025 definitive with `--append` + MV refresh.
6. Aeropuertos: rule on March-only vs latest-month semantics, then reload.
