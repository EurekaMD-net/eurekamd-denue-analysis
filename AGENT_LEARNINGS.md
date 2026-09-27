# AGENT_LEARNINGS.md

## Standing rules

- The live service runs `tsx` straight from the `main` checkout with `Restart=always`: never land unmigrated code on `main`'s working tree. Integrate on a branch in a worktree; merge + migrations + restart happen in one operator window.
- A full `vitest run` is blocked by the user-level guard. The sanctioned whole-suite check here is sharded: `npx vitest run --shard=i/4` (root and web/), never a bare run and never a subshell that hides the scope.
- A denylist over SQL text is not a security boundary (`--` in literals, `ts_stat()`, `U&"…"` identifiers each bypassed it). Secrets must be unreadable from the Sage session by construction: role-level GUC masking, login as the restricted role, READ ONLY transaction.
- A flag name must carry one meaning across routes (`truncated` meant "capped" on the SQL path and "table shorter than total" on the endpoint path; the client could only honour one).
- A destructive automated step (`git reset --hard`, `git clean`) will be denied by the permission layer: script `git revert` instead, and assert the resulting SHA — an agent saying "done" is a claim.
- `stopAutoRefresh()` in auth-js also removes the visibility listener and nothing restarts it on re-login; pair it with `startAutoRefresh()` or don't call it.

## 2026-09-27 — Multi-agent audit + refactor (DENUE_RECON)

- **Mistake:** the lane-suite step told agents to run a bare `npx vitest run` as "the sanctioned full run" → the user guard blocked it in 2 of 5 lanes. The check that would have caught it: read `~/.claude/hooks/scripts/vitest-scope-guard.sh` allow-list (`--shard`, paths) before writing any test instruction for subagents.
- **Mistake:** dedup by `file + 5-line bucket + category` left ~30 duplicate findings that the critic later listed (same defect cited from different lines). Better: after the mechanical dedup, one cheap agent pass to merge by root cause before verification.
- **Mistake:** the verify gate confirmed 204/212 findings (96 %) — a refute-by-default prompt still passed nearly everything, so "confirmed" mostly meant "present", not "worth fixing". Better: ask verifiers for a fix-worthiness score as well, and let the synthesis drop lows.
- **Avoid:** planning packages that split one file across lanes (`analytics.ts` was listed for P06/P07/P18/P19 but P08 also edited it; `sql-gate.ts` for P01 and P23) — the critic caught it, the integrator paid for it in conflicts.
- **Avoid:** a strict qa gate with a single fix round on multi-finding packages: P11 fixed 7 findings and was reverted for one regression, then redone in round 2. Better: 2 fix rounds for packages with ≥5 findings, or split the regression into its own follow-up when the rest is verified.
- **Better:** lane worktrees with symlinked `node_modules` + per-package implement→independent qa-auditor→fix→commit, integration in a fresh worktree, main untouched. 39/42 first-pass, 57 clean commits, no live incident.
- **Better:** the qa-auditor bypass probes (running the real `preCheckSql` via a scratch tsx probe) found what code reading missed twice; keep "try to bypass it" as a mandatory step for any input-validation package.
- **Mistake:** the workflow's "RED → `git reset --hard <pre_sha>`" step was denied by the auto-mode classifier in all three cases, and the script treated the agent's text as success, so the failed-audit code stayed on the lane branches, was integrated, and I reported the packages as "reverted". The check that would have caught it: verify a revert by side effect (`git log --oneline -1` == pre_sha) in the script, never by the agent's prose. Better: use `git revert --no-edit <range>` (additive, never blocked) instead of `reset --hard`, and fail loudly when HEAD does not match.

## 2026-09-27 — Deploy window (operator terminal + agent-authored script)

- **Mistake:** the deploy script was never executed end-to-end before the operator ran it; four defects surfaced live (psql `SET` tags in captured values, `indisvalid::text` = `true` vs `t`, a parallel VACUUM exceeding the container's 64 MB `/dev/shm`, a smoke-test AGEB id that does not exist) → the check that would have caught 3 of 4: run every read-only pre-check and smoke line against the live DB/API BEFORE handing the script over; grep sample ids into the data.
- **Mistake:** `vitest ... | grep -E 'Tests'` inside an `&&` chain let a RED test commit and push (grep matched the summary line, exit 0) → gate on the summary containing `failed`, or run the test in its own step before `git commit`.
- **Avoid:** a monolithic `deploy` phase with a base-SHA pre-check: after a terminal drop it can neither re-run nor resume. Better: idempotent entry points per stage (`finish`, `cutover`) that assert the previous stage's artefacts (index valid, backfill rows = 0, DB idle), then continue.
- **Avoid:** a runbook that assumes SSH stays up for a multi-minute window. Better: the runbook's first line is `tmux new` / `nohup ... > log`, and `tmux ls` before starting anything new.
- **Better:** `docker exec supabase-db df -h /dev/shm` is a pre-flight for any manual VACUUM / parallel CREATE INDEX on this instance; `PARALLEL 0` sidesteps it without touching the compose file.
- **Better:** report a 404 from a smoke line as "id absent or route fault?" and prove which with `SELECT count(*)` before touching code — it was the id.

## 2026-09-27 — DENUE 05/2026 refresh runner (ops/denue-refresh.sh)

- **Mistake:** the build brief carried four unverified "facts" (stale rows via `updated_at`; `updateGeometry` per state; 300 ms / batch 100; MemoryMax=2G) — the trigger is conditional on `raw_json` changing, geometry only runs with `--update-geom`, and the real load path peaks at 1.5 GB → the check: read the trigger definition (`pg_get_triggerdef`) and the CLI flag parser before stating behaviour in a brief.
- **Mistake (caught by qa-auditor):** Node 22 derives the V8 heap limit from the cgroup `memory.max/high`, not the host (1328 MB under a 3G cap) → a MemoryMax that "fits RSS" still OOMs the heap; pin `NODE_OPTIONS=--max-old-space-size` and prove it in a throwaway `systemd-run --wait --pipe` unit.
- **Avoid:** a `pg_stat_activity` busy guard on `query ~ ...` alone — it matches autovacuum on any table and idle sessions' last statement; filter `backend_type='client backend' AND state<>'idle'`.
- **Better:** long unattended DB jobs on this box = systemd transient unit (`--collect`, `OOMPolicy=continue`, log `append:`), state file for resume, escalating retry sleeps, per-estado truncation guard vs the previous run's counts, and a report-only stale step; the operator answers the launch prompt (piping `y` is denied as Blind Apply).
- **Mistake (09-27, found mid-run):** the runner's memory check measured RSS for 750k rows but never checked the LOAD path's read primitive: `readFileSync(file,'utf-8')` + `JSON.parse` caps at V8's max string (536,870,888 chars); Estado de México's raw file is ~563 M chars → estado 15 fails at load. The check that would have caught it: for any whole-file read, compute the largest input's size against `buffer.constants.MAX_STRING_LENGTH` before the run. Fix: stream the paginator's line-per-record file.
