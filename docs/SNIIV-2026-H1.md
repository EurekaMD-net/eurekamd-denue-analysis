# SNIIV 2026 H1 (enero–junio) beside 2025

Freshness queue item P2 (`docs/DATA-FRESHNESS-2026-09-27.md`): SEDATU
financiamientos and CNBV crédito vivienda, both year-locked to `_2025` until
2026-09-28. Branch `feat/sniiv-2026-h1`.

## What was fetched (2026-09-28)

URLs resolved through the SNIIV JSON API
`https://sniiv.sedatu.gob.mx/api/ReporteAPI/GetDocumentoAnio/{tipo}/{anio}/{fmt}`
(fmt 1 = csv). The alfresco proxy answers HEAD with 405, so the size was
checked on the saved body (both are real CSVs, not HTML decoys).

| Dataset | API call | Resolved file | Bytes | Last-Modified | Saved as |
| --- | --- | --- | --- | --- | --- |
| SEDATU financiamientos | `/2/2026/1` | `.../node/InqUr63cSnew3Ho7SCtZNA/content/Financiamientos_2026.csv?a=true` | 9,887,613 | 2026-08-31 18:11 GMT | `raw/sedatu/financiamientos_2026.csv` |
| CNBV crédito | `/7/2026/1` | `.../node/4arF1K3JQAmTZmSsmgbr7g/content/CNBV_2026.csv?a=true` | 3,400,693 | 2026-08-31 17:59 GMT | `raw/cnbv/credito_2026.csv` |

Both: `text/csv;charset=ISO-8859-1`, CRLF line endings (same as the 2025
files), `año` header byte 0xf1. `raw/` is gitignored; the files sit in the
main checkout's `raw/`.

Header check: both headers equal the loaders' `RAW_HEADER_COLS` exactly
(`año` read as `ano`); no column added, dropped, renamed or reordered.

| | Rows | ano | mes 1 | 2 | 3 | 4 | 5 | 6 | estados | empty cve_mun |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SEDATU | 146,537 | all 2026 | 21,135 | 22,262 | 26,362 | 24,449 | 25,973 | 26,356 | 32 + 4 rows with empty cve_ent | 167 |
| CNBV | 45,048 | all 2026 | 5,650 | 6,786 | 8,590 | 7,829 | 7,917 | 8,276 | 32 | 0 |

## Loader convention

- `--year=<YYYY>` (default 2025) names the raw table, the typed view and the
  estado-grain view: `sedatu_financiamientos_raw_<YYYY>`,
  `sedatu_financiamientos_<YYYY>`, `sedatu_financiamientos_estado_grain_<YYYY>`
  (same for `cnbv_credito_*`), and the default CSV
  (`raw/sedatu/financiamientos_<YYYY>.csv`, `raw/cnbv/credito_<YYYY>.csv`).
  The value must match `^20[0-9]{2}$` before it reaches any identifier; every
  name built from it also passes `_psql-tx.ts` `assertIdent`. Raw-table index
  names get a `_<YYYY>` suffix (2025 keeps its original names).
- `--mv-source-year=<YYYY>` (default 2025) is the latest COMPLETE year. The
  four MVs (`sedatu_financing_by_municipio/_estado`,
  `cnbv_credito_by_municipio/_estado`) are rebuilt from that year's views only,
  and only when `--year` equals it. The API joins them on `cve_mun` /
  `cve_ent` alone and exposes `periodo = MIN(ano)`, so a partial year must not
  feed them. `--year=2026` alone loads the 2026 raw table + views, leaves the
  MVs and the shared lookup tables (`sedatu_organismos`, `cnbv_intermediarios`,
  ...) untouched, and prints `... are NOT rebuilt and still read 2025`.
- Both flags need the `=` form: `--year 2026` or a bare `--year` is refused
  (it would otherwise load the default year silently), and so is any argument
  other than `--csv=`, `--year=`, `--mv-source-year=`, `--force` (e.g.
  `--mv_source_year=2026`). The container comes from `SUPABASE_DB_CONTAINER`.
- Pre-flight (read-only, before any write): the loader reads which year's
  views the MVs depend on today (`pg_depend`, `MV_SOURCE_VIEWS_SQL`) and
  refuses (`checkMvSourcePairing`) when
  - a run would rebuild the MVs from a different year and
    `--mv-source-year` was not passed explicitly (e.g. a bare `--force`
    reload after 2026 was promoted would put the MVs back on 2025);
  - a views-only run (`--year` != `--mv-source-year`) names a
    `--mv-source-year` the MVs do not read, or targets the year they do read
    (its DROP VIEW would fail on the MV dependency after the raw COPY).
  On a fresh DB (no MVs) anything goes. The promotion lines below pass both
  flags, as a revert must (`--year=2025 --mv-source-year=2025 --force`), so
  the MVs only switch deliberately.
- Input checks run before any DB call: header == `RAW_HEADER_COLS` (the diff
  is reported), every row's `ano` == `--year`, every `mes` in 1..12
  (`scripts/_sniiv-csv.ts`).
- Grants: every relation a run (re)creates gets `postLoadGrants` (REVOKE from
  anon / authenticated / trustr_app, which postgres' default ACL grants on every
  new table; GRANT SELECT to denue_sage where `scripts/sage-role.sql`
  allowlists it). The raw table's CREATE and its REVOKE commit in one
  transaction (`rawDdl`), so a failed COPY never leaves a new year's raw table
  readable by trustr_app. The `_2026` views are allowlisted there (existence-guarded),
  the `_2026` raw tables are not, and `sql-gate.ts` refuses every
  `(sedatu_financiamientos|cnbv_credito)_raw_<YYYY>` by pattern
  (`FORBIDDEN_RELATION_PATTERNS`, beside the named `FORBIDDEN_RELATIONS`). `api-role.sql` is unchanged: the API reads only the MVs.
- Sage: `SAGE_SQL_SCHEMA_SUMMARY` lists `sedatu_financiamientos_2026`,
  `cnbv_credito_2026` and both `_estado_grain_2026` views, marked partial.

Proven on a throwaway `supabase/postgres:15.8.1.085` container (the live
image, `--network none`): 2025 baseline reproduced the live MV totals exactly
(1,848 munis / 998,745 acciones / 616.98 B MXN; 812 / 278.94 B); the 2026
loads left the MVs and lookups untouched (same `pg_class.xmin`, `periodo`
still 2025); promotion to 2026 and back to 2025 both worked; a 2025 file
passed as `--year=2026` and a bad `--year` were refused before any DB call.

Fixed on the way: `_psql-tx.ts` `copyFromStdinScript` ended every inline COPY
with `\.\n`. After CRLF data PG15 rejects that ("unquoted newline found in
data") and the load rolls back, so neither SNIIV file (2025 included) could
load since `8b0acf2` (2026-09-27). The marker now follows the data's newline
style. It also affects `load-aeropuertos.ts` and `load-sict-datos-viales.ts`
if their inputs are CRLF.

## Operator: load 2026 H1 (after merge; nothing else runs)

Run from the main checkout. Each loader is one short transaction per step,
under a minute on the scratch copy.

```
cd /root/claude/projects/data-intelligence/denue-data-analysis
npx tsx --env-file=.env scripts/load-sedatu-financiamientos.ts --year=2026 --csv=/root/claude/projects/data-intelligence/denue-data-analysis/raw/sedatu/financiamientos_2026.csv
npx tsx --env-file=.env scripts/load-cnbv-credito.ts --year=2026 --csv=/root/claude/projects/data-intelligence/denue-data-analysis/raw/cnbv/credito_2026.csv
```

Expected last lines (scratch run):
`[load-sedatu] done. 146537|146370|1653|2026..2026|1..6|427,755|292.5` and
`[load-cnbv] done. 45048|45048|629|2026..2026|1..6|53,381|135.21|18`.

Then restart the service so Sage picks up the catalog and gate entries:

```
systemctl restart denue-analyzer
```

Read-only checks afterwards:

```
docker exec supabase-db psql -U postgres -d postgres -qtA -c "SET default_transaction_read_only=on" -c "SET statement_timeout='15s'" -c "SET work_mem='16MB'" -c "SELECT COUNT(*), MIN(ano), MAX(ano), MIN(mes), MAX(mes) FROM sedatu_financiamientos_estado_grain_2026"
docker exec supabase-db psql -U postgres -d postgres -qtA -c "SET default_transaction_read_only=on" -c "SET statement_timeout='15s'" -c "SET work_mem='16MB'" -c "SELECT COUNT(*), MIN(ano), MAX(ano), MIN(mes), MAX(mes) FROM cnbv_credito_estado_grain_2026"
docker exec supabase-db psql -U postgres -d postgres -qtA -c "SET default_transaction_read_only=on" -c "SET statement_timeout='15s'" -c "SET work_mem='16MB'" -c "SELECT (SELECT string_agg(DISTINCT periodo, ',') FROM sedatu_financing_by_estado), (SELECT string_agg(DISTINCT periodo, ',') FROM cnbv_credito_by_estado)"
docker exec supabase-db psql -U postgres -d postgres -qtA -c "SET default_transaction_read_only=on" -c "SET statement_timeout='15s'" -c "SET work_mem='16MB'" -c "SELECT relname, has_table_privilege('denue_sage', oid, 'SELECT') AS sage, has_table_privilege('trustr_app', oid, 'SELECT') AS trustr, has_table_privilege('anon', oid, 'SELECT') AS anon FROM pg_class WHERE relname ~ '^(sedatu_financiamientos|cnbv_credito).*_2026$' AND relkind IN ('r','v') ORDER BY 1"
```

Expect: ano 2026..2026 and mes 1..6 on both views; periodo `2025|2025`
(MVs untouched); sage `t` on the four views and `f` on the two raw tables,
trustr / anon `f` everywhere.

## Promote 2026 once SNIIV publishes the full year

When the API's `/2/2026/1` and `/7/2026/1` files carry mes 1..12, fetch them
again (check the body size), then:

```
cd /root/claude/projects/data-intelligence/denue-data-analysis
npx tsx --env-file=.env scripts/load-sedatu-financiamientos.ts --year=2026 --mv-source-year=2026 --force
npx tsx --env-file=.env scripts/load-cnbv-credito.ts --year=2026 --mv-source-year=2026 --force
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql
systemctl restart denue-analyzer
```

`api-role.sql` must be re-run because rebuilding an MV drops the denue_api
SELECT on it (postLoadGrants only restores denue_sage). In the same change,
set `DEFAULT_YEAR = "2026"` in both loaders; otherwise a later bare
`--force` reload is refused by the pre-flight (MVs read 2026, default says
2025). For 2027 H1 only two files need a per-year edit: the `_2027` view
names in `sage-role.sql` (guarded GRANT block) and the views in the Sage
catalog (`src/api/sage/endpoint-catalog.ts`). The sql-gate pattern already
refuses the `_2027` raw tables.

## Deferred (R2 audit 2026-09-28)

Queued, not fixed.

1. `scripts/load-sict-datos-viales.ts:447-457`: "`rewriteHeader` strips `\r`
   from the header only; with a CRLF source the EOL detection picks LF and
   COPY fails 'unquoted carriage return'. Current
   `raw/sict/datos_viales_2024.csv` is LF."
   Trigger: the next SICT edition load (DV2025). Run `file raw/sict/*.csv`
   first; the output must not say "with CRLF line terminators".
2. `scripts/load-sedatu-financiamientos.ts:154-206`,
   `scripts/load-cnbv-credito.ts:191-243` (`MV_SOURCE_VIEWS_SQL` +
   `checkMvSourcePairing`): "Pre-flight inspects only the loader's own two
   MVs; any other pg_rewrite dependent on a year view would fail at the views
   DDL after the raw COPY committed. Nothing else depends today."
   Trigger: the first time another view/MV is built on
   `sedatu_financiamientos_<year>` or `cnbv_credito_<year>`.
