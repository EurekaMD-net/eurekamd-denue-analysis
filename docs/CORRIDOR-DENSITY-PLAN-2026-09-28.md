# Corridor density + street geometry — plan (2026-09-28)

Goal: answer "how many pharmacies (or any SCIAN class) sit along this street /
road, per kilometre" WITHOUT a persistent roads table.

Two capabilities, one UI:

- **(3) Corridor density**: given a line (drawn on the map or produced by (2)),
  buffer it N metres and count `establecimientos` inside, by class, per km.
  Pure PostGIS over the existing point GIST index. Nothing stored.
- **(2) Street geometry from the local PBF**: given a street name + municipio,
  return the street's geometry as GeoJSON. Source = `raw/osm/mexico-latest.osm.pbf`
  (626 MB, on disk, never re-downloaded here). A per-municipio road extract is
  cached on disk the first time a municipio is asked for; street lookups inside
  a cached municipio are sub-second. Nothing goes into Postgres.

Not in scope: a roads table, snapping establishments to roads, Overpass /
Nominatim, any Geofabrik download, Sage SQL access to roads.

## Architecture (fixed contracts — packages build in parallel against these)

### P1 — API `POST /analytics/corridor-density`  (owner: handler package)

Files: `src/api/handlers/corridor.ts`, `src/api/handlers/corridor.test.ts`.
Does NOT edit `server.ts` (wired in P4).

Request JSON:
```json
{
  "geometry": { "type": "LineString" | "MultiLineString", "coordinates": [...] },
  "buffer_m": 100,                      // int, 10..1000, default 100
  "clase_prefix": "4641",               // optional SCIAN prefix 2..6 digits (clase_actividad_id LIKE 'prefix%')
  "top": 10                             // optional 1..50, default 10
}
```
Validation (400 `validation.*` via `HttpError`, same style as `search.ts`):
GeoJSON type in the two allowed; every coordinate a finite number pair inside
the Mexico bbox (lon -118.5..-86.5, lat 14.3..32.8); total vertices 2..5000;
geodesic length 10 m..50 km (computed in SQL, rejected with 400
`validation.geometry.length` after the fact, or pre-checked with a haversine
sum — builder's choice, both bounded). Geometry is re-serialised from the
VALIDATED numeric arrays (never from the request text) into the SQL literal,
so no user string ever reaches psql. `clase_prefix` must match `^\d{2,6}$`.

SQL shape (one `runJson` call, `statement_timeout` via the runner's option,
≤ 15 s; `default_transaction_read_only` on):
```sql
WITH line AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON('<serialised>'),4326) AS g),
     buf  AS (SELECT ST_Buffer(g::geography, <buffer_m>)::geometry AS b,
                     ST_Length(g::geography) AS len_m FROM line),
     hits AS (SELECT e.clase_actividad_id, e.clase_actividad
              FROM establecimientos e, buf
              WHERE e.geom && buf.b AND ST_Intersects(e.geom, buf.b)
                [AND e.clase_actividad_id LIKE '<prefix>%'])
SELECT json_build_object(
  'length_m', (SELECT len_m FROM buf),
  'buffer_m', <buffer_m>,
  'total', (SELECT count(*) FROM hits),
  'per_km', (SELECT count(*) FROM hits) / NULLIF((SELECT len_m FROM buf)/1000.0,0),
  'by_clase', (SELECT coalesce(json_agg(t),'[]') FROM (
       SELECT clase_actividad_id, clase_actividad, count(*) AS n
       FROM hits GROUP BY 1,2 ORDER BY n DESC LIMIT <top>) t),
  'buffer_geojson', (SELECT ST_AsGeoJSON(b, 6)::json FROM buf)
);
```
Response 200: `{ length_m, buffer_m, total, per_km, by_clase:[{clase_actividad_id, clase_actividad, n}], buffer_geojson }`.

**As shipped (post-audit; supersedes the SQL sketch above).**
- Counting never calls `ST_Buffer`. The handler computes, in TS, a grid of
  cells (about `buffer_m/2` wide, merged into runs per row) that covers the
  line. The SQL joins `establecimientos` to those cells (`&&` the cell
  envelope plus a half-open `ST_X/ST_Y` test, so no row is counted twice)
  and keeps rows with `ST_DWithin(e.geom::geography, line.gg, buffer_m)`
  (the line is cast to geography once, in the `line` CTE). The index work
  follows the corridor, not the line's envelope.
- Candidate cap (round-2 audit): the cell join is a `cand` CTE with
  `LIMIT 40001` (`MAX_CANDIDATE_ROWS = 40_000`, still one `Index Scan using
  idx_estab_geom` per run). When `cand` holds more than 40,000 rows the
  statement returns `{"error":"too_many_candidates"}` instead of the result,
  and the handler answers 400 `validation.geometry.area`. The area cap
  alone did not bound the rows: live density reaches ~10,300 rows/km² in
  Centro Histórico, so 15 km² there is 100–150k candidates and a 15 s
  timeout. The `clase_prefix` filter applies after the cap.
- No GEOS anywhere. `buffer_geojson` is display-only and built in TS from
  the cell runs the count scanned: a `MultiPolygon` with one closed lon/lat
  rectangle ring per run (6 dp), i.e. a blocky superset of the true buffer.
  It is `null` when there are more than 500 runs. (The earlier
  `ST_Buffer(ST_Simplify(...))` display path cost 1.5–2.3 s and ~300 MB of
  GEOS on a 500-vertex scribble; it is gone.)
- Shape guards run before any SQL is built, each a 400:
  `validation.geometry.segment` (every segment ≥ 1 m),
  `validation.geometry.extent` (envelope diagonal ≤ 60 km),
  `validation.geometry.vertices` (2..5000 and at most one vertex per 5 m of
  length), `validation.geometry.length` (10 m..50 km, MultiLineString gaps
  included), and `validation.geometry.area` (covered cell area ≤
  `MAX_COVER_AREA_KM2 = 15`, ≈ 35 km of line at 100 m, ≈ 3 km at 1000 m;
  diagonal lines use more area).
- Rate limit: 20/min per principal+IP (`CORRIDOR_RATE_LIMIT`), on top of
  the `/analytics/*` 120/min. `X-Api-Key` (Jarvis) is exempt from both.
Caveat (docs only, the endpoint stays pure): until the operator runs
`ops/denue-stale-cleanup.sh`, the table still holds 1,146,694 stale-CLEE rows
and corridor counts are inflated by roughly the same share as every other
analytic.

Tests (mock `runJson` like sibling handler tests): validation matrix (type,
bbox, vertex count, buffer range, prefix regex, NaN/Infinity, nested depth),
serialisation from validated arrays (a coordinate given as a string is
rejected, never passed through), SQL contains the prefix only when given,
response passthrough. Bring `web`-side types later (P3 owns them).

### P2 — Street geometry service + `GET /analytics/street-geometry`  (owner: osm package)

Files: `src/osm/street-index.ts` (pure logic), `src/osm/osmium.ts` (process
wrapper), `src/osm/*.test.ts`, `src/api/handlers/street-geometry.ts` (+test),
`scripts/osm-prewarm.ts` (CLI). Does NOT edit `server.ts`.

Cache layout: `data/osm-cache/mun/<cve_mun>.roads.geojsonseq` (+ `.done`
marker holding the PBF fingerprint `size=<bytes> mtimeMs=<int>`, same
convention as `load-osm-ageb.ts`). Built by:
1. bbox of the municipio: `SELECT ST_XMin(..),ST_YMin,ST_XMax,ST_YMax FROM
   mun_polygons WHERE cvegeo = $cve_mun` (read-only `runJson`; the column that
   holds the 5-char key — check `mun_polygons` columns first). Pad 0.01°.
2. `osmium extract --bbox <bbox> --strategy simple -o <tmp>.pbf raw/osm/mexico-latest.osm.pbf`
   then `osmium tags-filter <tmp>.pbf w/highway -o <tmp2>.pbf` then
   `osmium export <tmp2>.pbf -f geojsonseq --geometry-types=linestring
   -o <cache>.geojsonseq`; strip RS (`\x1e`) the way the loader does; write
   `.done`; delete temps. Run via `execFile` with `nice -n 19`, a 10-minute
   timeout, `maxBuffer` irrelevant (files, not stdout).
   Extraction of one municipio = one pass over the 626 MB PBF (~1–2 min,
   ~1 GB RSS). A process-wide queue with concurrency 1 and per-cve_mun
   de-duplication (a second request for the same municipio while extracting
   waits on the same promise; never two osmium runs at once).
3. Street lookup: stream the cached geojsonseq line by line (never
   `readFileSync` whole — the DENUE lesson), keep features whose
   `properties.name` normalises to contain the query (NFD, strip diacritics,
   lower, collapse spaces; the query normalised the same way; also match
   `alt_name`/`official_name` if present). Group by exact normalised `name`;
   for each group: MultiLineString of the segments (no PostGIS; just collect
   coordinates), total length via haversine, highway classes seen. Return
   groups sorted by length desc, max 20.

Request: `GET /analytics/street-geometry?cve_mun=09014&q=insurgentes`
- `cve_mun` `^\d{5}$` and must exist in `mun_polygons` (else 404
  `municipio.not_found`); `q` 4..80 chars after trim (raised from 3 by the
  QA round), no control chars.
- Cache hot → 200 `{ cve_mun, q, status:"ok", matches:[{ name, highway:[...],
  length_m, segments, geometry:{type:"MultiLineString", coordinates} }] }`
  (coordinates rounded to 6 dp; cap total vertices per match at 20,000 by
  dropping matches beyond the cap with `truncated:true`).
- Cache cold → kick the extraction (queue) and return **202**
  `{ status:"extracting", cve_mun, retry_after_s: 30 }` with `Retry-After: 30`.
  Also 202 while the extraction is in flight. Extraction failure → 502
  `osm.extract_failed` with the stderr tail logged (not returned).
- No name matches in a hot cache → 200 with `matches: []`.
- Guards (QA round): > 2 concurrent hot lookups → 429 `osm.busy`
  (`Retry-After: 1`); 3 municipios already queued → 429 `osm.queue_full`
  (`Retry-After: 60`); < 5 GB free or > 20 GB cached → 503
  `osm.cache_budget`; padded bbox > 1 deg² → 409 `osm.bbox_too_large`
  (71 of 2,469 municipios, e.g. 06009, 02001, 02006); PBF missing → 503
  `osm.source_missing`. A hot lookup stops reading after 80,000 matching
  vertices and sets `truncated:true`.
- **As shipped (post-audit, round 2):**
  - Cold-extraction limit: 10 admissions per hour per principal+IP
    (`COLD_EXTRACT_LIMIT`, sliding window, same key as the route limiters;
    `X-Api-Key` is NOT exempt). The 11th → 429 `osm.cold_limit` with
    `Retry-After`. Only an enqueue counts; hot hits, 202s for a municipio
    already in flight, 404s and 409s never do. Without it one caller could
    cycle all 2,469 municipios and fill the 20 GB cache for good (no
    eviction).
  - The cache budget is checked again when the queued job starts (queued
    jobs used to run on the pre-queue snapshot). A failure there is reported
    once to the next caller as 503 `osm.cache_budget` and nothing is
    extracted.
  - The PBF `.done` fingerprint is taken before step 1, so a PBF refresh
    during a build leaves a marker that no longer matches (entry stays cold).
  - `q` length (4..80) is checked on the normalised string
    (`normalizeName`: accents stripped, whitespace collapsed).
- Bbox guard applies to the API only. The prewarm CLI refuses those
  municipios too unless given `--force`.
- Concurrency on disk: an O_EXCL `<cve_mun>.lock` (pid + start time) keeps
  the API and the CLI from building the same municipio at once. Temp files
  carry the builder's pid (`<cve_mun>.tmp-*.<pid>.*`, `*.<pid>.part`).
  `sweepStaleTemps()` runs at startup and removes temps and locks left by
  dead runs.

CLI: `npx tsx scripts/osm-prewarm.ts 09014 09015 ...` (or `--estado 09` →
all municipios of that estado from `mun_polygons`) warms the cache
sequentially, prints per-municipio time + size, skips hot entries whose
`.done` matches the PBF. Docs must say the operator runs it under `nice`
or a transient unit for whole estados (CDMX 16 alcaldías ≈ 16 PBF passes ≈
30 min).

Tests: normalisation (accents, case, "Av." vs "Avenida" NOT normalised —
substring only), grouping, haversine length, streaming reader on a fixture
geojsonseq (multi-record, one malformed line → skipped with a counted
warning, not a crash), queue de-dup (two concurrent calls → one extraction),
`.done` fingerprint mismatch → rebuild, handler validation + 202/200/502
paths with the service mocked.

### P3 — Web: corridor tool in MapMode  (owner: web package)

Files under `web/src/`: `api/corridor-client.ts` (+test), `map/CorridorTool.tsx`
(+test), `map/CorridorPanel.tsx`, minimal hooks in `modes/MapMode.tsx` and
`store.ts` (new slice `corridor`: points, bufferM, clasePrefix, result,
status, streetQuery, streetMatches). URL sync: NOT persisted (a corridor is
ephemeral) — do not touch `useUrlSync.ts`.

Interaction:
- Toolbar button "Corredor" toggles draw mode. In draw mode each map click
  appends a vertex; the polyline renders as a deck.gl `PathLayer`; Backspace
  removes the last vertex; Esc exits draw mode; "Limpiar" clears.
- Panel: buffer slider 10–1000 m (default 100), SCIAN prefix input (reuses
  the existing class filter value from the store if one is active; default
  4641 "Farmacias" preset button), "Calcular" (auto-runs on vertex/buffer
  change with 400 ms debounce once ≥ 2 vertices).
- Result: length km, total, per km, top classes table; the returned
  `buffer_geojson` renders as a translucent `GeoJsonLayer`/`PolygonLayer`.
- Street search inside the panel: text input + municipio = the municipio of
  the map centre (call the existing point-in-polygon resolver already used by
  the map, or the visible `cve_mun` from the store — whatever exists; if
  neither, a 5-digit input). On submit call `street-geometry`; on 202 show
  "Extrayendo vialidades de <municipio>… (~1–2 min)" and poll every
  `retry_after_s`; on 200 list the matches (name, km, classes); clicking one
  loads its MultiLineString as the corridor (the corridor endpoint accepts
  MultiLineString) and runs the density query.
- Errors: 400 messages from the API shown verbatim in the panel; 502 → "El
  servicio OSM falló; reintenta".

Client contracts exactly as P1/P2 above; write `api/corridor-types.ts` and
test the client against fixtures. Keep `MapMode.tsx` edits small (mount the
tool + panel). `npx tsc --noEmit -p web`, scoped vitest on the new tests +
`MapShell.test.ts`/`MapMode`-adjacent tests you touched. `npm run build` in
`web/` at the end (bundle size delta reported; the tool must live in the
lazy `MapMode` chunk, not the index chunk).

### P4 — Wiring, Sage catalog, docs (after P1–P3; single agent)

- `src/api/server.ts`: register `POST /analytics/corridor-density` and
  `GET /analytics/street-geometry` next to the other analytics routes; the
  header comment route list; confirm the analytics rate limiter / auth
  middleware covers POST as it does the Sage POST; `server.test.ts` route
  assertions if such a list exists.
- `src/api/sage/endpoint-catalog.ts`: add both endpoints (street-geometry
  first, corridor-density second, with the note that Sage must call
  street-geometry and pass one match's geometry) — only if the catalog
  schema supports a JSON body param; otherwise document the omission.
- Docs: this file gets a "Shipped" section (commits, numbers); README gets
  two endpoint rows + the "no roads table" note; `docs/osm-roads-plan.md`
  gets a pointer.
- Full sharded suites (`npx vitest run --shard=i/4` root and web), tsc both.

## Ops / deploy

- No DB DDL. No downloads. `data/osm-cache/` is already git-ignored (the
  existing `data/` line in `.gitignore` covers it), disk ≈ 10–60 MB per
  municipio.
- API runs live tsx under `denue-analyzer` → restart is an OPERATOR action:
  `systemctl restart denue-analyzer` after merge; the web `dist/` is served
  from the build output (rebuild in P3, served on next request).
- Bulk-transfer rule untouched: the PBF is never fetched by this work.

## Done-check (whole feature)

1. `curl -sS -X POST localhost:<port>/analytics/corridor-density -H 'content-type: application/json' -d '{"geometry":{"type":"LineString","coordinates":[[-99.1735,19.4326],[-99.1650,19.4270]]},"buffer_m":100,"clase_prefix":"4641"}'` → 200 with `total` > 0 and `per_km` numeric (after operator restart; before it, prove via a scratch `tsx` call of the handler or a throwaway port).
2. `GET /analytics/street-geometry?cve_mun=09015&q=reforma` → 202 then, after prewarm, 200 with ≥ 1 match whose `name` contains "Reforma".
3. Web: draw 3 points in Cuauhtémoc → panel shows a count; search "reforma" → click a match → corridor replaced, count updates.
4. qa-auditor PASS on P1+P2 (injection: the geometry literal is built from numbers only; osmium argv built from validated bbox numbers and fixed paths; path traversal impossible for `cve_mun`), and on P3 (no new deps unless justified, chunk placement).

## Shipped 2026-09-28

Status: P1–P4 built and green in the working tree; **uncommitted**, and the
live `denue-analyzer` has NOT been restarted (operator steps below).

### Files

- **P1** `src/api/handlers/corridor.ts` (+`corridor.test.ts`): 90 tests after the round-2 audit fixes.
- **P2** `src/osm/` (`street-index.ts`, `osmium.ts`, `extract-queue.ts` +
  tests), `src/api/handlers/street-geometry.ts` (+test),
  `scripts/osm-prewarm.ts`, `scripts/api-role.sql` (`mun_polygons` added to
  the `denue_api` allowlist) + `scripts/api-role.test.ts`. `.gitignore` is
  unchanged: its `data/` line already covers `data/osm-cache/`. After the audit fixes, the `src/osm/`,
  `street-geometry` and `osm-prewarm` test files hold 73 tests (round 2).
- **P3** `web/src/api/corridor-{client,types}.ts`, `web/src/map/Corridor{Tool,Panel}.tsx`,
  small hooks in `web/src/modes/MapMode.tsx` + `web/src/store.ts`: 70 tests in the four corridor test files (round 2).
  `web/dist` rebuilt. The line and buffer use **MapLibre layers, not
  deck.gl**: pulling deck.gl in would have added about 211 kB gz. The API's
  guard codes map to Spanish panel messages in `corridor-client.ts`
  (`validation.geometry.area`, `osm.bbox_too_large`, `osm.queue_full`,
  `osm.busy` with one transparent retry, `osm.cold_limit`, `osm.cache_budget`,
  `osm.source_missing`, plus fixed lines for 401/413/429). Bundle after the
  audit fixes: MapMode chunk +18.5 kB (+5.5 kB gz), index chunk +1.0 kB.
- **P4** `src/api/server.ts`: `GET /analytics/street-geometry` and
  `POST /analytics/corridor-density` registered with the other analytics
  routes, header route list 42 → 44. `app.use` is method-agnostic, so the
  `/analytics/*` auth and 120/min principal+IP limiter cover the POST. The
  POST also gets its own limiter, 20/min per principal+IP from
  `CORRIDOR_RATE_LIMIT` (`exempt: isPriorityRequest`, so Jarvis stays
  exempt as on the other analytics routes). After that limiter comes
  `bodyLimit` (1 MiB, 413 `payload_too_large`): limiter first, then body
  cap, the same order as `/sage/query`. `server.test.ts` +3 tests: POST 401
  without auth, 413 over 1 MiB, and 429 on the 21st POST inside a minute
  (the first 20 reach the handler's 400).
  `src/api/sage/endpoint-catalog.ts` + `dispatcher.ts`: **street-geometry
  added** (`cve_mun`, `q` required; `q` 4–80 characters; the description
  names the guard codes 404 `municipio.not_found`, 409 `osm.bbox_too_large`,
  429 `osm.queue_full` / `osm.busy` / `osm.cold_limit`, 502
  `osm.extract_failed`, 503 `osm.cache_budget` / `osm.source_missing`). **corridor-density is NOT
  Sage-callable.** `dispatchEndpoint` only issues GETs with scalar query
  params (`Record<string,string|number>`), and Sage keeps only digests
  between turns, so it cannot pass a match's coordinates into a follow-up
  call. Enabling it needs a POST/body path in the dispatcher (future work).
  `dispatcher.test.ts` SAMPLE gains `q`. README gets two endpoint rows and
  the "no roads table" note. `docs/osm-roads-plan.md` gets a pointer line.

### Checks (P4 run)

- `tsc --noEmit` passes in the root and in `web/`.
- Root vitest shards 1–4: 424 / 342 / 495 / 724. Total 1,985 tests in 101 files, 0 failures.
- Web vitest shards 1–4: 67 / 101 / 130 / 59. Total 357 tests in 27 files, 0 failures.
  (Final wiring pass, after the audit fixes.)

### Live numbers

- **Corridor, Reforma line** (`[[-99.1735,19.4326],[-99.1650,19.4270]]`,
  100 m, `4641`): `length_m` 1,086.79, `total` 5, `per_km` 4.60 (3×464113
  naturistas, 1×464111, 1×464112). Takes 148–200 ms. Re-proved in P4 on a
  throwaway `scripts/serve.ts` on :18099 from the current tree, and again
  after the cell-cover rewrite (200, total 5, 188 ms), and after the round-2
  fixes (200, total 5, 162 ms server-side, `buffer_geojson` a MultiPolygon
  of 17 cell runs; `street-geometry?cve_mun=09015&q=reforma` hot → 200,
  5 matches, 226 ms).
- **Corridor, diagonal line** `[[-99.20,19.40],[-99.12,19.47]]` (11.4 km),
  100 m, no prefix: 200, `total` 2,848, `per_km` 249.2, 1,057 ms.
- **49 km straight line at 1000 m**: 400 `validation.geometry.area`
  (~135 km² covered, max 15) in 2 ms, before any SQL.
- **Rate limit**: 21 fast POSTs as one Bearer principal → 20 × 400, then 429.
  An `X-Api-Key` POST right after is still served (exempt).
- **`street-geometry?q=ref`** → 400 `validation.q`.
- **`street-geometry?cve_mun=06009&q=hidalgo`** → 502 `postgres.error`, not
  409: the bbox guard reads `mun_polygons` as `denue_api` and the grant is
  not applied yet. After operator step 1 this returns 409
  `osm.bbox_too_large`. No extraction started.
- **09015 extraction**: 12.7 s, peak RSS 1.88 GB, cache 5.89 MB.
- **`street-geometry?cve_mun=09015&q=reforma`**: 200, 5 matches in 198–207 ms.
  The longest is "Avenida Paseo de la Reforma" at 16,047 m (100 segments).
- **`street-geometry?cve_mun=09014&q=insurgentes`** (cold cache): **502
  `postgres.error`**. The throwaway runs as `denue_api`, and the
  `mun_polygons` grant is not applied yet (`permission denied for table
  mun_polygons` in the log). This is the expected result until operator step 1.
  After the grant the same call returns 202 and starts the extraction.

### Operator steps

1. Apply the `mun_polygons` grant from `scripts/api-role.sql`. Either
   re-run the whole idempotent script the usual way, or run just the one new
   grant:
   `docker exec supabase-db psql -U postgres -c "GRANT SELECT ON public.mun_polygons TO denue_api;"`
   Check it with
   `docker exec supabase-db psql -U postgres -Atc "SELECT has_table_privilege('denue_api','public.mun_polygons','SELECT')"`
   → `t`.
2. `systemctl restart denue-analyzer`: the new routes are live only after the restart.
3. Optional: prewarm all of CDMX (16 alcaldías, one PBF pass each):
   `systemd-run --unit=osm-prewarm-09 --nice=19 --working-directory=/root/claude/projects/data-intelligence/denue-data-analysis npx tsx scripts/osm-prewarm.ts --estado 09`
   The prewarm reads `mun_polygons` read-only as `postgres`, so it does not need
   step 1; the grant is needed only for the API's cold path (first request
   for a municipio that is not cached yet).

### Incident 2026-09-28 01:27 UTC

A qa-auditor worst-case probe ran the original `ST_Buffer` corridor SQL
against a self-crossing scribble with a 60 s timeout on the live cluster.
The backend grew to 12.4 GB and the kernel OOM-killed it. Postgres then
reset every connection for about 0.5 s. The postmaster survived and the data
is intact. This probe is why counting no longer calls `ST_Buffer` and why
the shape and area guards run before any SQL. Lesson: adversarial or
worst-case probes go to a throwaway Postgres instance, never the live
cluster.

### Round-2 audit — deferred

- **N3** lock takeover race: two builders can both judge a stale lock
  stale and both rebuild. API vs CLI only; the cost is one duplicate build.
- **N5** the street-geometry handler sweeps the real cache dir when the
  module is imported, so its tests are not hermetic.
- **N7** `coverCells` runs twice per request (validation, then SQL build),
  ~20 ms.
- **N8** the prewarm CLI skips the cache-budget check (operator tool).
- **R2** `X-Api-Key` is exempt from the corridor limiter, consistent with
  the other analytics routes; revisit if the key leaks.

### Caveats

- Until `ops/denue-stale-cleanup.sh` runs, stale-CLEE rows inflate corridor
  counts by the same share as every other analytic.
- `osmium extract --strategy simple` can drop the parts of ways that cross
  the padded (0.01°) municipio bbox. A street that runs past the municipio
  edge comes back clipped near the boundary.
- The cold path (first request for a municipio) needs the grant. Without it,
  every uncached municipio returns 502 `postgres.error`, and hot caches keep working.
- Sage digests cap row bytes at 4 KiB, so a street-geometry digest usually
  shows only the first match's scalar fields; the geometry gets trimmed.
  `row_count` and the `length_m` stats still cover all matches.
