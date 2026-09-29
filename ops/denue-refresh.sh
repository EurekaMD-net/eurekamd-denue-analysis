#!/usr/bin/env bash
# Operator script for docs/DENUE-REFRESH.md: re-extract + re-load the FULL national DENUE
# (32 estados, ~6.1M rows, edition 05/2026) into establecimientos, disconnect-proof and throttled.
# Run as root. The long part runs in a transient systemd unit, so a terminal drop never stops it.
#
#   denue-refresh.sh preflight          # read-only checks + current baseline (prints only)
#   denue-refresh.sh start [--dry-run]  # preflight, archive the previous state file, write the baseline, launch the unit
#   denue-refresh.sh status             # unit, log tail, per-estado progress, DB counters, ETA
#   denue-refresh.sh resume             # relaunch the unit after a crash/stop (done estados are skipped)
#   denue-refresh.sh stop               # graceful stop (asks); resume later
#   denue-refresh.sh stale-report       # read-only: rows no longer in DENUE (after all 32 done); never deletes
#   denue-refresh.sh help
#
# Internal: denue-refresh.sh _worker  (what the unit runs; refuses to run outside it)

# jq programs are single-quoted on purpose ($vars are jq --arg bindings, not shell).
# shellcheck disable=SC2016
set -euo pipefail

RUN_TAG=2026-09
EDITION=05/2026
REPO=/root/claude/projects/data-intelligence/denue-data-analysis
UNIT=denue-refresh
ANALYZER=denue-analyzer
PORT=3030
STATE_DIR=$REPO/data/state
STATE=$STATE_DIR/pipeline-state.json
BASE=$STATE_DIR/denue-refresh-$RUN_TAG.baseline.json
LOG=$STATE_DIR/denue-refresh-$RUN_TAG.log
STALE_OUT=$STATE_DIR/denue-refresh-$RUN_TAG.stale-clees.txt
RAW=$REPO/data/raw
MAX_RETRIES=4
RETRY_DELAYS=(120 600 1800 3600)   # seconds before retry 1..4
MIN_FREE_GB=30
MEM_HIGH=2560M
MEM_MAX=3G
# Inside the cgroup Node 22 sizes the V8 heap from memory.max/high (1328 MB measured at 2560M/3G);
# Edomex (816k rows) needs ~1.3 GB of heap, so pin it.
NODE_HEAP_MB=2048
MAX_DROP_PCT=3   # truncation guard: records_extracted per estado vs the archived previous run
TIMER=denue-matview-refresh.timer
BUSY_RE='(VACUUM|UPDATE (public\.)?establecimientos|REFRESH MATERIALIZED)'
# One env mechanism everywhere: tsx --env-file (pipeline.ts also parses .env itself). No EnvironmentFile=.
TSX=("$REPO/node_modules/.bin/tsx" --env-file="$REPO/.env")
PSQL=(docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1)

log()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32mOK\033[0m  %s\n' "$*"; }
bad()  { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; FAILS=$((FAILS+1)); }
die()  { printf '\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { local a; read -r -p "$* [y/N] " a; [[ $a == y || $a == Y ]] || die "aborted by operator"; }
wlog() { printf '[denue-refresh %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
# Read-only query; RO_TIMEOUT overrides the 20s default for full-table counts.
ro()   { docker exec supabase-db psql -U postgres -d postgres -qtA -c "SET default_transaction_read_only=on" -c "SET statement_timeout='${RO_TIMEOUT:-20s}'" -c "$1"; }

env_has() { grep -qE "^[[:space:]]*$1=[\"']?[^\"'[:space:]]" "$REPO/.env"; }
env_val() { grep -E "^[[:space:]]*$1=" "$REPO/.env" | tail -1 | cut -d= -f2- | sed -E "s/^[[:space:]]*[\"']?//; s/[\"']?[[:space:]]*$//"; }
state_count() { if [[ -f $STATE ]]; then jq --arg s "$1" '[.estados[] | select(.status == $s)] | length' "$STATE"; else echo 0; fi; }
base_get() { if [[ -f $BASE ]]; then jq -r "$1 // empty" "$BASE"; fi; }
base_set() { local t; t=$(mktemp "$BASE.XXXX"); jq "$@" "$BASE" > "$t" && mv "$t" "$BASE"; }
unit_active() { systemctl is-active --quiet "$UNIT"; }

[[ $EUID -eq 0 ]] || die "run as root"

# ---------------------------------------------------------------- preflight (read-only)
FAILS=0
B_COUNT='' B_MIN='' B_MAX=''
preflight() {
  FAILS=0
  log "preflight (read-only)"
  local k
  for k in DENUE_TOKEN SUPABASE_URL SUPABASE_SERVICE_KEY; do
    if env_has "$k"; then ok ".env has $k"; else bad ".env missing $k"; fi
  done
  if [[ -x ${TSX[0]} ]]; then ok "tsx at ${TSX[0]}"; else bad "tsx missing at ${TSX[0]} (node_modules not installed?)"; fi
  # Same memory caps + NODE_OPTIONS as the real unit, in a throwaway unit (runs node -p only).
  local heap; heap=$(systemd-run --unit=denue-refresh-heapcheck --collect --wait --pipe -q -p MemoryHigh="$MEM_HIGH" -p MemoryMax="$MEM_MAX" \
    --setenv=NODE_OPTIONS=--max-old-space-size="$NODE_HEAP_MB" /usr/bin/node -p 'Math.floor(v8.getHeapStatistics().heap_size_limit/2**20)' 2>/dev/null) || heap=0
  if [[ $heap -ge 2000 ]]; then ok "V8 heap limit inside the unit caps: ${heap} MB (>= 2000)"; else bad "V8 heap limit inside the unit caps: ${heap:-?} MB (< 2000)"; fi

  if systemctl is-active --quiet "$ANALYZER" && curl -sf -o /dev/null "http://127.0.0.1:$PORT/health"; then
    ok "$ANALYZER active, /health 200"
  else
    bad "$ANALYZER not active or /health failing"
  fi
  if [[ $(docker inspect -f '{{.State.Running}}' supabase-db 2>/dev/null) == true ]]; then ok "supabase-db running"; else bad "supabase-db not running"; fi

  # Same path + credential the loader uses. Headers go through stdin so the key never hits argv.
  local url; url=$(env_val SUPABASE_URL); url=${url:-http://localhost:8100}
  if printf 'apikey: %s\nAuthorization: Bearer %s\n' "$(env_val SUPABASE_SERVICE_KEY)" "$(env_val SUPABASE_SERVICE_KEY)" \
      | curl -sf -o /dev/null -m 20 -H @- "$url/rest/v1/establecimientos?select=clee&limit=1"; then
    ok "PostgREST reachable with the service key ($url)"
  else
    bad "PostgREST probe failed ($url/rest/v1/establecimientos, service key)"
  fi

  local free; free=$(df -BG --output=avail "$REPO" | tail -1 | tr -dc 0-9)
  if [[ $free -ge $MIN_FREE_GB ]]; then ok "free disk ${free} GB (>= $MIN_FREE_GB)"; else bad "free disk ${free} GB < $MIN_FREE_GB"; fi
  local load cores; load=$(cut -d' ' -f1 /proc/loadavg); cores=$(nproc)
  if awk -v l="$load" -v c="$cores" 'BEGIN{exit !(l < c-1)}'; then ok "load1 $load < $((cores-1))"; else bad "load1 $load >= $((cores-1)) (nproc $cores)"; fi
  if unit_active; then bad "$UNIT unit already active (use status/stop)"; else ok "no $UNIT unit active"; fi

  log "state file"
  if [[ ! -f $STATE ]]; then
    echo "no $STATE (a fresh one is created by the pipeline)"
  else
    local created; created=$(jq -r .created_at "$STATE")
    echo "$STATE: created_at=$created done=$(state_count "done") failed=$(state_count "failed") pending=$(state_count "pending") running=$(state_count "running")"
    if [[ -n $(base_get .run_start) ]]; then
      echo "belongs to run $RUN_TAG (baseline has run_start $(base_get .run_start)): use resume/status, not start"
    else
      echo "previous run's file: start archives it to $STATE_DIR/pipeline-state.${created:0:7}.json"
    fi
  fi
  compgen -G "$STATE_DIR/pipeline-state.*.json" | sed 's/^/archived: /' || true
  if systemctl is-active --quiet "$TIMER"; then echo "$TIMER: active (start stops it; the worker starts it again after finished_at)"; else echo "$TIMER: inactive (start leaves it alone)"; fi

  log "baseline establecimientos"
  local row; row=$(RO_TIMEOUT=120s ro "SELECT count(*)||'|'||min(updated_at)||'|'||max(updated_at) FROM establecimientos") || { bad "baseline query failed"; return 1; }
  IFS='|' read -r B_COUNT B_MIN B_MAX <<< "$row"
  echo "count=$B_COUNT min_updated_at=$B_MIN max_updated_at=$B_MAX"

  if [[ $FAILS -gt 0 ]]; then printf '\033[1;31m%s check(s) failed\033[0m\n' "$FAILS"; return 1; fi
  ok "preflight passed"
}

# ---------------------------------------------------------------- unit launch
UNIT_CMD=()
build_unit_cmd() {
  UNIT_CMD=(systemd-run --unit="$UNIT" --description="DENUE $EDITION national refresh (ops/denue-refresh.sh)" --collect
    --property=WorkingDirectory="$REPO"
    --property=Nice=19 --property=IOSchedulingClass=idle --property=CPUQuota=150%
    --property=MemoryHigh="$MEM_HIGH" --property=MemoryMax="$MEM_MAX" --property=TasksMax=256
    --property=OOMPolicy=continue
    --property=StandardOutput=append:"$LOG" --property=StandardError=append:"$LOG"
    --setenv=HOME=/root --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    --setenv=OUTPUT_DIR="$RAW" --setenv=NODE_OPTIONS=--max-old-space-size="$NODE_HEAP_MB"
    /bin/bash "$REPO/ops/denue-refresh.sh" _worker)
}
launch() {
  build_unit_cmd
  "${UNIT_CMD[@]}"
  sleep 3
  unit_active || die "$UNIT did not stay active; tail $LOG and journalctl -u $UNIT"
  ok "$UNIT running. Safe to close the terminal. Watch: $0 status   |   tail -f $LOG"
}

# ---------------------------------------------------------------- start
phase_start() {
  local dry=0
  [[ ${1:-} == --dry-run ]] && dry=1
  [[ -z $(base_get .run_start) ]] || die "run $RUN_TAG already started at $(base_get .run_start) ($BASE): use '$0 resume' or '$0 status'"
  preflight || die "preflight failed"

  local archive=''
  if [[ -f $STATE ]]; then
    archive=$STATE_DIR/pipeline-state.$(jq -r '.created_at[0:7]' "$STATE").json
    [[ ! -e $archive ]] || die "$archive already exists; refusing to overwrite an archived run record"
  fi

  build_unit_cmd
  if [[ $dry -eq 1 ]]; then
    log "dry run: nothing changed"
    [[ -n $archive ]] && echo "would archive: $STATE -> $archive"
    echo "would write:   $BASE (edition $EDITION, baseline count $B_COUNT, run_start = now)"
    if systemctl is-active --quiet "$TIMER"; then echo "would stop:    $TIMER (timer_stopped: true; restarted after finished_at)"; else echo "timer:         $TIMER inactive, left alone (timer_stopped: false)"; fi
    echo "would launch:"
    printf '  %q' "${UNIT_CMD[@]}"; echo
    return 0
  fi

  ask "launch the ~11 h national refresh (edition $EDITION) now?"
  [[ -n $archive ]] && { mv "$STATE" "$archive"; ok "archived previous state file to $archive"; }
  local now; now=$(date -u +%FT%TZ)
  local ts=false
  systemctl is-active --quiet "$TIMER" && ts=true
  local t; t=$(mktemp "$BASE.XXXX")
  jq -n --arg tag "$RUN_TAG" --arg ed "$EDITION" --arg now "$now" --arg c "$B_COUNT" --arg mn "$B_MIN" --arg mx "$B_MAX" --arg ar "$archive" --argjson ts "$ts" \
    '{run_tag: $tag, edition: $ed, baseline: {count: ($c|tonumber), min_updated_at: $mn, max_updated_at: $mx, taken_at: $now},
      run_start: $now, archived_state_file: (if $ar == "" then null else $ar end), timer_stopped: $ts,
      worker_runs: [], post_steps: {}, finished_at: null}' > "$t"
  mv "$t" "$BASE"
  ok "baseline written: $BASE (run_start $now)"
  if [[ $ts == true ]]; then systemctl stop "$TIMER"; ok "$TIMER stopped (not disabled); the worker starts it after finished_at"; fi
  launch
}

# ---------------------------------------------------------------- resume / stop
phase_resume() {
  [[ -n $(base_get .run_start) ]] || die "no run_start in $BASE: nothing to resume, use '$0 start'"
  unit_active && die "$UNIT is already active"
  # A stop during post-steps leaves the SQL running inside supabase-db (outside the unit's cgroup).
  local busy; busy=$(ro "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle' AND query ~* '$BUSY_RE'")
  if [[ $busy -gt 0 ]]; then
    ro "SELECT pid||' '||coalesce(state,'?')||' age='||coalesce((now()-query_start)::text,'?')||' '||left(regexp_replace(query,'\s+',' ','g'),100) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle' AND query ~* '$BUSY_RE'"
    die "$busy DB session(s) still running post-step SQL (above); wait for pg_stat_activity to drain, then resume"
  fi
  preflight || die "preflight failed"
  [[ -z $(base_get .finished_at) ]] || die "run already finished at $(base_get .finished_at)"
  ask "relaunch $UNIT (done estados and recorded post-steps are skipped)?"
  launch
}

phase_stop() {
  unit_active || die "$UNIT is not active"
  ask "stop $UNIT? (the estado in flight restarts from page 1 on resume)"
  systemctl stop "$UNIT"
  ok "stopped. Resume with: $0 resume"
}

# ---------------------------------------------------------------- _worker (inside the unit)
phase_worker() {
  [[ -n ${INVOCATION_ID:-} ]] || die "_worker only runs inside the $UNIT unit: use '$0 start' or '$0 resume'"
  [[ -f $BASE ]] || die "missing $BASE"
  cd "$REPO"
  wlog "worker start (pid $$, edition $EDITION, run_start $(base_get .run_start))"
  base_set --arg t "$(date -u +%FT%TZ)" '.worker_runs += [$t]'

  local rc=0 attempt=0
  "${TSX[@]}" scripts/pipeline.ts --all --concurrency=1 || rc=$?
  wlog "pipeline --all exit $rc: done=$(state_count "done") failed=$(state_count "failed") pending=$(state_count "pending")"
  # --retry-failed resets failed->pending and also runs anything left pending (running->pending after a crash).
  while [[ $(state_count "done") -lt 32 && $attempt -lt $MAX_RETRIES ]]; do
    attempt=$((attempt+1))
    wlog "retry $attempt/$MAX_RETRIES in ${RETRY_DELAYS[attempt-1]} s (failed=$(state_count "failed") pending=$(state_count "pending"))"
    sleep "${RETRY_DELAYS[attempt-1]}"
    rc=0
    "${TSX[@]}" scripts/pipeline.ts --retry-failed --concurrency=1 || rc=$?
    wlog "pipeline --retry-failed exit $rc: done=$(state_count "done") failed=$(state_count "failed")"
  done
  if [[ $(state_count "done") -ne 32 ]]; then
    wlog "STOP: only $(state_count "done")/32 estados done after $MAX_RETRIES retries; state file kept. Fix the cause, then: ops/denue-refresh.sh resume"
    exit 1
  fi

  local drops; drops=$(truncated_estados)
  if [[ -n $drops ]]; then
    wlog "STOP: records_extracted fell > ${MAX_DROP_PCT}% vs the previous run for:"
    printf '%s\n' "$drops"
    wlog "post-steps NOT run; state kept. Check the API/token, set those estados to failed in $STATE and resume; if the drop is real, set .truncation_ack=true in $BASE and resume."
    exit 1
  fi

  # Post-steps: each is recorded in the baseline json and skipped on a later resume.
  post_step geometry     step_geometry
  post_step ageb_backfill step_ageb
  post_step area_geo_rekey step_area_geo_rekey
  post_step vacuum       step_vacuum
  post_step matviews     "$REPO/scripts/refresh-matviews.sh"
  base_set --arg t "$(date -u +%FT%TZ)" '.finished_at = $t'
  if [[ $(base_get .timer_stopped) == true ]]; then systemctl start "$TIMER"; wlog "$TIMER started again"; fi
  wlog "FINISHED. Next: ops/denue-refresh.sh stale-report (read-only; deletion is an operator decision)"
}

# Prints "clave nombre: old -> new" for each estado whose records_extracted fell more than MAX_DROP_PCT
# below the archived previous run. Empty = OK (or no archive to compare with). With .truncation_ack=true
# the drops are printed to stderr as "WARN (acked) <clave> <old> -> <new>" and stdout stays empty.
truncated_estados() {
  local arch; arch=$(base_get .archived_state_file)
  [[ -n $arch && -f $arch ]] || return 0
  local drops; drops=$(jq -r --slurpfile old "$arch" --argjson pct "$MAX_DROP_PCT" '.estados | to_entries[]
    | (.value.records_extracted) as $n | ($old[0].estados[.key].records_extracted // 0) as $o
    | select($o > 0 and $n < $o * (1 - $pct/100))
    | "\(.key) \(.value.nombre)\t\($o) -> \($n)"' "$STATE")
  [[ -n $drops ]] || return 0
  if [[ $(base_get .truncation_ack) == true ]]; then
    printf '%s\n' "$drops" | awk -F'\t' '{split($1, k, " "); print "WARN (acked) " k[1] " " $2}' >&2
    return 0
  fi
  printf '%s\n' "$drops" | awk -F'\t' '{print "  " $1 ": " $2}'
}

post_step() {
  local name=$1; shift
  if [[ -n $(base_get ".post_steps.$name.finished_at") ]]; then wlog "post-step $name already done, skipping"; return 0; fi
  local t0; t0=$(date -u +%FT%TZ)
  wlog "post-step $name: start"
  "$@"
  base_set --arg n "$name" --arg s "$t0" --arg f "$(date -u +%FT%TZ)" '.post_steps[$n] = {started_at: $s, finished_at: $f}'
  wlog "post-step $name: done"
}

# The upsert never sends geom; the loader's own updateGeometry sets it for new rows and rewrites moved ones.
# backfill-ageb needs geom NOT NULL, so this runs first.
step_geometry() {
  "${TSX[@]}" -e 'import("./src/db/loader.ts").then((m) => m.updateGeometry({ supabaseUrl: "", serviceRoleKey: "" })).catch((e) => { console.error(e); process.exit(1); })'
}
step_ageb() {
  local e
  for e in $(seq -w 1 32); do "${TSX[@]}" scripts/backfill-ageb.ts --entidad="$e"; done
}
# Bogus CLEE prefixes: re-keys area_geo (+ entidad) that is not a municipios_2025 key from the containing MG 2025
# polygon (needs geom, so after step_geometry); unresolved rows are counted, never guessed.
step_area_geo_rekey() { "${PSQL[@]}" -f - < "$REPO/scripts/rekey-stray-area-geo.sql"; }
# PARALLEL 0 is required here (supabase-db /dev/shm = 64 MB). cost_delay 2ms = autovacuum's pace, so
# the manual VACUUM (default cost_delay 0 = unthrottled IO) does not starve the shared box.
step_vacuum() {
  "${PSQL[@]}" -c "SET vacuum_cost_delay = '2ms'" -c "VACUUM (ANALYZE, PARALLEL 0) public.establecimientos"
}

# ---------------------------------------------------------------- status
phase_status() {
  log "unit"
  if unit_active; then
    echo "$UNIT: active"
    systemctl show -p MemoryCurrent -p CPUUsageNSec -p ActiveEnterTimestamp "$UNIT"
  else
    echo "$UNIT: inactive (last exit: journalctl -u $UNIT -n 20)"
  fi
  echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"
  echo "$TIMER: $(systemctl is-active "$TIMER" || true)   (timer_stopped by start: $(jq -r 'if has("timer_stopped") then .timer_stopped else "n/a" end' "$BASE" 2>/dev/null || echo n/a))"
  echo "raw files: $(compgen -G "$RAW/*.json" | wc -l) in $RAW ($(du -sh "$RAW" 2>/dev/null | cut -f1))"
  if [[ -f $LOG ]]; then
    log "log tail ($LOG)"
    tail -c 20000 "$LOG" | tr '\r' '\n' | grep -v '^[[:space:]]*$' | tail -5
  fi

  log "pipeline --status"
  (cd "$REPO" && "${TSX[@]}" scripts/pipeline.ts --status) | grep -vE '^\s+✅' || true

  local rs; rs=$(base_get .run_start)
  [[ -n $rs ]] || { echo "no run started ($BASE has no run_start)"; return 0; }
  log "run $RUN_TAG (edition $(base_get .edition))"
  local bc ndone loaded; bc=$(base_get .baseline.count)
  ndone=$(state_count "done")
  loaded=$(jq '[.estados[] | select(.status == "done") | .records_loaded] | add // 0' "$STATE" 2>/dev/null || echo 0)
  echo "estados done: $ndone/32   rows loaded by done estados: $loaded (baseline count $bc)"
  local row; row=$(RO_TIMEOUT=120s ro "SELECT count(*)||'|'||count(*) FILTER (WHERE created_at >= '$rs')||'|'||count(*) FILTER (WHERE updated_at >= '$rs') FROM establecimientos") || row='?|?|?'
  IFS='|' read -r total new changed <<< "$row"
  echo "DB now: total=$total  new since run_start=$new  changed-or-new since run_start=$changed"
  echo "(updated_at moves only when raw_json changes; an unchanged row keeps its old updated_at, so this is NOT a 'refreshed' counter)"
  local el; el=$(( $(date +%s) - $(date -d "$rs" +%s) ))
  printf 'elapsed: %dh%02dm' $((el/3600)) $((el%3600/60))
  if [[ $ndone -gt 0 && $ndone -lt 32 ]]; then
    local eta=$(( el * (32 - ndone) / ndone ))
    printf '   naive ETA (by estados, not rows): +%dh%02dm' $((eta/3600)) $((eta%3600/60))
  fi
  echo
  echo "post_steps: $(jq -c .post_steps "$BASE")   finished_at: $(base_get .finished_at)"
}

# ---------------------------------------------------------------- stale-report (read-only)
# updated_at cannot tell closed establishments apart (the trigger fires only on a raw_json change), so
# the truth is the run's own extraction: CLEEs in the DB that are absent from all 32 data/raw files.
phase_stale() {
  local rs; rs=$(base_get .run_start)
  [[ -n $rs ]] || die "no run_start in $BASE"
  unit_active && die "$UNIT is still running; wait for it to finish"
  [[ $(state_count "done") -eq 32 ]] || die "only $(state_count "done")/32 estados done: the report needs a COMPLETE extraction"
  local drops; drops=$(truncated_estados)
  [[ -z $drops ]] || { printf '%s\n' "$drops"; die "records_extracted fell > ${MAX_DROP_PCT}% vs the previous run (above): refusing, a short extraction would flag live rows as stale"; }
  local rs_s; rs_s=$(date -d "$rs" +%s)
  # global, not local: the EXIT trap fires after this function has returned
  STALE_WORK=$(mktemp -d "$STATE_DIR/stale-$RUN_TAG.XXXX")
  trap 'rm -rf "$STALE_WORK"' EXIT
  local work=$STALE_WORK

  log "DENUE side: CLEEs from this run's data/raw files"
  local c f n want
  for c in $(seq -w 1 32); do
    f=$(compgen -G "$RAW/${c}_*.json" | head -1) || true
    [[ -n $f ]] || die "no raw file for estado $c in $RAW"
    [[ $(stat -c %Y "$f") -ge $rs_s ]] || die "$f predates run_start $rs (not from this run)"
    grep -o '"CLEE":"[^"]*"' "$f" | cut -d'"' -f4 | grep -v '^$' >> "$work/denue" || true
    n=$(grep -c '"CLEE":' "$f" || true)
    want=$(jq -r --arg c "$c" '.estados[$c].records_extracted' "$STATE")
    [[ $n -eq $want ]] || die "$f has $n records, state file says $want extracted: file incomplete"
  done
  LC_ALL=C sort -u "$work/denue" -o "$work/denue"
  echo "DENUE $EDITION distinct CLEEs: $(wc -l < "$work/denue")"

  log "DB side: CLEEs in establecimientos (streamed COPY, read-only)"
  RO_TIMEOUT=600s ro "COPY (SELECT clee FROM establecimientos) TO STDOUT" | LC_ALL=C sort -u > "$work/db"
  echo "DB distinct CLEEs: $(wc -l < "$work/db")"

  LC_ALL=C comm -23 "$work/db" "$work/denue" > "$STALE_OUT"
  local stale missing bc; stale=$(wc -l < "$STALE_OUT"); missing=$(LC_ALL=C comm -13 "$work/db" "$work/denue" | wc -l)
  bc=$(base_get .baseline.count)
  log "stale candidates (in DB, absent from DENUE $EDITION) per entidad"
  cut -c1-2 "$STALE_OUT" | sort | uniq -c | awk '{printf "  %s  %8d\n", $2, $1}'
  echo "TOTAL stale candidates: $stale  ($(awk -v s="$stale" -v b="$bc" 'BEGIN{printf "%.2f", (b ? 100*s/b : 0)}')% of baseline $bc)"
  echo "in DENUE but not in DB (expect 0; >0 = rows the load skipped): $missing"
  awk -v s="$stale" -v b="$bc" 'BEGIN{exit !(b && s/b > 0.10)}' && echo "WARN: > 10% stale is implausible for one edition; suspect a short extraction before acting on it"
  echo "CLEE list: $STALE_OUT"
  echo "NOTHING WAS DELETED. Removing these rows is a separate operator decision (see docs/DENUE-REFRESH.md)."
}

case ${1:-} in
  preflight)    preflight ;;
  start)        shift; phase_start "$@" ;;
  resume)       phase_resume ;;
  status)       phase_status ;;
  stop)         phase_stop ;;
  stale-report) phase_stale ;;
  _worker)      phase_worker ;;
  help|-h|--help) sed -n '2,14p' "$0" ;;
  *)            sed -n '2,14p' "$0"; exit 1 ;;
esac
