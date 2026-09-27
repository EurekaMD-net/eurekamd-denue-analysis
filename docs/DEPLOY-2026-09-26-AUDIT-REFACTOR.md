# Deploy: audit refactor 2026-09-26

Branch `audit-refactor-2026-09-26` merges the five audit lanes onto `main`
(047c848), in this order: `audit/backend` (the base), `audit/sage`,
`audit/edge`, `audit/loaders`, `audit/web`. Each lane has its own merge
commit, and three integration fixes follow.

Gates: root `tsc --noEmit` clean, root vitest 89 files / 1704 tests pass;
web `tsc --noEmit -p tsconfig.json` clean, web vitest 23 files / 284 tests
pass. Files changed after the last full run were re-run scoped:
`scripts/migrations/002-grants-lockdown.test.ts` and
`web/src/modes/SageMode.dom.test.tsx`.

Main checkout: `/root/claude/projects/data-intelligence/denue-data-analysis`.
Every command below spells out the full path.

---

## (a) What changed

### Integration commits

| Commit | What |
| --- | --- |
| 68b2d38 | Merge `audit/sage` (clean) |
| 589b658 | Merge `audit/edge` (clean) |
| 5325a58 | Merge `audit/loaders`. Conflicts: `scripts/load-censo.ts` keeps the loaders' single-transaction reload plus the backend's #118 index; `src/db/materialized-views.sql` keeps the backend's service_role/denue_sage summary-MV grants and drops the `mv_coverage` grant to anon/authenticated (#111-#113). Censo tests aligned. |
| f4f446d | Merge `audit/web`. Conflicts: `web/vite.config.ts` keeps `sourcemap: false` (edge) and `manualChunks` (web); `web/src/api/sage-client.test.ts` (add/add) keeps both lanes' tests. |
| 0f9d486 | Cross-lane contract fixes: the sage allow-list parser now sees the DO-block GRANT for `osm_ageb_aggregates`; test JWTs carry `uncharted` membership; the pipeline test asserts #40's municipio; the web test literal gets the now-required `truncated`. |
| 185a993 | SINBA reload now drops `mv_sinba_morbidity_municipal` before its view and recreates it. Without this, once 018 is applied, every SINBA reload fails on the dependency (backend #140 assumed CASCADE, which loaders #145 removed). |
| 7126bc9 | 002 also revokes `mv_sinba_morbidity_municipal` (created by 018 under postgres' default ACL, which grants trustr_app). |

### Packages

| Package | Lane | Commit | Change |
| --- | --- | --- | --- |
| P07 | backend | df9d4ca | Analytics on a shared async psql runner (no event-loop stalls, no SQL in errors) |
| P08 | backend | fd12715 | search/sectors/summary/tiles/layers/clusters on the psql runner so statement_timeout applies |
| P06 | backend | a86346b | Real pharmacy / operating-CLUES counts, deterministic AGEB ranking, primary mortality years |
| P18 | backend | 6e9e954 | One round-trip per handler, fast boot resolvers, sargable muni filters, SINBA MV (018) |
| P19 | backend | ee05e79 | Edge-input correctness (rural AGEBs, pseudo-localities, ties, PEA basis, boundaries); 019 |
| P09-backend | backend | a62e1f1 | Index-backed, bounded radius and keyword search (009 trigram index) |
| P10-backend | backend | 1bcc4ca | /clusters returns centroids-only payload clustered on EPSG:6372 |
| P22 | backend | 9238919 | Low-zoom unfiltered heatmap tiles sampled by block; no margin on world-edge tiles |
| P21 | backend | c7fcefd | /sectors and /summary served from summary MVs (021) |
| P31 | backend | 7b56563 | API queries run as least-privilege `denue_api` (api-role.sql) |
| P23 | sage | 1095efc | Reject any backslash in gated SQL |
| P24-backend | sage | 3b8b4bd | Persist router/narrative exception turns (with 679ce62: thread ownership, 024) |
| P25 | sage | aacb596 | Router output_tokens floor (with 6419f04: one router call per turn, prompt cache, 025) |
| P03 | edge | d5c56e4 | Bearer JWTs must carry `app_metadata.apps` containing `uncharted` |
| P04 | edge | dac4d63 | Rate limits keyed on the real client (TRUST_PROXY) and principal |
| P15 | edge | af727e0 | No public sourcemaps; security headers, CSP report-only, minisu sandbox (Caddy snapshot) |
| P37 | edge | 5f76bb6 | systemd sandboxing for denue-analyzer |
| X-edge-hygiene | edge | d44fdb4 | Dependency advisories documented; API/rate-limit doc headers corrected |
| P13 | loaders | 7d51e32 | Raw-table reloads in one transaction; MVs/views no longer destroyed |
| P14 | loaders | 368c440 | SCIAN class from the current label, municipio from Ubicacion; 014 trigger + backfill |
| P02 | loaders | 8432185 | DENUE relations locked away from anon/authenticated/trustr_app; role timeouts (002) |
| P29 | loaders | 8b0acf2 | Every remaining loader reloads in one transaction |
| P30 | loaders | 77ecf23 | Loader inputs fail loudly on truncation, misalignment, double encoding or duplicates |
| P20 | loaders | 0978947 | Polygon cvegeo uniques, covering per-entidad index, duplicate-index drops (020) |
| P12 | loaders | 4521fdb | An estado is marked failed when its load/extract/write is incomplete |
| X-loaders-round2 | loaders | d07e552 | CLI guards and the COFEPRIS integrity gate fail loudly |
| P05-web / P09-web | web | a8df3ff | Stop national AGEB layer-values requests the API now rejects (#173) |
| P10-web | web | 0cffcd5 | Cluster centroids drawn once the style parses (with b10cfd9: circle layer, new contract) |
| P26 | web | f93184c | Map survives token refresh and basemap toggle; legend matches its colouring |
| P27 | web | af6283b | Layout survives route errors; stale-chunk reload; login does not load echarts |
| P28 | web | 8916a56 | Locust charts redraw cleanly, show Z in tooltips, no wasted refetches |
| P33 | web | 5fdd8dd | API strings escaped in chart tooltips; legacy charts stop rebuilding every render |
| P34 | web | 938998d | Sage SSE stream exempt from the 30 s client timeout |
| P35 | web | ff76346 | ?entidad/?sector survive mode switches; deep links stop churning the URL |
| P36 | web | f6e9c5d | Sage streams stop on page exit; errors classified by status; fewer re-renders |
| P24-web | web | 8b1b28a | Drop Sage threads the server no longer exposes; restore persisted turn errors |
| X-web-fields-contract | web | 6cd34fc | Locust field labels match the backend; catalog keys pinned to the API contract |

These lane commits are merged too, but no package step names them:
6e0b45e (tiles: payload trim, index-scan plan, in-process LRU; #100 #136 #52),
d5d8df3 (Sage SQL and thread store on the async runner; #79 #104 #202 #88 #208 #90 #206),
53462cc (Sage digests keyed endpoint bodies; #76 #201 #81 #87 #209 #77 #86),
cdf52fc (web: abort cancelled queries, allow '..' in search text; #176 #199).

---

## (b) Operator runbook

Scripted: `ops/deploy-audit-refactor.sh` (`push`, `tag <emails>`, `deploy [--hold-heavy]`,
`heavy`, `gotrue`, `verify`, `all`) runs steps 0-8 and the step-11 smoke with a
confirmation before each change. Steps 9 and 10 stay manual.

Step 1b (G1 user tagging) runs at least 1 h BEFORE the window. Everything
from step 2 to step 7 happens in **one window**. The live
`denue-analyzer` runs `npx tsx --env-file=.env scripts/serve.ts` straight
from the main checkout, and `denue-matview-refresh.timer` (daily at about
04:02 UTC) runs `scripts/refresh-matviews.sh` from the same place. After the
merge, that script refreshes `mv_sinba_morbidity_municipal`,
`mv_sector_summary` and `mv_estrato_por_entidad`, and those exist only
after 018 and 021. So the merge, the migrations and the restart must happen
together. Also, 009, 014, 019, 020 and 021 read the full ~13 GB
`establecimientos` heap, so run the window off-hours.

### Step 0: protect .env

```
chmod 600 /root/claude/projects/data-intelligence/denue-data-analysis/.env
```

### Step 1: read-only pre-flight

```
# (P02) world-readable .env files anywhere under /root/claude: chmod 600 each one listed
find /root/claude -maxdepth 5 -name '.env' -perm /o+r -print
# (P02) nobody outside DENUE reads the relations 002 locks down (expect no output)
grep -rlE 'rest/v1/(ageb_polygons|mun_polygons|ent_polygons|loc_polygons|establecimientos)' /root/claude --include=*.ts --include=*.tsx --include=*.js --exclude-dir=node_modules --exclude-dir=dist | grep -v denue-data-analysis | grep -v denue-wt
# (P04) must print 0: EnvironmentFile overrides a drop-in Environment=
grep -c '^TRUST_PROXY=' /root/claude/projects/data-intelligence/denue-data-analysis/.env
# Keep the nightly refresh from firing mid-window (restarted in step 8)
systemctl stop denue-matview-refresh.timer
```

Also confirm, outside the shell:
- (P02) No other app on the shared instance needs longer queries under
  anon (3 s), authenticated (8 s) or service_role (30 s). DENUE's own
  service_role callers that page through `establecimientos` with OFFSET
  could reach 30 s on a large entidad: `src/analysis/geojson-export.ts`,
  `top-municipios.ts`, `sector-summary.ts`.
- (P03) No other EurekaMD app relies on GoTrue self-signup (section G2).
- (P03) The list of emails that should keep access (section G1).

### Step 1b: section G1, tag the allowed users (at least 1 h before step 2)

Live, 0 of 15 users carry `app_metadata.apps`. The new code (P03) rejects
a bearer JWT without `uncharted` in it, and a JWT only picks up the tag
when it is next issued: at sign-in, or at the hourly token refresh. Tag
the users at least 1 h before step 2, so every open session already
carries the tag when the new code starts. Tagging later means up to 1 h
of 401s after the step-7 restart. Also, from step 2 on the new code is on
disk, and the unit has `Restart=always`, so an unplanned restart at any
point after the merge already enforces the tag.

```
docker exec supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "UPDATE auth.users SET raw_app_meta_data = jsonb_set(coalesce(raw_app_meta_data,'{}'::jsonb), '{apps}', coalesce(raw_app_meta_data->'apps','[]'::jsonb) || '[\"uncharted\"]'::jsonb) WHERE email IN ('<allowed-1>','<allowed-2>')"
# expect the number of emails listed above
docker exec supabase-db psql -U postgres -d postgres -tA -c "SET default_transaction_read_only=on" -c "SELECT count(*) FROM auth.users WHERE raw_app_meta_data->'apps' ? 'uncharted'"
```

Rollback: none needed. The tag has no effect on the old code.

### Step 2: merge

```
cd /root/claude/projects/data-intelligence/denue-data-analysis && git merge --ff-only audit-refactor-2026-09-26
# (X-edge-hygiene) the stale, untracked root dist/ (2026-05-13; neither unit uses it)
rm -rf /root/claude/projects/data-intelligence/denue-data-analysis/dist
```

Rollback (code): `cd /root/claude/projects/data-intelligence/denue-data-analysis && git reset --hard 047c848 && systemctl restart denue-analyzer && cd web && npm run build`.
The migrations below add roles, relations, columns and indexes. Beyond
that they revoke public-role grants (002), make `denue_sage` LOGIN and
drop only redundant or 0-scan indexes (020). None of them removes
anything the pre-merge code reads, so a code rollback needs no DB
rollback.

### Step 3: DB roles and grants (before any code runs)

```
# (P01 code is in this merge, see (c)) denue_sage becomes LOGIN (no password),
# 8 s timeout, read-only default. It is NOLOGIN live today, so Sage SQL fails until this runs.
# (P01 round 2, c33842d) also sets app.service_role_key and app.webhook_url to '' for denue_sage sessions
# and revokes the SQL-string/file functions (ts_stat, *_to_xml, pg_read_file, ...) from PUBLIC.
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < /root/claude/projects/data-intelligence/denue-data-analysis/scripts/sage-role.sql
# (P31) denue_api: the role every psql-backed endpoint now logs in as. Without it: 502 everywhere.
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < /root/claude/projects/data-intelligence/denue-data-analysis/scripts/api-role.sql
```

Running api-role.sql first means 018, 019 and 021 grant `denue_api`
themselves. The first run prints a NOTICE for the relations those
migrations have not created yet. That is expected. 002 runs in step 4,
after the migrations that create relations.

### Step 4: schema migrations (every scripts/migrations/*.sql, in dependency order)

```
M=/root/claude/projects/data-intelligence/denue-data-analysis/scripts/migrations
# (P24) sage_threads.owner_sub + wider call_kind: the new code writes both
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < $M/024-sage-owner-callkind.sql
# (P25, commit 6419f04) sage_turns_audit cache-token columns: the new code writes both
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < $M/025-sage-audit-cache-cols.sql
# (P18) SINBA MV (the code falls back to the view without it; the refresh timer needs it)
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < $M/018-mv-sinba-morbidity.sql
# (P19) required: locust-muni reads censo_municipios.p_12ymas. Its last statement is CREATE INDEX CONCURRENTLY, outside the txn
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < $M/019-censo-views-treemap-geoms.sql
# (P21) required: /sectors and /summary return 502 without these MVs. Initial REFRESH = two full GROUP BYs; not during a loader run
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < $M/021-summary-mvs.sql
# (P02) revoke DENUE relations from anon/authenticated/trustr_app, polygon tables OWNER TO postgres.
# Runs AFTER 018/019 because postgres' default ACL grants trustr_app arwdDxt on every relation
# they create (mv_sinba_morbidity_municipal, the recreated mv_national_treemap).
# The role statement_timeouts in this file are a Postgres-instance change (section P).
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < $M/002-grants-lockdown.sql
# (P06) polygon filter index. Optional: seq-scan fallback of about 20-50 ms
docker exec supabase-db psql -U postgres -d postgres -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ageb_polygons_ent_mun ON ageb_polygons (cve_ent, cve_mun)"
# (P09) trigram index for /search: several minutes of IO; must precede 020 (020 drops idx_estab_nombre)
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < $M/009-trgm-index.sql
docker exec supabase-db psql -U postgres -d postgres -tA -c "SELECT indisvalid FROM pg_index WHERE indexrelid='idx_estab_nombre_trgm'::regclass"
#   false -> DROP INDEX CONCURRENTLY idx_estab_nombre_trgm; then re-run 009
# (P14) updated_at trigger, then the per-entidad SCIAN/municipio backfill (commits per entidad; re-runnable),
# then refresh every MV. Needs 018 + 021 in place. Leaves about 6.1M dead tuples (P17 compaction is deferred, see (d))
cd /root/claude/projects/data-intelligence/denue-data-analysis && docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/014-estab-updated-at-trigger.sql && docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/014-estab-scian-municipio-backfill.sql && ./scripts/refresh-matviews.sh
# (P20) index hygiene: after 009, and after 014 so its final VACUUM clears the backfill's dead tuples
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < $M/020-indexes.sql
```

Notes:
- P20's brief puts 020 after P17's compaction, which is deferred. The code
  does not need 020 or 014, 009 or the P06 index to start. If the window
  is too short, hold 009, 014 and 020 (in that order) for a later
  off-hours slot. Holding them breaks nothing. Without 009, `/search`
  keyword queries stay slow.
- If 020 is interrupted, its validity guard stops before any DROP. Run
  `DROP INDEX CONCURRENTLY <the INVALID index it names>`, then re-run 020.
  The guard also stops 020 when 009's `idx_estab_nombre_trgm` is missing
  or INVALID, so `idx_estab_nombre` is never dropped before /search has
  its replacement.

### Step 5: section G (GoTrue / auth), clearly separate

G1 (user tagging) already ran in step 1b.

**G2: close self-signup (independent of the code; do it after confirming
no other app needs it).** Record the current values first:

```
grep -E '^(DISABLE_SIGNUP|ENABLE_EMAIL_AUTOCONFIRM)=' /opt/supabase/.env
# set DISABLE_SIGNUP=true and ENABLE_EMAIL_AUTOCONFIRM=false in /opt/supabase/.env, then:
cd /opt/supabase && docker compose up -d auth
```

Rollback: restore the two recorded values in `/opt/supabase/.env`, then `cd /opt/supabase && docker compose up -d auth`.

### Step 6: section S (systemd), clearly separate

The drop-ins take effect at the single restart in step 7. Apply them only
after the merge: the new code is what reads TRUST_PROXY.

```
mkdir -p /etc/systemd/system/denue-analyzer.service.d
# (P04) real client IP from the rightmost X-Forwarded-For (the live unit lacks this line; the repo copy has it)
printf '[Service]\nEnvironment=TRUST_PROXY=1\n' > /etc/systemd/system/denue-analyzer.service.d/trust-proxy.conf
# (P37) sandboxing
printf '[Service]\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=full\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nLockPersonality=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK\n' > /etc/systemd/system/denue-analyzer.service.d/hardening.conf
systemctl daemon-reload
```

Rollback: `rm /etc/systemd/system/denue-analyzer.service.d/trust-proxy.conf /etc/systemd/system/denue-analyzer.service.d/hardening.conf && systemctl daemon-reload && systemctl restart denue-analyzer`.

### Step 7: the single restart

```
systemctl restart denue-analyzer && sleep 20 && systemctl is-active denue-analyzer && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3030/health
SINCE="$(systemctl show -p ActiveEnterTimestamp --value denue-analyzer)"
journalctl -u denue-analyzer --since "$SINCE" --no-pager -o cat | grep -E 'TRUST_PROXY|current_ano resolved from data:|fell back to static'
# expect 2 (risk-summary + mortality-summary), then 0
journalctl -u denue-analyzer --since "$SINCE" --no-pager -o cat | grep -c 'current_ano resolved from data:'
journalctl -u denue-analyzer --since "$SINCE" --no-pager -o cat | grep -c 'current_ano resolver fell back to static'
systemd-analyze security denue-analyzer | tail -1
```

Expected: `active`, `200`, the boot line `client IP: rightmost X-Forwarded-For (TRUST_PROXY on)`,
`risk-summary default current_ano resolved from data: <year>` and
`mortality-summary default current_ano resolved from data: <year>`, so the
counts print `2` then `0`. Those two resolvers are the first queries
through the `psql -f -` stdin transport against the live container. A
`fell back to static` line means they failed (DB unreachable, a missing
role or GRANT), even though `/health` returned 200.

### Step 8: the single web build, then re-arm the timer

The backend (P08 grain=ageb 400, P10 cluster contract) and the SPA (P05,
P10-web) must go live together, so build right after the restart.

```
cd /root/claude/projects/data-intelligence/denue-data-analysis/web && npm run build
systemctl start denue-matview-refresh.timer
```

Rollback: covered by the code rollback in step 2.

### Step 9: section C (Caddy), clearly separate

1. Paste the header block, the `@maps` 404 matcher and the minisu-catalog
   sandbox headers from `/root/claude/projects/data-intelligence/denue-data-analysis/ops/Caddyfile.uncharted`
   into the `uncharted.eurekamd.cloud` block of `/etc/caddy/Caddyfile`. The
   `@maps path *.map` and `respond @maps 404` lines go INSIDE the existing
   `handle /assets/*` block, above its `file_server`. At site level they
   would serve the .map with a 200.
2. Validate, reload and commit:

```
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy && cd /etc/caddy && git commit -am 'uncharted: security headers, CSP report-only, block sourcemaps, sandbox minisu-catalog'
```

Rollback: `cd /etc/caddy && git revert --no-edit HEAD && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy`.

Later, after a clean report-only period: change `Content-Security-Policy-Report-Only`
to `Content-Security-Policy`, then validate, reload and commit again.

### Section P (Postgres instance / shared GoTrue secrets), clearly separate

- 002 (step 4) sets instance-wide role defaults shared with other apps:
  anon 3 s, authenticated 8 s, service_role 30 s `statement_timeout`.
  Before this, none of these roles had one.
  Rollback: `docker exec supabase-db psql -U postgres -d postgres -c "ALTER ROLE anon RESET statement_timeout" -c "ALTER ROLE authenticated RESET statement_timeout" -c "ALTER ROLE service_role RESET statement_timeout"`.
  Do not roll back the revokes, which are a security fix. If an outside
  consumer breaks, grant that one relation explicitly.
- Required by step 10 (c) for #110 (and P02 step 4, the old 644 `.env`):
  set a new `JWT_SECRET` in `/opt/supabase/.env`, then re-sign both
  `ANON_KEY` and `SERVICE_ROLE_KEY` there with it. Those are the three
  names `/opt/supabase/docker-compose.yml` reads. `SUPABASE_JWT_SECRET` is
  the name in the app `.env` files, and setting it in `/opt/supabase/.env`
  rotates nothing. This
  reissues the anon and service keys for **every** app on the instance.
  Rollback: none once keys are reissued, so plan it with every app owner.
- Optional later (P03): add `GOTRUE_JWT_ISSUER: ${API_EXTERNAL_URL}/auth/v1`
  to the auth service in `/opt/supabase/docker-compose.yml` so tokens carry
  `iss`. A follow-up can then make the `iss` check strict.
  Rollback: remove the line, then `cd /opt/supabase && docker compose up -d auth`.

### Step 10: #110 durable fix (section K, shared-instance secrets)

Step 3 (`sage-role.sql`) masks the database-level settings
`app.service_role_key` and `app.webhook_url` for `denue_sage`, so no SQL
that reaches Sage can read them. The value itself still sits in
`pg_db_role_setting` for database `postgres`, which every role can read
(`current_setting()`, and the catalog is PUBLIC-readable), and it was
readable before this deploy. That is the durable part of critical finding
#110, and it has three parts. (c) is not optional.

(a) Read-only check: which functions still read the key.

```
docker exec supabase-db psql -U postgres -d postgres -tA -c "SET default_transaction_read_only=on" -c "SET statement_timeout='20s'" -c "SELECT n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosrc ILIKE '%service_role_key%'"
```

On 2026-09-27 this prints `public.notify_jarvis`, the mission-control
trigger function on `tasks`, `goals`, `objectives` and `journal_entries`.
It reads `current_setting('app.service_role_key', true)` and sends it as
the `Bearer` of its `net.http_post` to `app.webhook_url`.
`supabase_vault` is not installed. Coordinate with the mission-control
owner: move the key `notify_jarvis()` sends to storage that PUBLIC cannot
read, then run (a) again. Run (b) only when (a) prints nothing. If you
run it earlier, the triggers do not fail (they pass `missing_ok`), but
the Jarvis webhook gets an empty bearer.

(b) Remove the key from the database. Of the two dotted settings stored
on database `postgres`, only `app.service_role_key` holds a secret.
`app.webhook_url` is a URL with no credential in it (read-only check,
2026-09-27), and `notify_jarvis()` still needs it, so it stays.

```
docker exec supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE postgres RESET app.service_role_key"
# expect 0 rows
docker exec supabase-db psql -U postgres -d postgres -tA -c "SET default_transaction_read_only=on" -c "SELECT s.setdatabase FROM pg_db_role_setting s, unnest(s.setconfig) c WHERE c LIKE 'app.service_role_key=%'"
```

Rollback: none. Once the key is rotated in (c) the old value is useless,
and restoring it would expose it again.

(c) **Coordination required, not optional**: rotate the service_role key
with every app owner on the shared Supabase instance (db.mycommit.net).
Any role on the instance, and any Sage user before this deploy, could read
it, and it bypasses RLS for every project there. A service_role JWT
re-signed with an unchanged JWT secret leaves the leaked one valid, so
this is the JWT-secret rotation in section P, which reissues the anon and
service keys for every app. In `/opt/supabase/.env`, set a new
`JWT_SECRET`, re-sign `ANON_KEY` and `SERVICE_ROLE_KEY` with it, and run
`cd /opt/supabase && docker compose up -d`. Then each app owner updates
that app's copies of the JWT secret, the service key and the anon key
(and the copy that `notify_jarvis()` now reads) and restarts it. DENUE has
three:

- `.env` `SUPABASE_JWT_SECRET` = the new `JWT_SECRET`. `scripts/serve.ts`
  reads it for the HS256 bearer check, so while it is stale every /api
  request with a user bearer gets 401.
- `.env` `SUPABASE_SERVICE_KEY` = the new `SERVICE_ROLE_KEY`.
- The web anon key = the new `ANON_KEY`. Vite bakes it in at build time
  (`web/src/lib/supabase.ts`: `VITE_SUPABASE_ANON_KEY`, else
  `DEFAULT_SUPABASE_ANON_KEY`), so while it is stale GoTrue rejects the
  SPA's login and refresh calls. Update `DEFAULT_SUPABASE_ANON_KEY` in a
  commit (a build-time `VITE_SUPABASE_ANON_KEY` would have to be repeated
  on every later build), then rebuild.

```
cd /root/claude/projects/data-intelligence/denue-data-analysis && systemctl restart denue-analyzer && sleep 20 && systemctl is-active denue-analyzer && cd web && npm run build
```

Then re-run the P01 and P03 checks in step 11.
Rollback: none once keys are reissued, so schedule it with every owner.

### Step 11: verification (read-only)

Run the SQL checks read-only:
`docker exec supabase-db psql -U postgres -d postgres -tA -c "SET default_transaction_read_only=on" -c "SET statement_timeout='20s'" -c "<query>"`.

```
# (P31) smoke every psql-backed route: expect 200 on every line (the tile may be 204 if empty).
# A 4xx means a wrong path or key, a 5xx a server fault; "permission denied for" in the journal means a missed GRANT
(cd /root/claude/projects/data-intelligence/denue-data-analysis && API_KEY=$(grep -E '^API_KEY=' .env | cut -d= -f2-); for p in /entidades /sectors /summary/sector/46 /summary/entidad/09 '/analytics/municipios?entidad=09' '/analytics/agebs-by-municipio?cve_mun=09007' '/analytics/ageb-detail?cvegeo=0900700010010' '/analytics/risk-summary?entidad=09' '/analytics/mortality-trend?cve_mun=09007' '/analytics/localities-by-municipio?cve_mun=09007' '/search?q=farmacia&limit=5' '/tiles/10/230/455'; do curl -s -o /dev/null -w "%{http_code} $p\n" -H "X-Api-Key: $API_KEY" "http://127.0.0.1:3030$p"; done)
```

- (P01, #110) Sage logs in as a non-superuser whose session cannot read the
  masked settings:
  `docker exec supabase-db psql -U denue_sage -d postgres -tAc "SELECT current_user, current_setting('is_superuser')"` prints `denue_sage|off`;
  `docker exec supabase-db psql -U denue_sage -d postgres -tAc "SELECT length(current_setting('app.service_role_key', true)), length(current_setting('app.webhook_url', true))"` prints `0|0`
  (any other number means the key is readable: re-run `sage-role.sql`).
  One live Sage question that takes the SQL route returns a table.
- (P07) During a heavy `agebs-by-municipio?cve_mun=09007` request,
  `time curl -s http://127.0.0.1:3030/health` stays at a few ms.
  `SELECT application_name, count(*) FROM pg_stat_activity WHERE application_name LIKE 'denue-%' GROUP BY 1`
  shows the tagged sessions (P08 tags too).
- (P19) `SELECT count(*) FROM ageb_polygons WHERE NOT ST_IsValid(geom)` = 0;
  `SELECT count(*) FROM mv_national_treemap` = 32;
  `has_table_privilege('denue_sage','mv_national_treemap','SELECT')` = t; EXPLAIN ANALYZE of
  `SELECT count(*) FROM censo_localidades WHERE cve_mun='09007'` uses `idx_censo_iter_cve_mun_loc`.
- (P21) `SELECT to_regclass('mv_sector_summary'), to_regclass('mv_estrato_por_entidad'), (SELECT count(*) FROM mv_sector_summary)`.
- (P18) `SELECT to_regclass('mv_sinba_morbidity_municipal')` is not null.
- (P09) `EXPLAIN ANALYZE ... WHERE nombre ILIKE '%xyzzyqq%' ORDER BY clee LIMIT 50` shows a Bitmap Index Scan on `idx_estab_nombre_trgm`, under 1 s.
- (P20) `EXPLAIN (ANALYZE, BUFFERS) SELECT sector_actividad_id, count(*) FROM establecimientos WHERE entidad='15' GROUP BY 1` shows an Index Only Scan on `idx_estab_ent_mun_cov`, with Heap Fetches near 0.
- (P14) `SELECT count(*) FROM establecimientos WHERE entidad='09' AND clase_actividad_id='464111' AND clase_actividad NOT ILIKE '%farmacia%'`: 224 before, 0 after.
- (P02) `SELECT count(*) FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated','trustr_app') AND table_name IN ('ageb_polygons','mun_polygons','ent_polygons','loc_polygons','establecimientos','establecimientos_geo','mv_coverage')` = 0;
  `SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')` shows the three timeouts.
- (P03) A tagged user gets 200 on an /api route. An untagged user gets 401 with
  `{"error":"Unauthorized","code":"auth.bearer_invalid"}`, and
  `journalctl -u denue-analyzer | grep '\[auth\] bearer rejected'` shows the reason.
  Audit signups: `SELECT email, created_at FROM auth.users ORDER BY created_at DESC LIMIT 50`.
- (P04) Request lines for external traffic show distinct `ip=` values, not 127.0.0.1 or ::1.
- (P37) One Sage question and one /analytics request succeed under the sandbox.
- (P27) `ls -l web/dist/assets/index-*.js`; the gzip entry size is about 38 KB.
  Login, sign-out and a token refresh (a tab left open past about 1 h) all
  work. A /map tab from the previous deploy reloads itself once.
- (P15) `curl -sI https://uncharted.eurekamd.cloud/ | grep -iE 'strict-transport|x-frame|content-security|x-content-type'`;
  `ls /root/claude/projects/data-intelligence/denue-data-analysis/web/dist/assets/*.map 2>/dev/null | wc -l` prints 0;
  `curl -sI https://uncharted.eurekamd.cloud/minisu-catalog/index.html | grep -i content-security`.
  On /map, the browser console shows no CSP report-only violations (tiles, glyphs, sprites, workers, login).
- (P24/P25) Two Sage questions, then read `sage_turns_audit`. The Anthropic
  Sage path cannot start its CLI on this host today (musl binary ENOENT, no
  audit rows since 2026-05-11), so this check fails until that separate
  issue is fixed.

### Standing rules after this deploy

- Re-run `scripts/api-role.sql` after any loader reload that drops and
  recreates a view or MV the API reads. Loader `postLoadGrants` restores
  only `denue_sage`, not `denue_api`, so the affected endpoints return 502
  until it runs (P31).
- The SINBA and Censo loaders now recreate their dependents in their own
  transaction: `mv_sinba_morbidity_municipal` (185a993) and the three censo
  views from `migrate-censo-views.sql`. Earlier lane notes said to re-run
  018 or `migrate-censo-views.sql` after a reload. That no longer applies.
- Re-run `scripts/sage-role.sql` after any new `ALTER DATABASE ... SET` of
  a dotted setting (`app.*`). The masking in it applies only to the
  settings stored when it last ran (P01 round 2).
- Re-running `sage-role.sql` or `perf-matviews.sql` drops `denue_sage` on
  `mv_sinba_morbidity_municipal`. This is harmless: Sage's catalog lists
  the view.
- Future polygon reloads must re-create `<layer>_polygons_cvegeo_uq` (step 3
  of the recipe in `backfill-ageb.ts`).
- The first real reload of each loader after this deploy is its production
  check (P29). The changed loaders take effect on their next run (P30).
  `osm-refresh.timer` is still not installed.

### Follow-ups outside the window

- (X-loaders-round2) Before d07e552, `scripts/extract.ts` printed a
  UUID-shaped DENUE_TOKEN example, and it is in git history. Compare it
  with `DENUE_TOKEN` in `.env`. If it matches, rotate the token at INEGI.
- (X-loaders-round2) The COFEPRIS integrity gate never passed before
  d07e552, so `cofepris_farmacias` was never gated. On the next refresh,
  run `python3 scripts/cofepris-geocode.py`, then
  `npx tsx --env-file=.env scripts/load-cofepris.ts --csv-path=/tmp/cofepris/farmacias_geocoded.csv --force`.
- (X-edge-hygiene, maintenance window) Bump hono to ^4.13.5,
  @hono/node-server to ^2.0.10 and @anthropic-ai/claude-agent-sdk to
  >=0.2.141. Then run `npm audit --omit=dev` (expect 0), tsc, the Sage
  provider and API tests, and restart. The plan is in
  `docs/AUDIT-2026-09-26-DEPENDENCIES.md`.
- (P12, informational) `data/state/pipeline-state.json` still lists estado
  29 as done with 24,711 of 98,711 records. The rows were reloaded by hand
  (98,729 live). Optionally, mark it failed and use `--retry-failed`.
- (P02, not DENUE's) `public.schema_migrations` (GoTrue) and
  `jarvis_kb_backup` (mission-control) still give anon full write with RLS
  off, and `kb_entries` still grants authenticated and trustr_app
  arwdDxt. Their owners should decide.
- If `src/db/scian_clase_catalog.json` is regenerated
  (`npx tsx scripts/gen-scian-clase-catalog.ts`), regenerate the VALUES
  list of the 014 backfill too.

---

## (c) Packages that did not ship (audit RED)

Their final audit verdict was RED, but **their commits are in this branch**:
the lane branches contain them, and later commits in the same lane build
on them. Shipping this branch ships them. To hold them back, they must be
reverted and the later commits reworked. A plain `git revert` of 4c15ce1
does not stand alone, because d5d8df3 runs the gate through the
`denue_sage` runner options it introduced.

Round 2 reworked all three on this branch (c33842d, 15fecc0, acb21f5).
Their operator steps are already in the runbook: `sage-role.sql` (step 3),
the restart (step 7), the web build (step 8), and for P01 the #110 durable
fix (step 10) and its checks (step 11).

| Package | Commits in branch | Last fix round (from the lane) |
| --- | --- | --- |
| P01 (Sage SQL gate: non-superuser, tokenizer, denylist) | 4c15ce1, 937a529, c33842d | #110 was still open because `ts_stat`/`ts_rewrite` were missing from the denylist; 937a529 adds them to FORBIDDEN_FUNCTIONS, a follow-up commit, history not rewritten. Round 2 (c33842d) masks the secrets for `denue_sage` in `sage-role.sql` (step 3) and decodes U& identifiers. The durable fix is step 10. |
| P11 (Sage 200-row cap truncation) | c5928c4, 15fecc0 | The SQL path lost the true count. The digest is now `{...buildDigest(rows), truncated}` when `fetched > cap`. Round 2 (15fecc0): the endpoint route sends `truncated: false`, so an exact 570-row total no longer shows as "570+". |
| P16 (sign-out drops the session) | f108dd7, 70e2815, acb21f5 | #192: the `signOut({scope:'local'})` fallback failed the same way, so it was removed. On `{error}`, `signOut` warns without the token and deletes the `sb-*-auth-token` keys itself. Round 2 (acb21f5) drops the `stopAutoRefresh()` call, which left a same-tab re-login without token refresh. |

---

## (d) Deferred (operator decisions)

- Audit findings #105, #116, #162, #128, #153, #212: not addressed by any lane.
- P17: VACUUM FULL compaction of `establecimientos`. It matters more after
  014's backfill, which leaves about 6.1M dead tuples, and P20 was
  sequenced after it.
- P32: node-postgres connection pool, to replace the per-query psql runner.
- P38: Postgres instance tuning (shared instance).
