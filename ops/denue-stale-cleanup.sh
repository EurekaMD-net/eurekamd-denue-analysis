#!/usr/bin/env bash
# Operator script for docs/DENUE-REFRESH.md "Stale-row cleanup": delete the establecimientos rows whose
# CLEE is absent from the DENUE 05/2026 extraction (list written by `denue-refresh.sh stale-report`).
# Run as root, after the refresh finished and stale-report ran.
#
#   denue-stale-cleanup.sh report   # read-only (default): per-estado classification + assertions
#   denue-stale-cleanup.sh backup   # gzip CSV of exactly the stale rows (idempotent)
#   denue-stale-cleanup.sh apply    # asks; per-estado DELETE by CLEE list, VACUUM, matviews, final count
#   denue-stale-cleanup.sh help
#
# Deletion is by the CLEE list, never by `updated_at < run date`: that predicate also matches live rows
# whose raw_json did not change in this edition (the update trigger only fires on a raw_json change).

# jq programs are single-quoted on purpose ($vars are jq --arg bindings, not shell).
# shellcheck disable=SC2016
set -euo pipefail

RUN_TAG=2026-09
REPO=/root/claude/projects/data-intelligence/denue-data-analysis
UNIT=denue-refresh
STATE_DIR=$REPO/data/state
STATE=$STATE_DIR/pipeline-state.json
BASE=$STATE_DIR/denue-refresh-$RUN_TAG.baseline.json
STALE=$STATE_DIR/denue-refresh-$RUN_TAG.stale-clees.txt
BACKUP=$STATE_DIR/denue-stale-$RUN_TAG.rows.csv.gz
CLOG=$STATE_DIR/denue-stale-$RUN_TAG.cleanup.log
LEDGER=$STATE_DIR/denue-stale-$RUN_TAG.cleanup.json
MIN_FREE_GB=5
TIMER=denue-matview-refresh.timer
BUSY_RE='(establecimientos|REFRESH MATERIALIZED)'
PSQL=(docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1)

log()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32mOK\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { local a; read -r -p "$* [y/N] " a; [[ $a == y || $a == Y ]] || die "aborted by operator"; }
clog() { printf '[denue-stale-cleanup %s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$CLOG"; }
# Read-only query; RO_TIMEOUT overrides the 20s default.
ro()   { docker exec supabase-db psql -U postgres -d postgres -qtA -c "SET default_transaction_read_only=on" -c "SET statement_timeout='${RO_TIMEOUT:-20s}'" -c "$1"; }
base_get() { if [[ -f $BASE ]]; then jq -r "$1 // empty" "$BASE"; fi; }
ledger_set() { local t; t=$(mktemp "$LEDGER.XXXX"); jq "$@" "$LEDGER" > "$t" || { rm -f "$t"; die "jq failed updating $LEDGER"; }; mv "$t" "$LEDGER"; }
# CSV records (quoted fields may hold newlines: a record ends where the running quote count is even), minus the header.
csv_rows() { zcat "$1" | awk '{ q += gsub(/"/, "&") } q % 2 == 0 { n++ } END { print n - 1 }'; }
next_c() { printf '%02d' $((10#$1 + 1)); }
# Read-only: how many of estado $1's stale CLEEs are still in the DB.
present() { RO_TIMEOUT=120s ro "COPY (SELECT clee FROM establecimientos WHERE clee >= '$1' AND clee < '$(next_c "$1")') TO STDOUT" \
  | awk 'FILENAME == ARGV[1] { st[$1] = 1; next } $1 in st { n++ } END { print n + 0 }' <(grep "^$1" "$STALE" || true) -; }

[[ $EUID -eq 0 ]] || die "run as root"

# ---------------------------------------------------------------- common guards (every mode)
RD='' FILE_N=0 EXTRACTED=0 DELETED=0
declare -A FILE_BY=() CLEARED=()   # CLEARED: estados in the ledger or proven deleted
guards() {
  log "guards"
  if systemctl is-active --quiet "$UNIT"; then die "$UNIT unit is active"; fi
  local fin rs; fin=$(base_get .finished_at); rs=$(base_get .run_start)
  [[ -n $fin && -n $rs ]] || die "$BASE has no finished_at/run_start: the refresh is not finished"
  RD="$(date -u -d "$rs" +%F) 00:00:00+00"
  [[ -f $STALE ]] || die "missing $STALE: run 'ops/denue-refresh.sh stale-report' first"
  [[ $(stat -c %Y "$STALE") -ge $(date -d "$fin" +%s) ]] || die "$STALE predates finished_at $fin"
  # 28 chars today; one legacy row from an older edition has a 27-char CLEE.
  local badl; badl=$(grep -cvE '^[0-9A-Z]{27,28}$' "$STALE" || true)
  [[ $badl -eq 0 ]] || die "$STALE has $badl line(s) that are not CLEEs"
  LC_ALL=C sort -c -u "$STALE" 2>/dev/null || die "$STALE is not sorted-unique (not a stale-report output)"
  FILE_N=$(wc -l < "$STALE")
  local c n
  while read -r n c; do FILE_BY[$c]=$n; done < <(cut -c1-2 "$STALE" | uniq -c)
  for c in "${!FILE_BY[@]}"; do [[ $c =~ ^(0[1-9]|[12][0-9]|3[0-2])$ ]] || die "$STALE has CLEEs with estado prefix '$c' (not 01..32)"; done
  [[ $(jq '[.estados[] | select(.status == "done")] | length' "$STATE") -eq 32 ]] || die "$STATE: not 32/32 estados done"
  EXTRACTED=$(jq '[.estados[].records_extracted] | add' "$STATE")
  if [[ -f $LEDGER ]]; then
    DELETED=$(jq '[.estados[].deleted] | add // 0' "$LEDGER")
    for c in $(jq -r '.estados | keys[]' "$LEDGER"); do CLEARED[$c]=1; done
  fi
  ok "stale file: $FILE_N CLEEs; extraction: $EXTRACTED; already deleted (ledger): $DELETED; run date: ${RD%% *}"

  local q="FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle' AND query ~* '$BUSY_RE'"
  local busy; busy=$(ro "SELECT count(*) $q")
  if [[ $busy -gt 0 ]]; then
    ro "SELECT pid||' '||state||' age='||(now()-query_start)::text||' '||left(regexp_replace(query,'\s+',' ','g'),100) $q"
    die "$busy DB session(s) busy on establecimientos (above); retry when pg_stat_activity drains"
  fi
  ok "no busy session on establecimientos"

  local db short; db=$(RO_TIMEOUT=120s ro "SELECT count(*) FROM establecimientos")
  short=$(( (FILE_N - DELETED) - (db - EXTRACTED) ))
  if [[ $short -ne 0 ]]; then
    # An apply that died between an estado's COMMIT and its ledger write: accept the shortfall only
    # if it is exactly the estados outside the ledger whose stale CLEEs are all gone.
    echo "count(*) $db - extracted $EXTRACTED = $((db - EXTRACTED)), expected $((FILE_N - DELETED)); estados not in the ledger:"
    local gone=0 p
    for c in $(seq -w 1 32); do
      [[ -z ${CLEARED[$c]:-} && ${FILE_BY[$c]:-0} -gt 0 ]] || continue
      p=$(present "$c") || die "estado $c: query failed"
      echo "  estado $c: $p of ${FILE_BY[$c]} stale CLEEs present"
      if [[ $p -eq 0 ]]; then gone=$((gone + FILE_BY[$c])); CLEARED[$c]=1; fi
    done
    [[ $gone -eq $short ]] || die "DB changed since stale-report: shortfall $short != $gone rows of fully deleted estados missing from the ledger (above)"
    DELETED=$((DELETED + gone))
    ok "shortfall $short = estados deleted by an interrupted apply, not yet in the ledger (apply records them)"
  fi
  ok "DB count(*) $db - extracted $EXTRACTED = $((FILE_N - DELETED)) stale rows still present"
}

# ---------------------------------------------------------------- report (read-only)
phase_report() {
  guards
  log "per estado (read-only; stale = CLEEs in the stale file; new = created_at >= ${RD%% *})"
  printf '%-6s %10s %10s %10s %10s %10s\n' estado stale_db re-keyed departed new_rows truly_new
  local c hi row nf s rk n gen kept bad want tot_s=0 tot_rk=0 tot_n=0 tot_gen=0 tot_kept=0 fails=0
  for c in $(seq -w 1 32); do
    hi=$(next_c "$c")
    # $1 clee, $2 denue_id, $3 created >= run date, $4 updated < run date. Re-keyed = a stale row whose
    # denue_id also sits on a row created this run (same estado).
    row=$(RO_TIMEOUT=120s ro "COPY (SELECT clee, coalesce(denue_id,''), coalesce(created_at >= '$RD', true)::int, coalesce(updated_at < '$RD', false)::int FROM establecimientos WHERE clee >= '$c' AND clee < '$hi') TO STDOUT" \
      | awk -F'\t' 'FILENAME == ARGV[1] { st[$1] = 1; nf++; next }
          $1 in st { s++; if ($3 == 1 || $4 == 0) bad++; if ($2 != "") sid[$2]++; next }
          $3 == 1  { n++; if ($2 != "") nid[$2]++; else gen++; next }
          $4 == 1  { kept++ }
          END { for (d in sid) if (d in nid) rk += sid[d]; for (d in nid) if (!(d in sid)) gen += nid[d]
                printf "%d %d %d %d %d %d %d\n", nf, s, rk, n, gen, kept, bad }' <(grep "^$c" "$STALE" || true) -) \
      || die "estado $c: query failed"
    read -r nf s rk n gen kept bad <<< "$row"
    printf '%-6s %10d %10d %10d %10d %10d\n' "$c" "$s" "$rk" $((s - rk)) "$n" "$gen"
    want=$nf
    if [[ -n ${CLEARED[$c]:-} ]]; then want=0; fi
    [[ $s -eq $want ]] || { echo "  ASSERT FAIL estado $c: $s stale rows in DB, expected $want (file $nf)"; fails=$((fails+1)); }
    [[ $bad -eq 0 ]] || { echo "  ASSERT FAIL estado $c: $bad stale rows created or updated this run"; fails=$((fails+1)); }
    tot_s=$((tot_s + s)); tot_rk=$((tot_rk + rk)); tot_n=$((tot_n + n)); tot_gen=$((tot_gen + gen)); tot_kept=$((tot_kept + kept))
  done
  printf '%-6s %10d %10d %10d %10d %10d\n' TOTAL "$tot_s" "$tot_rk" $((tot_s - tot_rk)) "$tot_n" "$tot_gen"
  awk -v r="$tot_rk" -v s="$tot_s" 'BEGIN { if (s) printf "re-keyed share of stale: %.1f%%\n", 100 * r / s }'

  log "assertions"
  echo "rows with updated_at < ${RD%% *}: $((tot_s + tot_kept)) = $tot_s stale + $tot_kept live rows unchanged this edition (NOT deleted)"
  [[ $tot_s -eq $((FILE_N - DELETED)) ]] || { echo "ASSERT FAIL: stale rows in DB $tot_s != file $FILE_N - ledger $DELETED"; fails=$((fails+1)); }
  local avg; avg=$(RO_TIMEOUT=120s ro "SELECT coalesce(round(avg(octet_length(t::text))),0) FROM (SELECT * FROM establecimientos TABLESAMPLE SYSTEM (1) WHERE updated_at < '$RD') t")
  echo "backup estimate: ~$(( avg * tot_s / 1048576 )) MB uncompressed CSV (avg row ${avg} B x $tot_s rows; gzip shrinks it); free: $(df -BG --output=avail "$STATE_DIR" | tail -1 | tr -d ' ')"
  [[ $fails -eq 0 ]] || die "$fails assertion(s) failed: do NOT run apply"
  ok "stale file and DB agree ($tot_s rows to delete). Next: $0 backup, then $0 apply"
}

# ---------------------------------------------------------------- backup
phase_backup() {
  guards
  if [[ -f $BACKUP ]]; then
    local have; have=$(csv_rows "$BACKUP")
    [[ $have -eq $FILE_N ]] || die "$BACKUP exists with $have rows, expected $FILE_N: move it away and rerun"
    ok "$BACKUP exists with the matching $have rows: skipped"
  else
    [[ $DELETED -eq 0 ]] || die "ledger shows $DELETED deleted rows but no backup exists"
    local free; free=$(df -BG --output=avail "$STATE_DIR" | tail -1 | tr -dc 0-9)
    [[ $free -ge $MIN_FREE_GB ]] || die "free disk ${free} GB < $MIN_FREE_GB"
    log "backup: COPY of the $FILE_N stale rows -> $BACKUP"
    # The temp table is session-private; the export itself runs read-only.
    { printf '%s\n' "SET statement_timeout='600s';" "CREATE TEMP TABLE s (clee text PRIMARY KEY);" "COPY s FROM STDIN;"
      cat "$STALE"
      printf '%s\n' '\.' "SET default_transaction_read_only=on;" \
        "COPY (SELECT e.* FROM public.establecimientos e JOIN s USING (clee)) TO STDOUT WITH (FORMAT csv, HEADER);"
    } | "${PSQL[@]}" -qAt | gzip -1 > "$BACKUP.partial"
    local n; n=$(csv_rows "$BACKUP.partial")
    [[ $n -eq $FILE_N ]] || die "backup has $n rows, expected $FILE_N (left at $BACKUP.partial)"
    mv "$BACKUP.partial" "$BACKUP"
    clog "backup written: $BACKUP ($n rows)"
  fi
  echo "sha256: $(sha256sum "$BACKUP" | cut -d' ' -f1)   size: $(du -h "$BACKUP" | cut -f1)"
}

# ---------------------------------------------------------------- apply
# One transaction per estado: load its stale CLEEs into a temp table, assert all are present (or none:
# already deleted), delete them, assert the deleted count; any mismatch raises and rolls back.
delete_estado() {
  local c=$1 want=$2 hi; hi=$(next_c "$1")
  { printf '%s\n' "SET statement_timeout='600s';" "BEGIN;" "CREATE TEMP TABLE s (clee text PRIMARY KEY) ON COMMIT DROP;" "COPY s FROM STDIN;"
    grep "^$c" "$STALE"
    printf '%s\n' '\.' "DO \$\$DECLARE present bigint; n bigint; BEGIN
  SELECT count(*) INTO present FROM public.establecimientos e JOIN s USING (clee);
  IF present = 0 THEN RAISE NOTICE 'SKIP'; RETURN; END IF;
  IF present <> $want THEN RAISE EXCEPTION 'estado $c: % stale CLEEs present, expected $want', present; END IF;
  DELETE FROM public.establecimientos e USING s WHERE e.clee = s.clee AND e.clee >= '$c' AND e.clee < '$hi'
    AND e.created_at < '$RD' AND e.updated_at < '$RD';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> $want THEN RAISE EXCEPTION 'estado $c: deleted % rows, expected $want', n; END IF;
  RAISE NOTICE 'DELETED %', n;
END\$\$;" "COMMIT;"
  } | "${PSQL[@]}" -qAt 2>&1
}

phase_apply() {
  [[ -t 0 ]] || die "apply is interactive; run it in a terminal (tmux)"
  guards
  [[ -f $BACKUP ]] || die "no backup at $BACKUP: run '$0 backup' first"
  local have; have=$(csv_rows "$BACKUP")
  [[ $have -eq $FILE_N ]] || die "$BACKUP has $have rows, expected $FILE_N"
  local sha; sha=$(sha256sum "$BACKUP" | cut -d' ' -f1)
  ok "backup $BACKUP: $have rows, sha256 $sha"
  if [[ -f $LEDGER ]]; then
    [[ $(jq -r .backup.sha256 "$LEDGER") == "$sha" ]] || die "$BACKUP sha256 $sha differs from the ledger's $(jq -r .backup.sha256 "$LEDGER")"
  fi
  local stopped=0
  if systemctl is-active --quiet "$TIMER"; then
    trap 'systemctl start "$TIMER" && clog "$TIMER started again (exit trap)"' EXIT
    systemctl stop "$TIMER"; stopped=1; clog "$TIMER stopped for the cleanup"
  fi
  ask "DELETE $((FILE_N - DELETED)) stale rows from establecimientos (32 transactions, one per estado)?"
  if [[ ! -f $LEDGER ]]; then
    jq -n --arg tag "$RUN_TAG" --arg b "$BACKUP" --arg sha "$sha" --argjson n "$have" \
      '{run_tag: $tag, backup: {path: $b, sha256: $sha, rows: $n}, estados: {}, vacuum_at: null, matviews_at: null, finished_at: null}' > "$LEDGER"
  fi
  clog "apply start: $((FILE_N - DELETED)) rows to delete"
  local c want out
  for c in $(seq -w 1 32); do
    want=${FILE_BY[$c]:-0}
    if [[ $want -eq 0 ]]; then clog "estado $c: no stale CLEEs, skipped"; continue; fi
    out=$(delete_estado "$c" "$want") || { clog "estado $c: failed (check whether COMMIT landed; rerun heals a committed estado via SKIP): $(tr '\n' ' ' <<< "$out")"; die "estado $c failed; nothing after it ran"; }
    if grep -q 'NOTICE:  SKIP' <<< "$out"; then
      [[ -n ${CLEARED[$c]:-} ]] || die "estado $c: 0 stale CLEEs present but the guards did not prove it (run report)"
      if jq -e --arg c "$c" '.estados | has($c)' "$LEDGER" >/dev/null; then clog "estado $c: already deleted (ledger), skipped"; continue; fi
      ledger_set --arg c "$c" --argjson n "$want" --arg t "$(date -u +%FT%TZ)" '.estados[$c] = {deleted: $n, at: $t, recovered: true}'
      clog "estado $c: stale count 0 but not in the ledger (committed before an interruption): recorded as recovered"; continue
    fi
    grep -q "NOTICE:  DELETED $want\$" <<< "$out" || die "estado $c: unexpected psql output after COMMIT: $out"
    ledger_set --arg c "$c" --argjson n "$want" --arg t "$(date -u +%FT%TZ)" '.estados[$c] = {deleted: $n, at: $t}'
    clog "estado $c: deleted $want"
  done

  clog "VACUUM (ANALYZE, PARALLEL 0) establecimientos"
  "${PSQL[@]}" -c "SET vacuum_cost_delay = '2ms'" -c "VACUUM (ANALYZE, PARALLEL 0) public.establecimientos"
  ledger_set --arg t "$(date -u +%FT%TZ)" '.vacuum_at = $t'
  clog "refresh-matviews"
  bash "$REPO/scripts/refresh-matviews.sh" 2>&1 | tee -a "$CLOG"
  ledger_set --arg t "$(date -u +%FT%TZ)" '.matviews_at = $t'

  local final; final=$(RO_TIMEOUT=120s ro "SELECT count(*) FROM establecimientos")
  [[ $final -eq $EXTRACTED ]] || die "final count(*) $final != extraction $EXTRACTED"
  ledger_set --arg t "$(date -u +%FT%TZ)" '.finished_at = $t'
  if [[ $stopped -eq 1 ]]; then
    if systemctl start "$TIMER"; then clog "$TIMER started again"; else clog "WARN: $TIMER did not start; run: systemctl start $TIMER"; fi
    trap - EXIT
  fi
  clog "FINISHED: count(*) $final = extraction $EXTRACTED. Ledger: $LEDGER"
}

case ${1:-report} in
  report)         phase_report ;;
  backup)         phase_backup ;;
  apply)          phase_apply ;;
  help|-h|--help) sed -n '2,12p' "$0" ;;
  *)              sed -n '2,12p' "$0"; exit 1 ;;
esac
