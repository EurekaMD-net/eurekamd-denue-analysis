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
  idempotent on `clee`. The worker runs `--all` first, then up to 4 rounds of `--retry-failed`
  120 s apart. If fewer than 32 estados are `done` after that, it exits non-zero and leaves the
  state file in place for `resume`.
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
- **Log.** Output goes to `data/state/denue-refresh-2026-09.log` through
  `StandardOutput=append:`, which needs systemd 240 or later (this box runs 255). This file is
  gitignored, like all of `data/`.
- **Run record.** `data/state/denue-refresh-2026-09.baseline.json` holds: `edition`, the
  baseline (`count`, `min/max updated_at`), `run_start`, the archived state-file path,
  `worker_runs[]`, the `post_steps` timestamps and `finished_at`.

## Throttles and why

This VPS has 4 vCPU and 15 GB of RAM. It also runs mission-control, agentic-crm, supabase,
caddy and stalwart. Swap was fully used on 09-27.

| Property | Value | Why |
|---|---|---|
| `Nice` | 19 | Node CPU yields to the live services |
| `CPUQuota` | 150% | The client never takes more than 1.5 of the 4 cores |
| `MemoryHigh` / `MemoryMax` | 2560M / 3G | Measured on 09-27: parse, validate and transform for 750k rows peaks at 1.49 GB RSS. Edomex (15) has 816,586 rows, so expect about 1.65 GB. With the planned 1536M/2G, reclaim throttling would stall on Edomex and CDMX, and 2G would risk an OOM kill |
| `TasksMax` | 256 | Guard against a runaway fork |
| `IOSchedulingClass` | idle | **Has no effect on this box.** The disks use the `none`/`mq-deadline` schedulers, and idle priority is honoured only by BFQ. It is kept because it costs nothing |

**Limit of the cgroup throttles.** They cover only the client processes: tsx/node, bash and the
docker CLI. The database work runs in the `supabase-db` container's cgroup and is not throttled:
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
5. `finished_at` is written.

## Next morning

1. Run `bash ops/denue-refresh.sh status`. Expect the unit inactive, `estados done: 32/32`, and
   all four post-steps plus `finished_at` set. If the unit is inactive but the run is not
   finished, check the log tail and `journalctl -u denue-refresh -n 50`, then run `resume`.
2. Run `bash ops/denue-refresh.sh stale-report` (read-only). It prints stale candidates per
   entidad, the total, and its percentage of the baseline, and writes the CLEE list to
   `data/state/denue-refresh-2026-09.stale-clees.txt`. If the stale share is above 10%, suspect a
   short extraction.
3. Spot-check with `curl -s http://127.0.0.1:3030/health` and a `/search` in the UI.
   `mv_coverage.last_updated_at` should have moved.
4. Keep `data/raw/*.json` (about 3.5 GB) until the stale decision is made. The stale report reads
   those files.

## Known limitations

- **Stale detection uses the raw files, not `updated_at`.** `trg_estab_updated_at` (migration
  014) fires only when `raw_json` changes. A re-loaded row whose record did not change keeps its
  old `updated_at`, so `updated_at < run_start` does not mean the establishment closed.
  `stale-report` instead diffs every CLEE in the database against the CLEEs in this run's 32 raw
  files. Before diffing, it checks that each file is newer than `run_start` and that its record
  count matches the state file. For the same reason, the status counters "new" (`created_at`) and
  "changed-or-new" (`updated_at`) are informational only.
- **Stale rows are reported, never deleted.** Removing them is a separate operator decision.
- **Moved establishments keep their old `ageb`.** The geometry step corrects `geom`, but
  `backfill-ageb` fills only NULL values.
- **The edition exists only in the baseline json** (`"edition": "05/2026"`). The API returns an
  empty `fecha_alta`, so no row records which edition it came from.
- **Dead tuples until the VACUUM step.** Any row whose record changed is rewritten, which can be
  up to all 6.1M, and the 12 indexes grow with it. Autovacuum may run during the load. The
  explicit VACUUM at the end cleans up in any case.
- **The daily `denue-matview-refresh.timer` (04:00 UTC) may fire during the run.** This is
  harmless: the matviews show a partial mix until the final `matviews` step. Stop the timer
  beforehand if you want the analytics numbers frozen during the run.
- `status` estimates the ETA from the number of estados done, not from row counts. Estados vary
  from 40k to 817k rows, so treat it as a rough figure.
