#!/usr/bin/env bash
# Operator script for docs/DEPLOY-2026-09-26-AUDIT-REFACTOR.md.
# Run as root in a terminal (not from an agent). Every phase asks before it changes anything.
#
#   deploy-audit-refactor.sh push                 # commit leftovers on the branch, push it (step "publish")
#   deploy-audit-refactor.sh tag a@x.com b@y.com  # step 1b: tag allowed users (>= 1 h BEFORE deploy)
#   deploy-audit-refactor.sh deploy [--hold-heavy] # steps 0-4, 6, 7, 8, 11 smoke (one window, off-hours)
#   deploy-audit-refactor.sh gotrue               # step 5 / G2: close self-signup (shared instance)
#   deploy-audit-refactor.sh verify               # step 11 read-only checks
#   deploy-audit-refactor.sh all                  # push + deploy + verify (tag must already be done)
#
# NOT automated on purpose (shared infra, needs coordination): step 9 (Caddy paste) and
# step 10 (#110 key rotation across db.mycommit.net). The script prints both at the end.

set -euo pipefail

BRANCH=audit-refactor-2026-09-26
BASE_SHA=047c848
WT=/root/claude/projects/data-intelligence/denue-wt/integration
MAIN=/root/claude/projects/data-intelligence/denue-data-analysis
M=$MAIN/scripts/migrations
UNIT=denue-analyzer
PORT=3030
PSQL=(docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1)
PSQL_RO=(docker exec supabase-db psql -U postgres -d postgres -qtA -c "SET default_transaction_read_only=on" -c "SET statement_timeout='20s'" -c)

log()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32mOK\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { local a; read -r -p "$* [y/N] " a; [[ $a == y || $a == Y ]] || die "aborted by operator"; }
sqlf() { log "psql -f $1"; "${PSQL[@]}" -f - < "$1"; }

[[ $EUID -eq 0 ]] || die "run as root"

# ---------------------------------------------------------------- push
phase_push() {
  log "push: branch $BRANCH from $WT"
  cd "$WT"
  [[ $(git branch --show-current) == "$BRANCH" ]] || die "worktree is not on $BRANCH"
  if [[ -n $(git status --short --untracked-files=no) ]]; then
    git status --short --untracked-files=no
    ask "commit these tracked changes on $BRANCH?"
    git add -u
    git commit -m "chore: operator leftovers before publishing the audit refactor branch"
  fi
  gh auth status >/dev/null || die "gh auth status failed; fix auth first (no SSH on this box)"
  git push -u origin "$BRANCH"
  ok "pushed $(git rev-parse --short HEAD) to origin/$BRANCH"
}

# ---------------------------------------------------------------- tag (step 1b)
phase_tag() {
  [[ $# -ge 1 ]] || die "usage: tag <email> [email ...]"
  local list; list=$(printf "'%s'," "$@"); list=${list%,}
  log "step 1b: tag ${#@} user(s) with app_metadata.apps += uncharted"
  "${PSQL_RO[@]}" "SELECT email FROM auth.users WHERE email IN ($list)"
  ask "tag exactly these? (rows above must match the ${#@} emails you passed)"
  "${PSQL[@]}" -c "UPDATE auth.users SET raw_app_meta_data = jsonb_set(coalesce(raw_app_meta_data,'{}'::jsonb), '{apps}', coalesce(raw_app_meta_data->'apps','[]'::jsonb) || '[\"uncharted\"]'::jsonb) WHERE email IN ($list) AND NOT coalesce(raw_app_meta_data->'apps','[]'::jsonb) ? 'uncharted'"
  local n; n=$("${PSQL_RO[@]}" "SELECT count(*) FROM auth.users WHERE raw_app_meta_data->'apps' ? 'uncharted'")
  ok "$n user(s) now carry the tag. Deploy no sooner than 1 h from now (token refresh)."
}

# ---------------------------------------------------------------- deploy (steps 0-4, 6, 7, 8)
phase_deploy() {
  local hold_heavy=0
  [[ ${1:-} == --hold-heavy ]] && hold_heavy=1

  log "pre-checks"
  cd "$MAIN"
  [[ $(git branch --show-current) == main ]] || die "main checkout is not on main"
  [[ $(git rev-parse --short HEAD) == "$BASE_SHA" ]] || die "main is not at $BASE_SHA (already merged? rollback SHA in the runbook assumes $BASE_SHA)"
  git merge-base --is-ancestor main "$BRANCH" || die "$BRANCH does not fast-forward from main"
  [[ -z $(git status --short --untracked-files=no) ]] || die "main checkout has tracked modifications; resolve first"
  local tagged; tagged=$("${PSQL_RO[@]}" "SELECT count(*) FROM auth.users WHERE raw_app_meta_data->'apps' ? 'uncharted'")
  [[ $tagged -gt 0 ]] || die "0 users tagged (step 1b). After the restart every bearer gets 401. Run: $0 tag <emails>"
  ok "main at $BASE_SHA, branch fast-forwards, $tagged tagged user(s)"
  systemctl is-active --quiet "$UNIT" && ok "$UNIT active (pre)" || echo "note: $UNIT not active before deploy"

  log "step 0: protect .env"
  chmod 600 "$MAIN/.env"; ok "$(stat -c '%a %n' "$MAIN/.env")"

  log "step 1: read-only pre-flight"
  echo "-- world-readable .env files under /root/claude (chmod 600 each; expect none):"
  find /root/claude -maxdepth 5 -name '.env' -perm /o+r -print || true
  echo "-- outside readers of the relations 002 locks down (expect none):"
  grep -rlE 'rest/v1/(ageb_polygons|mun_polygons|ent_polygons|loc_polygons|establecimientos)' /root/claude --include='*.ts' --include='*.tsx' --include='*.js' --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | grep -v denue-data-analysis | grep -v denue-wt || true
  local tp; tp=$(grep -c '^TRUST_PROXY=' "$MAIN/.env" || true)
  [[ $tp -eq 0 ]] || die "TRUST_PROXY is set in .env ($tp); EnvironmentFile would override the drop-in. Remove it first."
  ok "TRUST_PROXY not in .env"
  systemctl stop denue-matview-refresh.timer; ok "matview timer stopped (re-armed in step 8)"
  ask "step 1 output reviewed (no stray .env, no outside readers)? continue to the merge"

  log "step 2: merge (fast-forward) + drop stale dist/"
  git merge --ff-only "$BRANCH"
  rm -rf "$MAIN/dist"
  ok "main now at $(git rev-parse --short HEAD)"

  log "step 3: roles (sage-role.sql, api-role.sql)"
  sqlf "$MAIN/scripts/sage-role.sql"
  sqlf "$MAIN/scripts/api-role.sql"
  echo "(NOTICEs about relations not yet created are expected on the first run)"

  log "step 4: migrations"
  sqlf "$M/024-sage-owner-callkind.sql"
  sqlf "$M/025-sage-audit-cache-cols.sql"
  sqlf "$M/018-mv-sinba-morbidity.sql"
  sqlf "$M/019-censo-views-treemap-geoms.sql"
  sqlf "$M/021-summary-mvs.sql"
  sqlf "$M/002-grants-lockdown.sql"
  log "P06 index (optional, CONCURRENTLY)"
  docker exec supabase-db psql -U postgres -d postgres -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ageb_polygons_ent_mun ON ageb_polygons (cve_ent, cve_mun)"
  if [[ $hold_heavy -eq 1 ]]; then
    echo "HELD (--hold-heavy): 009, 014, 020. Run them later in this order: $0 heavy"
  else
    phase_heavy
  fi

  log "step 6: systemd drop-ins (take effect at the restart)"
  mkdir -p /etc/systemd/system/$UNIT.service.d
  printf '[Service]\nEnvironment=TRUST_PROXY=1\n' > /etc/systemd/system/$UNIT.service.d/trust-proxy.conf
  printf '[Service]\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=full\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nLockPersonality=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK\n' > /etc/systemd/system/$UNIT.service.d/hardening.conf
  systemctl daemon-reload
  ok "drop-ins written"

  log "step 7: the single restart"
  systemctl restart "$UNIT"; sleep 20
  systemctl is-active "$UNIT" || die "$UNIT not active after restart; journalctl -u $UNIT -n 100"
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")
  [[ $code == 200 ]] || die "/health returned $code"
  local since; since=$(systemctl show -p ActiveEnterTimestamp --value "$UNIT")
  journalctl -u "$UNIT" --since "$since" --no-pager -o cat | grep -E 'TRUST_PROXY|current_ano resolved from data:|fell back to static' || true
  local res fb
  res=$(journalctl -u "$UNIT" --since "$since" --no-pager -o cat | grep -c 'current_ano resolved from data:' || true)
  fb=$(journalctl -u "$UNIT" --since "$since" --no-pager -o cat | grep -c 'current_ano resolver fell back to static' || true)
  echo "resolved-from-data=$res (expect 2)  fell-back=$fb (expect 0)"
  [[ $fb -eq 0 ]] || die "a resolver fell back to static: DB unreachable, missing role or GRANT (check step 3)"
  systemd-analyze security "$UNIT" | tail -1
  ok "restart healthy"

  log "step 8: web build, re-arm the timer"
  (cd "$MAIN/web" && npm run build)
  systemctl start denue-matview-refresh.timer
  ok "web built, timer armed"

  phase_smoke
  print_manual
}

# 009 -> 014 -> 020, in that order (heavy IO on the 13 GB heap)
phase_heavy() {
  log "009 trigram index (minutes of IO)"
  sqlf "$M/009-trgm-index.sql"
  local valid; valid=$("${PSQL_RO[@]}" "SELECT indisvalid FROM pg_index WHERE indexrelid='idx_estab_nombre_trgm'::regclass")
  [[ $valid == t ]] || die "idx_estab_nombre_trgm INVALID: DROP INDEX CONCURRENTLY idx_estab_nombre_trgm; then re-run 009 (then 014, 020)"
  log "014 trigger + per-entidad backfill + refresh MVs"
  sqlf "$M/014-estab-updated-at-trigger.sql"
  sqlf "$M/014-estab-scian-municipio-backfill.sql"
  (cd "$MAIN" && ./scripts/refresh-matviews.sh)
  log "020 index hygiene"
  sqlf "$M/020-indexes.sql"
  ok "heavy migrations done"
}

# ---------------------------------------------------------------- gotrue (step 5 / G2)
phase_gotrue() {
  log "step 5 / G2: close GoTrue self-signup on the SHARED instance"
  echo "current values (record them for rollback):"
  grep -E '^(DISABLE_SIGNUP|ENABLE_EMAIL_AUTOCONFIRM)=' /opt/supabase/.env || echo "(neither key present)"
  ask "confirmed no other app on db.mycommit.net needs self-signup?"
  cp -a /opt/supabase/.env "/opt/supabase/.env.bak-$(date +%Y%m%d-%H%M%S)"
  for kv in DISABLE_SIGNUP=true ENABLE_EMAIL_AUTOCONFIRM=false; do
    k=${kv%%=*}
    if grep -q "^$k=" /opt/supabase/.env; then sed -i "s|^$k=.*|$kv|" /opt/supabase/.env; else echo "$kv" >> /opt/supabase/.env; fi
  done
  grep -E '^(DISABLE_SIGNUP|ENABLE_EMAIL_AUTOCONFIRM)=' /opt/supabase/.env
  (cd /opt/supabase && docker compose up -d auth)
  ok "auth recreated. Rollback: restore the two values from the .bak, then docker compose up -d auth"
}

# ---------------------------------------------------------------- smoke + verify (step 11)
phase_smoke() {
  log "step 11 smoke: every psql-backed route (expect 200; tile may be 204)"
  local key; key=$(grep -E '^API_KEY=' "$MAIN/.env" | cut -d= -f2-)
  [[ -n $key ]] || die "API_KEY missing in $MAIN/.env"
  local bad=0 p code
  for p in /entidades /sectors /summary/sector/46 /summary/entidad/09 '/analytics/municipios?entidad=09' '/analytics/agebs-by-municipio?cve_mun=09007' '/analytics/ageb-detail?cvegeo=0900700010010' '/analytics/risk-summary?entidad=09' '/analytics/mortality-trend?cve_mun=09007' '/analytics/localities-by-municipio?cve_mun=09007' '/search?q=farmacia&limit=5' '/tiles/10/230/455'; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Api-Key: $key" "http://127.0.0.1:$PORT$p")
    printf '%s %s\n' "$code" "$p"
    [[ $code == 200 || ( $code == 204 && $p == /tiles/* ) ]] || bad=$((bad+1))
  done
  [[ $bad -eq 0 ]] || die "$bad route(s) failed. 5xx = server fault; 'permission denied for' in the journal = missed GRANT (re-run api-role.sql)"
  ok "all routes healthy"
}

phase_verify() {
  phase_smoke
  log "P01/#110: Sage session is non-superuser and cannot read the masked settings"
  local who len
  who=$(docker exec supabase-db psql -U denue_sage -d postgres -tAc "SELECT current_user||'|'||current_setting('is_superuser')")
  [[ $who == 'denue_sage|off' ]] || die "expected denue_sage|off, got: $who"
  len=$(docker exec supabase-db psql -U denue_sage -d postgres -tAc "SELECT length(current_setting('app.service_role_key', true))||'|'||length(current_setting('app.webhook_url', true))")
  [[ $len == '0|0' ]] || die "masked settings readable ($len): re-run scripts/sage-role.sql"
  ok "denue_sage: $who, masked lengths $len"
  log "DB checks (read-only)"
  echo "invalid ageb polygons (expect 0): $("${PSQL_RO[@]}" "SELECT count(*) FROM ageb_polygons WHERE NOT ST_IsValid(geom)")"
  echo "mv_national_treemap rows (expect 32): $("${PSQL_RO[@]}" "SELECT count(*) FROM mv_national_treemap")"
  echo "summary MVs: $("${PSQL_RO[@]}" "SELECT to_regclass('mv_sector_summary')||' '||to_regclass('mv_estrato_por_entidad')||' rows='||(SELECT count(*) FROM mv_sector_summary)")"
  echo "sinba MV: $("${PSQL_RO[@]}" "SELECT to_regclass('mv_sinba_morbidity_municipal')")"
  echo "P14 mislabeled farmacias (224 before, 0 after 014): $("${PSQL_RO[@]}" "SELECT count(*) FROM establecimientos WHERE entidad='09' AND clase_actividad_id='464111' AND clase_actividad NOT ILIKE '%farmacia%'")"
  echo "P02 leaked grants (expect 0): $("${PSQL_RO[@]}" "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated','trustr_app') AND table_name IN ('ageb_polygons','mun_polygons','ent_polygons','loc_polygons','establecimientos','establecimientos_geo','mv_coverage')")"
  echo "role timeouts:"; "${PSQL_RO[@]}" "SELECT rolname||' '||coalesce(array_to_string(rolconfig,','),'-') FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')"
  echo "trgm index valid: $("${PSQL_RO[@]}" "SELECT coalesce((SELECT indisvalid::text FROM pg_index WHERE indexrelid=to_regclass('idx_estab_nombre_trgm')),'missing (009 held)')")"
  log "web build artefacts"
  ls -l "$MAIN"/web/dist/assets/index-*.js 2>/dev/null || true
  echo "sourcemaps in dist (expect 0): $(ls "$MAIN"/web/dist/assets/*.map 2>/dev/null | wc -l)"
  log "edge headers (only after step 9 / Caddy)"
  curl -sI https://uncharted.eurekamd.cloud/ | grep -iE 'strict-transport|x-frame|content-security|x-content-type' || echo "(none yet: step 9 pending)"
  echo "Manual: tagged user 200 / untagged 401 on /api; sign-out + 1 h token refresh; /map console has no CSP violations."
}

print_manual() {
  cat <<EOF

================ STILL MANUAL (runbook steps 5, 9, 10) ================
step 5  GoTrue self-signup:   $0 gotrue      (after confirming no other app needs signup)
step 9  Caddy: paste the header block, the @maps 404 matcher (INSIDE handle /assets/*)
        and the minisu-catalog sandbox headers from
        $MAIN/ops/Caddyfile.uncharted
        into the uncharted.eurekamd.cloud block of /etc/caddy/Caddyfile, then:
        caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy && cd /etc/caddy && git commit -am 'uncharted: security headers, CSP report-only, block sourcemaps, sandbox minisu-catalog'
step 10 #110 durable fix: (a) move the key notify_jarvis() sends out of app.service_role_key,
        (b) ALTER DATABASE postgres RESET app.service_role_key, (c) rotate JWT_SECRET/ANON_KEY/
        SERVICE_ROLE_KEY in /opt/supabase/.env with EVERY app owner on db.mycommit.net.
        Full text: $MAIN/docs/DEPLOY-2026-09-26-AUDIT-REFACTOR.md, "Step 10".
Rollback (code only): cd $MAIN && git reset --hard $BASE_SHA && systemctl restart $UNIT && cd web && npm run build
=======================================================================
EOF
}

case ${1:-} in
  push)   phase_push ;;
  tag)    shift; phase_tag "$@" ;;
  deploy) shift; phase_deploy "$@" ;;
  heavy)  phase_heavy ;;
  gotrue) phase_gotrue ;;
  verify) phase_verify ;;
  all)    phase_push; phase_deploy; phase_verify ;;
  *)      sed -n '2,14p' "$0"; exit 1 ;;
esac
