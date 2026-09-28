# DENUE national refresh (edition 05/2026)

Operator runbook for `ops/denue-refresh.sh`. It re-extracts all 32 estados (~6.1M rows) from the
INEGI DENUE API and upserts them into `establecimientos`. The data loaded now is edition 11/2025
(inferred); this run brings 05/2026.

## Design

- **Survives disconnects.** `start` launches a transient systemd unit, `denue-refresh`, with
  `systemd-run`. The unit belongs to PID 1 and not to the terminal, so an SSH drop, a closed Panel
  tab or a Claude session ending does not stop it. The unit runs `ops/denue-refresh.sh _worker`.
- **Resumes after a crash.** `scripts/pipeline.ts` keeps its progress in
  `data/state/pipeline-state.json`. Estados marked `done` are skipped. An estado left `running`
  goes back to `pending` at the next start and is re-extracted from page 1. The upsert is
  idempotent on `clee`. The worker runs `--all` first, then up to 4 rounds of `--retry-failed`,
  waiting 120 s, 600 s, 1800 s and 3600 s before each. If fewer than 32 estados are `done` after
  that, it exits non-zero and leaves the state file in place for `resume`.
  `OOMPolicy=continue` means an OOM kill of node does not stop the unit, so the retry loop
  handles it.
- **Truncation guard.** Before the post-steps, and again in `stale-report`, the script compares
  each estado's `records_extracted` with the archived previous run (`archived_state_file` in the
  baseline json). If any estado dropped by more than 3%, the worker exits 1 and lists those
  estados without running the post-steps, and `stale-report` refuses to run. A short extraction
  would otherwise flag live rows as stale. There are two ways forward:
  - Re-extract: set those estados to `failed` in `pipeline-state.json`, then `resume`.
  - Accept the drop as real: set `.truncation_ack=true` in the baseline json, then `resume`.
- **Handling the previous state file.** The May file shows all 32 estados `done`, so `--all`
  would skip everything. `start` moves the old file to `pipeline-state.<YYYY-MM of its
  created_at>.json` (here `pipeline-state.2026-05.json`), and the pipeline then creates a new one.
  `start` does this only when no run has been recorded yet, and it never overwrites an existing
  archive. This approach needs no code change, and a manual `pipeline.ts --status` still reads the
  current run. (`pipeline.ts` already accepts a `STATE_DIR` env var, but using it would leave
  manual `--status` pointing at the May file.)
- **Env.** Every call uses `node_modules/.bin/tsx --env-file=.env`, and the unit has no
  `EnvironmentFile=`. `pipeline.ts` also parses `.env` itself. The post-steps need no secrets.
  Because the unit never goes through `npx`, it does not need npm's HOME/cache. The unit sets
  `HOME` and `PATH` explicitly.
- **Raw files.** The unit sets `OUTPUT_DIR=data/raw`. Without it, `pipeline.ts` writes to
  `data/`. `status` and `stale-report` read that same `data/raw` path.
- **Log.** Output goes to `data/state/denue-refresh-2026-09.log` through
  `StandardOutput=append:`, which needs systemd 240 or later (this box runs 255). This file is
  gitignored, like all of `data/`.
- **Run record.** `data/state/denue-refresh-2026-09.baseline.json` holds: `edition`, the
  baseline (`count`, `min/max updated_at`), `run_start`, the archived state-file path,
  `timer_stopped`, `worker_runs[]`, the `post_steps` timestamps and `finished_at`.
- **The matview timer is paused for the run.** If `denue-matview-refresh.timer` is active, `start`
  stops it (it is not disabled) and records `timer_stopped: true`. The worker starts it again
  right after `finished_at`. If the timer was already inactive, the script records
  `timer_stopped: false` and leaves it alone.
  If the worker exits before `finished_at`, or you abandon the run, `denue-matview-refresh.timer`
  stays stopped; start it by hand with `systemctl start denue-matview-refresh.timer`. A reboot
  re-arms it (enabled). The timer is Persistent=true, so the worker's restart fires one immediate
  catch-up refresh (~5 min, harmless).

## Throttles and why

This VPS has 4 vCPU and 15 GB of RAM. It also runs mission-control, agentic-crm, supabase,
caddy and stalwart. Swap was fully used on 09-27.

| Property | Value | Why |
|---|---|---|
| `Nice` | 19 | Node CPU yields to the live services |
| `CPUQuota` | 150% | The client never takes more than 1.5 of the 4 cores |
| `MemoryHigh` / `MemoryMax` | 2560M / 3G | Measured on 09-27: parse, validate and transform for 750k rows peaks at 1.49 GB RSS. Edomex (15) has 816,586 rows, so expect about 1.65 GB. With the planned 1536M/2G, reclaim throttling would stall on Edomex and CDMX, and 2G would risk an OOM kill |
| `NODE_OPTIONS` | `--max-old-space-size=2048` | Inside the cgroup, Node 22 sizes the V8 heap from the memory caps. Measured on 09-27 at 2560M/3G: 1328 MB without the flag, 2096 MB with it. Edomex needs about 1.3 GB of heap, so without the flag it would hit heap OOM on every retry. `preflight` checks this in a throwaway unit, `denue-refresh-heapcheck` |
| `OOMPolicy` | continue | An OOM kill of node leaves the unit running, so the worker's retry loop handles it |
| `TasksMax` | 256 | Guard against a runaway fork |
| `IOSchedulingClass` | idle | **Has no effect on this box.** The disks use the `none`/`mq-deadline` schedulers, and idle priority is honoured only by BFQ. It is kept because it costs nothing |

**Limit of the cgroup throttles.** They cover only the client processes: tsx/node, bash and the
docker CLI. Kong and PostgREST are outside the cgroup too. `service_role` has
`statement_timeout=30s`, so a slow batch fails its estado, and the retry loop re-extracts it. The
database work runs in the `supabase-db` container's cgroup and is not throttled:
upserts, the maintenance of 12 indexes (including the trigram GIN), the geometry UPDATE, the
backfill and the VACUUM. On the database side, the load is kept low by how the work is paced:

- One estado at a time (`--concurrency=1`).
- Batches of 200 rows, sent one after another.
- 500 ms between API pages (the delay in `pipeline.ts`).
- `vacuum_cost_delay = 2ms` on the manual VACUUM. This is autovacuum's pace; a manual VACUUM
  runs unthrottled by default.

**Transfer volume.** The 09-04 suspension came from a 289 GB bulk pull. This run is paged API
calls. Colima's file works out to about 578 B per record, so the full set is about 3.5 GB of JSON
on disk, spread over about 11 h. That is far below the >20 GB / >30 min full-CPU line.

## Command sequence

Run as root, from any directory:

```bash
cd /root/claude/projects/data-intelligence/denue-data-analysis
bash ops/denue-refresh.sh preflight          # read-only; all OK + baseline count
bash ops/denue-refresh.sh start --dry-run    # shows the archive move + the exact systemd-run
bash ops/denue-refresh.sh start              # asks once, then launches; safe to close the terminal
bash ops/denue-refresh.sh status             # any time
tail -f data/state/denue-refresh-2026-09.log # live (progress lines use \r)
```

If the unit dies (crash, OOM, reboot), or after `stop`:

```bash
bash ops/denue-refresh.sh resume
```

If you stopped the unit during the post-steps, their SQL keeps running inside supabase-db. Wait
for `pg_stat_activity` to drain before you resume. `resume` refuses while a VACUUM, an
`UPDATE establecimientos` or a `REFRESH MATERIALIZED` session is active, and prints those
sessions.

`resume` skips estados already `done` and post-steps already recorded.

When the unit finishes, it has run these post-steps in order. Each is recorded in the baseline
json:

1. `geometry`: the loader's `updateGeometry()`. The upsert never sends `geom`. This step sets it
   for new rows and rewrites it for rows whose coordinates moved. It runs first because the ageb
   backfill needs `geom`. (`pipeline.ts` only does this with `--update-geom`, and only at the end
   of the process that loaded rows, which a resume can miss.)
2. `ageb_backfill`: `scripts/backfill-ageb.ts --entidad=01..32`, one at a time. It fills only
   rows where `ageb IS NULL`.
3. `vacuum`: `VACUUM (ANALYZE, PARALLEL 0) public.establecimientos`. `PARALLEL 0` is required
   because supabase-db has only 64 MB of `/dev/shm`.
4. `matviews`: `scripts/refresh-matviews.sh`.
5. `finished_at` is written, then `denue-matview-refresh.timer` is started again if `start`
   stopped it.

## Next morning

1. Run `bash ops/denue-refresh.sh status`. Expect the unit inactive, `estados done: 32/32`, and
   all four post-steps plus `finished_at` set. If the unit is inactive but the run is not
   finished, check the log tail and `journalctl -u denue-refresh -n 50`, then run `resume`.
2. Run `bash ops/denue-refresh.sh stale-report` (read-only). It prints stale candidates per
   entidad, the total, and its percentage of the baseline, and writes the CLEE list to
   `data/state/denue-refresh-2026-09.stale-clees.txt`. If the stale share is above 10%, suspect a
   short extraction. The >10% WARN is expected whenever INEGI re-keys CLEEs between editions (it did
   for 05/2026); confirm with `bash ops/denue-stale-cleanup.sh report` before treating it as a short
   extraction.
3. Spot-check with `curl -s http://127.0.0.1:3030/health` and a `/search` in the UI.
   `mv_coverage.last_updated_at` should have moved.
4. Keep `data/raw/*.json` (about 3.5 GB) until the stale decision is made. The stale report reads
   those files.
5. Remember that `geom` is now correct for moved establishments, but their `ageb` is still the old
   one, because the backfill fills only NULL. A spatial query by `ageb` can therefore still place a
   moved establishment in its old AGEB.

## Stale-row cleanup

`ops/denue-stale-cleanup.sh` deletes the rows listed in
`data/state/denue-refresh-2026-09.stale-clees.txt`, meaning CLEEs that are in the database but
absent from the 05/2026 extraction.

**Why 18.8% stale is expected for this edition.** INEGI re-keyed the CLEE of most establishments
between 11/2025 and 05/2026. The middle digits changed, while `denue_id`, `nombre` and the
coordinates stayed the same. The upsert is keyed on `clee`, so each re-keyed establishment now has
two rows: the old one (stale) and a new one created by this run. On 2026-09-27 the report showed
1,146,694 stale rows. Of these, 1,086,261 (94.7%) have a `denue_id` that also exists on a row
created by this run, so they are re-keyed duplicates. The other 60,433 are real departures. Every
estado extracted at least its previous count, and the truncation guard printed no warnings, so
deleting the stale rows removes duplicates and departures and nothing from the new edition.

**Deletion is by CLEE list, never by `updated_at`.** `updated_at < <run date>` also matches
14,422 live rows whose `raw_json` did not change this edition, because the trigger only moves
`updated_at` when `raw_json` changes. `report` prints that split. `backup` and `apply` load the
CLEE list into a session-private temp table and join on it.

Modes (run as root; every mode first runs the common guards):

| Mode | What it does |
|---|---|
| `report` (default, read-only) | Prints a per-estado table: stale rows in the DB, re-keyed (`denue_id` on a row created on or after the run date), real departures, new rows, and genuinely new rows (`denue_id` not among the stale rows). It asserts that every stale CLEE is in the DB and that none was created or updated by this run, and it estimates the backup size. It takes about 3 min. |
| `backup` | Streams `COPY` of exactly the stale rows through `gzip -1` into `data/state/denue-stale-2026-09.rows.csv.gz`. It needs at least 5 GB free, asserts that the row count equals the stale count, and prints the sha256 and size. If the file already exists with a matching count, it skips. |
| `apply` | Needs the backup with a matching count, then asks once. It runs one transaction per estado (01..32). Each transaction asserts that all of that estado's stale CLEEs are present, deletes them, and asserts the deleted count; on any mismatch it rolls back that estado and stops. An estado whose stale rows are already gone is skipped. Progress goes to `data/state/denue-stale-2026-09.cleanup.log`, and the per-estado counts go to the ledger `data/state/denue-stale-2026-09.cleanup.json`. After the last estado it runs `VACUUM (ANALYZE, PARALLEL 0)` with `vacuum_cost_delay=2ms`, then `scripts/refresh-matviews.sh`, and asserts that the final `count(*)` equals the `records_extracted` sum in `pipeline-state.json`. It stops `denue-matview-refresh.timer` if it is active, before the confirmation prompt. It starts the timer again after the final count check; an exit trap also starts it if `apply` fails or is aborted. Because the timer is `Persistent=true`, it may fire one extra matview refresh right after it is re-armed if 04:00 UTC passed during the run, which is harmless. It refuses to run without a terminal. On a resumed run it refuses if the backup's sha256 no longer matches the ledger, so a backup regenerated after the ledger exists fails that check; remove the ledger only if no estado has been deleted yet (its `.estados` is empty). |

Common guards:

- The `denue-refresh` unit is inactive, the baseline has `finished_at`, and `pipeline-state.json`
  shows 32/32 estados `done`.
- The stale file is newer than `finished_at`, is sorted and unique, and every line is a CLEE. One
  legacy row has a 27-character CLEE, so the check accepts 27 or 28 characters. Every CLEE's
  estado prefix is between 01 and 32.
- `count(*)` minus the extraction total equals the stale count minus the rows the ledger records
  as deleted. This means the DB has not changed since `stale-report`. There is one accepted
  exception, covered under "Interrupted apply" below.
- No client backend is busy on `establecimientos` or running `REFRESH MATERIALIZED`.

```bash
cd /root/claude/projects/data-intelligence/denue-data-analysis
bash ops/denue-stale-cleanup.sh report
bash ops/denue-stale-cleanup.sh backup
tmux new -s stale                       # apply is interactive and long: 32 transactions, a throttled VACUUM, ~5 min of matviews
bash ops/denue-stale-cleanup.sh apply   # reattach after a drop: tmux attach -t stale
```

**Interrupted apply.** To recover, rerun `apply`; no manual ledger edit is needed.

- Each estado commits on its own, so a crash or SSH drop loses at most the estado in flight. That
  estado either rolled back, or committed before its ledger entry was written.
- The committed-but-unrecorded case leaves `count(*)` short of what the ledger predicts. When that
  happens, the guards count, per estado outside the ledger, how many of its stale CLEEs are still
  present (read-only). They accept the shortfall only if it equals the stale count of the estados
  that have 0 left, and otherwise print the per-estado breakdown and refuse.
- On the rerun, those estados hit the SKIP branch (0 present), which records them in the ledger
  with `recovered: true`. Estados already in the ledger are skipped. The run then continues from
  the next estado.

**Rollback (after a complete apply).** Re-insert the backup inside the container:

```bash
zcat data/state/denue-stale-2026-09.rows.csv.gz \
  | docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
      -c "\copy public.establecimientos FROM STDIN WITH (FORMAT csv, HEADER)"
```

The CSV carries every column, including `id`. An `id` conflict is impossible because the deleted
ids are gone and the sequence only moves forward. The CLEE unique key is also free, because the
same rows were deleted. Then move the ledger away, because its guard would refuse with a negative shortfall:
`mv data/state/denue-stale-2026-09.cleanup.json{,.rolled-back-$(date +%s)}`. Finally, run `bash scripts/refresh-matviews.sh`.

**Rollback after a partial apply.** Some of the backup's CLEEs are still in the table, so the full
`\copy` above fails on the first one. Load the CSV into a temp table and insert only the missing
rows:

```bash
zcat data/state/denue-stale-2026-09.rows.csv.gz \
  | docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
      -c "CREATE TEMP TABLE t (LIKE public.establecimientos)" \
      -c "\copy t FROM STDIN WITH (FORMAT csv, HEADER)" \
      -c "INSERT INTO public.establecimientos SELECT * FROM t WHERE NOT EXISTS (SELECT 1 FROM public.establecimientos e WHERE e.clee = t.clee)"
```

Then move the ledger away, because its guard would refuse with a negative shortfall:
`mv data/state/denue-stale-2026-09.cleanup.json{,.rolled-back-$(date +%s)}`. Finally, run `bash scripts/refresh-matviews.sh`.

## Record the edition

After the load and the stale cleanup, record the edition and the final row count in
`dataset_versions` (migration 026). Without `--apply` the CLI only prints the SQL.

```bash
cd /root/claude/projects/data-intelligence/denue-data-analysis
npx tsx scripts/record-dataset-version.ts --dataset=denue --edition=<MM/YYYY> \
  --source="INEGI DENUE API" --rows=<count(*) after cleanup> --apply
```

## Known limitations

- **Stale detection uses the raw files, not `updated_at`.** `trg_estab_updated_at` (migration
  014) fires only when `raw_json` changes. A re-loaded row whose record did not change keeps its
  old `updated_at`, so `updated_at < run_start` does not mean the establishment closed.
  `stale-report` instead diffs every CLEE in the database against the CLEEs in this run's 32 raw
  files. Before diffing, it checks that each file is newer than `run_start` and that its record
  count matches the state file. For the same reason, the status counters "new" (`created_at`) and
  "changed-or-new" (`updated_at`) are informational only.
- **Stale rows are reported, never deleted.** Removing them is a separate operator decision,
  made with `ops/denue-stale-cleanup.sh` (see [Stale-row cleanup](#stale-row-cleanup)).
- **Moved establishments keep their old `ageb`.** The geometry step corrects `geom`, but
  `backfill-ageb` fills only NULL values.
- **No row records its edition.** The API returns an empty `fecha_alta`. The loaded edition is
  in the baseline json (`"edition": "05/2026"`) and in `dataset_versions` once it is recorded
  (see [Record the edition](#record-the-edition)).
- **Every upserted row is rewritten.** `ON CONFLICT DO UPDATE` always writes a new tuple
  version, whether or not the record changed. The trigger's `WHEN` clause controls only
  `updated_at`. So all 6.1M rows get a new version, and all 12 indexes (including the trigram GIN)
  get new entries.
  - Expect heap and index growth and about 6.1M dead tuples until the VACUUM step. Autovacuum may
    also run during the load.
  - Expect heavy WAL. `max_wal_size` is 1 GB and there is no archiving, so WAL segments recycle
    rather than pile up.
  - Hence `MIN_FREE_GB=30`.
- `preflight` launches one throwaway unit, `denue-refresh-heapcheck`, which only runs
  `node -p` to read the heap limit. Nothing else in it changes state.
- `status` estimates the ETA from the number of estados done, not from row counts. Estados vary
  from 40k to 817k rows, so treat it as a rough figure.
