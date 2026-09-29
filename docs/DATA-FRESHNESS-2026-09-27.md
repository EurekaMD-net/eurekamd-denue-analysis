# Data freshness recon, 2026-09-27

Read-only recon of every loaded dataset against its original publisher, run
after the audit refactor landed (main `65263e5`). Three parallel agents, one
per source family; DB queries under `default_transaction_read_only=on`; no
downloads (HEAD and byte-range probes only). Verified by the orchestrator:
the OSM finding (section 3) was re-checked directly.

## 1. Summary

| Priority | Dataset | Loaded | Available now | Action |
| --- | --- | --- | --- | --- |
| ~~P0~~ DONE 09-28 | OSM road aggregates | **reloaded 2026-09-28 from the local May 24 extract** (81,451 AGEBs; the table had been absent) | Geofabrik 2026-09-27 (646 MB) | The May load had succeeded; most likely the May 24 integration test dropped it 8 min later (unqualified `DROP` under a scratch `search_path`, see section 3; fixed 09-28). A fresh Geofabrik pull still needs operator approval |
| ~~P1~~ done 09-28 | SESNSP incidencia | 2015–2026 ago (33,045,048 long-form rows; loaded 2026-09-28 21:5x UTC) | enero–agosto 2026 (published 09-18, SharePoint) | Loaded 2026-09-28 after a loader change (`842dbfb`: per-input encoding detection, month cutoff from the ZIP name). Next drop: browser download, save under the canonical name, run the loader (grants restored by the loader since 09-29). Delitos municipal link (resolved 09-28; anonymous fetch redirects to a Microsoft login, so browser only): `https://sspcgob-my.sharepoint.com/:u:/g/personal/cni_sspc_gob_mx/IQAUYyl5NobOT4SHGj0O54aJATRtcR7qsQmNHWj_EOOzP-M?e=Eb940N` → save as `raw/sesnsp/RNID-Delitos_Municipal-2026-ago2026.zip` |
| ~~P1~~ done 09-28 | CLUES | 2026-08 (64,450 raw / 41,530 EN OPERACION; loaded 2026-09-28 22:1x UTC) | 2026-08 (26.5 MB xlsx, 09-23) | `gobi.salud.gob.mx/gobi/catalogos/catalogosmaestros/ESTABLECIMIENTO_SALUD_YYYYMM.xlsx` downloads with plain curl (no gate). `scripts/clues-xlsx-to-csv.py --xlsx= --out=` → `load-clues.ts --csv=` (grants restored by the loader since 09-29). Source quirk (not fixed): 2 EN OPERACION rows carry a positive longitude (DFSMP013962, TCSMP000191) and land in Asia; `clave_nivel_atencion` 6 = NO APLICA (4,561 rows). |
| ~~P1~~ done 09-28 | COFEPRIS farmacias | PDF 1079227 (3,066 licences, 2,866 Vigente, to 2026-04-27; loaded 2026-09-28 22:49 UTC) | PDF 1079227 dated 2026-05-15 | `gob.mx/cms/uploads/attachment/file/1079227/...pdf` downloads with plain curl (superseded editions 404: keep each PDF under `raw/cofepris/`). Needed a code change (`145aa3b`): the 2026-05 edition appends 3 constancia columns (17-col rows) and prints dates as `d-mmm.-yy`; the parser now checks the header on every page, validates dates, canonicalizes `estatus` case, fixes CPs (`54680,`, CDMX 4-digit) and the `Michioacán` typo. Pipeline: `cofepris-pdf-to-csv.py` → `cofepris-geocode.py` → `load-cofepris.ts --csv-path= --force` → ledger (grants restored by the loader since 09-29). 93.0% geocoded (2,231 precise / 621 modal / 214 none). Source quirks (not fixed): 34 licence numbers on 68 rows with different establishments; 8 licences whose 2-digit prefix differs from the entidad; all 3 constancia columns read `No aplica`. |
| ~~P2~~ done 09-28 | SEDATU financiamientos | 2025 full year + 2026 ene–jun (`_2026` views, 146,537 rows; MVs still read 2025) | same | Loaded 2026-09-28 20:4x UTC via `--year=2026`; promote with `--mv-source-year=2026` once the full year is published (`docs/SNIIV-2026-H1.md`) |
| ~~P2~~ done 09-28 | CNBV crédito vivienda | 2025 full year + 2026 ene–jun (`_2026` views, 45,048 rows; MVs still read 2025) | same | Loaded 2026-09-28 20:4x UTC via `--year=2026`; same promotion path as SEDATU |
| ~~P2~~ | Encuesta Intercensal 2025 | **2025 (loaded 2026-09-29)** | released 2026-09-22, state + municipio | DONE 09-29: `scripts/load-eic2025.ts` (merge `a4e6270`) → `eic_2025_municipio_raw` 13,880 + views `eic_2025_municipio` 2,478 / `_moe` 9,912 / `_censo_parity`; ledger `eic_2025 | 2025`; `municipios_2025` stays Censo 2020, join on cve_mun for 2025 figures (`docs/EIC-2025-LOADER-BRIEF-2026-09-28.md` §7) |
| ~~P3~~ DONE 09-27 | DENUE | **05/2026 loaded 2026-09-27** (6,138,075; was 11/2025, 6,097,681) | **11/2026 due 2026-11-25** | `ops/denue-refresh.sh` (11 h). Stale cleanup done 2026-09-28 03:55 UTC: 1,146,694 re-keyed/departed CLEE rows removed, count = extraction (see `docs/DENUE-REFRESH.md`) |
| ~~P3~~ deferred 09-29 | Aeropuertos | March-of-year 2006–2026 | AFAC through July 2026 | CLOSED for now (operator ruling 2026-09-29: "maybe later"). Reopen only on request; the March-only vs latest-month semantics decision still comes first, then reload via `scripts/load-aeropuertos.ts` |
| ~~P3~~ | Marco Geoestadístico | MG 2020 **+ MG 2025 (loaded 2026-09-29)** | MG 2025 (2.9 GB, 2025-12-15; 2,478 municipios) | DONE 09-29: `mun_polygons_2025` (2,478) + `ageb_polygons_2025` (82,283) live alongside 2020 via `scripts/load-mg2025-polygons.ts` (merge `513da75`); ledger `marco_geoestadistico | MG 2025` = 84,761; only street-geometry / osm-prewarm read 2025, every AGEB-keyed consumer stays on 2020 (`docs/MG-2025-LOAD-BRIEF-2026-09-28.md`) |
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

- ~~`mv_mortalidad_municipal_yearly` contains `ano = 9999`~~ fixed
  2026-09-28 (merged `5573867`; `ops/rebuild-mortalidad-mv.sh` run 20:4x UTC → 0 of 5,697 rows): the
  EDR sentinel for "año no especificado" passes the `^[0-9]{4}$` filter
  (332 raw rows, 55 MV rows; no other out-of-range `anio_ocur`). The
  analytics handlers fence it (`ano <= current year`, BETWEEN 2010 AND
  2039), but Sage SQL over the MV can pick it up. Fix: `AND anio_ocur <>
  '9999'` in `scripts/perf-matviews.sql`.
- The same MV mixes occurrence years from one registration-year file:
  years before 2024 only hold late-registration tails.
- ~~DENUE edition is not recorded anywhere~~ fixed 2026-09-28 (migration 026
  applied 20:4x UTC, 20 seed rows): `fecha_alta` is empty on all
  rows (the API does not return it). **Dataset versions:** migration 026
  adds the `dataset_versions` ledger, seeded from section 1;
  `scripts/record-dataset-version.ts` records each new load.
- ~~`docs/v0.2-status.md:99` says CLUES is the "ENERO 2026" cut~~ fixed
  2026-09-28, branch `fix/recon-data-quality`: the data carries movements
  to 2026-04-21 (2026-04 cut).
- ~~`scripts/backfill-ageb.ts` points to `docs/loading-marco-geoestadistico.md`~~
  fixed 2026-09-28, branch `fix/recon-data-quality`: that doc does not
  exist; the header now names its own recipe as the only load record (the
  polygons still have no loader script).
- Link rot: coneval.org.mx GRS zip serves HTML; gob.mx attachments and
  SICT repodatos refuse curl; INEGI open-data URLs return a 2,263-byte
  decoy with HTTP 200 for missing files (check Content-Length, not status).
- SNIIV has a JSON API that returns the alfresco file URL:
  `https://sniiv.sedatu.gob.mx/api/ReporteAPI/GetDocumentoAnio/{tipo}/{anio}/{fmt}`
  (tipo 2 = financiamientos, 7 = CNBV; fmt 1 = csv). Removes the manual
  node-id hunt.

## 3. OSM layer: absent in production (reloaded 2026-09-28)

- On 09-27 no relation matching `%osm%` existed in `postgres`. No API handler
  reads road metrics; only the loader and migration 002 (grants, "optional")
  reference `osm_ageb_aggregates`. No `osm-refresh.timer` is installed
  (`ops/osm-refresh.{service,timer}` exist in the repo only;
  `systemctl is-enabled` reports `not-found` for both).
- The May 24 load did NOT fail. Commit `983fd97` (05-24 19:06 UTC) records
  "81,451 AGEBs loaded in 461s", and mcp_readonly SELECT was verified that
  day. The intermediates stayed in `raw/osm/` because the delete-after-success
  step (audit #151) was only added on 09-27 in `77ecf23`; the May code never
  deleted them. The table was dropped afterwards; the 09-26 audit already
  found it missing.
- Most likely cause: the integration test committed in `d6b46c0` (05-24
  19:14 UTC, 8 min after `983fd97`). Its step 2 ran
  `SET search_path = <scratch>, public;` followed by
  `CREATE_AGGREGATE_TABLE_SQL`, whose first statement was an unqualified
  `DROP TABLE IF EXISTS osm_ageb_aggregates`. The scratch schema was still
  empty, so name resolution fell through to `public` and dropped the live
  table; the rest of the test then built its fixture table in the scratch
  schema and passed. Git history and SQL semantics identify the mechanism;
  logs cannot confirm it (the container's logs start at 09-27 02:44,
  `logging_collector` is off, `pg_stat_statements` is not installed). The
  database was not restored (relation OIDs are continuous; `establecimientos`
  is still OID 46926).
- Fixed 09-28: `buildAggregateSql(path, schema = "public")` qualifies every
  relation it reads, creates, drops or renames (and the post-load grants)
  with an explicit schema; the integration test passes its scratch schema
  instead of setting `search_path`, and the `CREATE_AGGREGATE_TABLE_SQL`
  export is gone.
- 2026-09-28: reloaded from the local May 24 GeoJSONSeq with the new
  `--reuse-export` flag (no download), as transient unit `osm-load-2026-09`,
  493.6 s. The flag now reloads only from an export that finished: osmium
  export writes `mexico-roads.geojsonseq.done` (the PBF's size + mtime) after
  it returns, and `--reuse-export` dies unless that marker matches the current
  PBF. Tonight's reused export predates the marker (the reload ran on the
  earlier mtime-only check; the successful load proves that export was
  complete) and the loader deleted it afterwards, so the next run re-exports
  from the PBF. The aggregate session now sets `max_parallel_workers_per_gather = 0`
  and `max_parallel_maintenance_workers = 0` because the container's
  `/dev/shm` is 64 MB (the DENUE runner hit "could not resize shared memory
  segment" on 09-27). Result: 81,451 rows (= every `ageb_polygons` row;
  63,982 urban 13-char + 17,469 rural 9-char cvegeo), 5,342 AGEBs with no
  road midpoint (road_length_m = 0, same count as May), 0 NULL
  `dist_to_major_road_m`, SELECT granted to `mcp_readonly` and `denue_sage`.
  Data vintage is still the May 24 Geofabrik extract; `mexico-latest.osm.pbf`
  (626 MB) remains in `raw/osm/`, the filtered PBF and GeoJSONSeq were
  deleted by the loader.
- A fresh Geofabrik pull (646 MB) needs operator approval under the
  bulk-transfer rule.

## 4. Suggested order

1. ~~OSM: diagnose + retry from local files (no download).~~ Done 09-28.
2. ~~SESNSP ene–ago 2026~~ (done 09-28; needed a loader change: UTF-8 input + zero-padded unpublished months), ~~CLUES 2026-08~~ (done 09-28; conversion script now checked in), ~~COFEPRIS 2026-05~~ (done 09-28; the
   PDF layout changed, so the parser and loader schema changed too: `145aa3b`). All three P1 items needed code, not just a re-run.
3. ~~Parametrise the SEDATU and CNBV loaders by year; load 2026 H1 next to
   2025.~~ Done 09-28: `--year` / `--mv-source-year`, MVs stay on the latest
   complete year (`docs/SNIIV-2026-H1.md`).
4. ~~EIC 2025 municipal layer~~ DONE 09-29: all three steps of ruling (b)
   are live (step 1 bridge `1cdc4af`, step 3 MG 2025 polygons `513da75`,
   step 2 EIC loader `a4e6270`; first consumer municipio-detail
   `population_2025` + MOE `acc946f`). Follow-ups CLOSED 09-29: the 24 stray DENUE
   `area_geo` codes are re-keyed spatially (`scripts/rekey-stray-area-geo.sql`,
   now a refresh post-step); `postLoadGrants` restores `denue_api` too, so
   a reload no longer needs `api-role.sql` re-run unless the relation is
   missing from its allowlist. History:
   `docs/EIC-2025-RECON-2026-09-28.md` (sources curl-able, 9 new municipios +
   parents, 4,950 DENUE rows already orphaned today). Ruling 09-28: (b)
   staged + MG 2025 pull approved. Step 1 bridge LIVE (`beacbba`, migration
   027, `municipios_2025` = 2,478 keys, orphans 4,950→24). Step 2 loader
   brief: `docs/EIC-2025-LOADER-BRIEF-2026-09-28.md`; step 3 polygons brief:
   `docs/MG-2025-LOAD-BRIEF-2026-09-28.md` (zip on disk, 2.9 GB).
5. DENUE 05/2026 loaded 2026-09-27 and stale rows cleaned 2026-09-28. After 2026-11-25: DENUE 11/2026 re-extract (~11 h of API paging);
   after ~Nov 2026: EDR 2025 definitive with `--append` + MV refresh.
6. ~~Aeropuertos: rule on March-only vs latest-month semantics, then reload.~~ Deferred 09-29 by operator ruling ("maybe later"); nothing scheduled.
