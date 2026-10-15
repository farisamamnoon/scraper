#!/usr/bin/env bash
# Test database with real data, for API and browser testing of mapping and batching.
#
# A Postgres container (TLS, 127.0.0.1:5433) holds a snapshot of the local data.
# `serve` runs this checkout's scraper against it with TELEGRAM_OFFLINE=true:
# no Telegram login, no importer, so it never touches the dev session.
# `reset` puts the database back to the snapshot in a few seconds.
#
# Usage: scripts/test-db.sh <command>
#   snapshot [file]  Dump the source DB (or copy a pg_dump -Fc file) to the snapshot, then reset
#   up               Start the container; first run builds certs and restores the snapshot
#   reset            Drop all changes: recreate the test DB from the snapshot
#   serve            Start the offline scraper API in the background (port below)
#   stop             Stop the scraper API
#   ui [dir]         serve, then the mapper UI (yarn dev, dir default: the UI checkout) on UI_PORT
#   ui-stop          Stop the mapper UI
#   drop             Stop this API and UI, delete this DB, its logs and /tmp/test-db-<db>
#   env              Print API URL, dashboard password, UI_PORT, SCRATCH
#   down             Stop the API and the container (data stays)
#   status           Show container, DB row counts, API state
#   psql [args]      Open psql on the test DB
#
# Parallel sessions: give each one its own DB, so a reset in one session
# leaves the others alone. All of them clone the same snapshot. The API port
# is derived from the name (3101-3199) unless TEST_API_PORT is set:
#   TEST_DB_NAME=telegram_test_mapper scripts/test-db.sh serve
#
# Data (real channel data, never committed) lives in $SCRAPER_TEST_DATA,
# default ~/.local/share/telegram-scraper/test-db.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${SCRAPER_TEST_DATA:-$HOME/.local/share/telegram-scraper/test-db}"
CONTAINER="${TEST_PG_CONTAINER:-scraper-test-pg}"
PG_PORT="${TEST_PG_PORT:-5433}"
DB="${TEST_DB_NAME:-telegram_test}"
# The default DB serves on 3100; any other DB gets a stable port from its name.
if [ -n "${TEST_API_PORT:-}" ]; then API_PORT="$TEST_API_PORT"
elif [ "$DB" = telegram_test ]; then API_PORT=3100
else API_PORT=$((3101 + $(printf '%s' "$DB" | cksum | cut -d' ' -f1) % 99)); fi
TEMPLATE=telegram_test_template
SOURCE_CONTAINER="${SNAPSHOT_SOURCE_CONTAINER:-scraper-local-pg}"
SOURCE_DB="${SNAPSHOT_SOURCE_DB:-telegram_archive}"
IMAGE=postgres:18-alpine

SNAPSHOT="$DATA/snapshot.dump"
[[ "$DB" =~ ^[a-z_][a-z0-9_]*$ && "$DB" != "$TEMPLATE" ]] || { echo "[test-db] error: bad TEST_DB_NAME '$DB'" >&2; exit 1; }
PIDFILE="$DATA/api-$API_PORT.pid"
LOG="$DATA/api-$API_PORT.log"
UI_PORT=$((API_PORT + 1000))
UI_PIDFILE="$DATA/ui-$UI_PORT.pid"
UI_LOG="$DATA/ui-$UI_PORT.log"
# Per-session scratch dir (cookies, browser scripts, screenshots); `drop` deletes it.
SCRATCH="/tmp/test-db-$DB"

log() { printf '[test-db] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
psql_c() { docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q "$@"; }

ensure_secrets() {
  mkdir -p "$DATA/certs"
  chmod 700 "$DATA"
  [ -s "$DATA/pgpass" ] || { openssl rand -hex 16 > "$DATA/pgpass"; chmod 600 "$DATA/pgpass"; }
  [ -s "$DATA/dashboard_password" ] || { openssl rand -hex 12 > "$DATA/dashboard_password"; chmod 600 "$DATA/dashboard_password"; }
  if [ ! -s "$DATA/certs/server.crt" ]; then
    log "creating self-signed TLS certificate (localhost, 127.0.0.1)"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=localhost \
      -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
      -keyout "$DATA/certs/server.key" -out "$DATA/certs/server.crt" 2>/dev/null
    chmod 600 "$DATA/certs/server.key"
  fi
}

container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; }

wait_pg() {
  for _ in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && return 0
    sleep 1
  done
  die "Postgres in $CONTAINER did not become ready"
}

db_exists() { [ "$(psql_c -Atc "select 1 from pg_database where datname='$1'")" = 1 ]; }

# Restore the snapshot into the template DB. Nobody connects to the template,
# so `reset` can clone it with CREATE DATABASE … TEMPLATE.
load_template() {
  [ -s "$SNAPSHOT" ] || die "no snapshot at $SNAPSHOT. Run: scripts/test-db.sh snapshot"
  log "restoring snapshot into $TEMPLATE"
  psql_c -c "DROP DATABASE IF EXISTS $TEMPLATE WITH (FORCE)" -c "CREATE DATABASE $TEMPLATE"
  docker exec -i "$CONTAINER" pg_restore -U postgres -d "$TEMPLATE" --no-owner --no-acl --exit-on-error < "$SNAPSHOT"
}

cmd_reset() {
  container_running || cmd_up_container
  db_exists "$TEMPLATE" || load_template
  log "recreating $DB from $TEMPLATE"
  psql_c -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $TEMPLATE"
}

cmd_up_container() {
  ensure_secrets
  if container_running; then return 0; fi
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    log "starting existing container $CONTAINER"
    docker start "$CONTAINER" >/dev/null
  else
    log "creating container $CONTAINER on 127.0.0.1:$PG_PORT"
    docker run -d --name "$CONTAINER" \
      -p "127.0.0.1:$PG_PORT:5432" \
      -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$(cat "$DATA/pgpass")" -e POSTGRES_DB=postgres \
      -v "$DATA/certs:/certs:ro" -v scraper_test_pgdata:/var/lib/postgresql \
      "$IMAGE" sh -c 'cp /certs/server.crt /certs/server.key /tmp/ && chown postgres /tmp/server.* && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key' >/dev/null
  fi
  wait_pg
}

cmd_up() {
  cmd_up_container
  db_exists "$DB" || cmd_reset
  log "ready: postgres://postgres@localhost:$PG_PORT/$DB (TLS)"
}

cmd_snapshot() {
  ensure_secrets
  local tmp="$SNAPSHOT.tmp"
  if [ $# -ge 1 ]; then
    log "copying $1 to the snapshot"
    cp "$1" "$tmp"
  else
    container_running_src=$(docker inspect -f '{{.State.Running}}' "$SOURCE_CONTAINER" 2>/dev/null || true)
    [ "$container_running_src" = true ] || die "source container $SOURCE_CONTAINER is not running"
    log "dumping $SOURCE_CONTAINER/$SOURCE_DB"
    docker exec "$SOURCE_CONTAINER" pg_dump -U postgres -Fc --no-owner --no-acl "$SOURCE_DB" > "$tmp"
  fi
  mv "$tmp" "$SNAPSHOT"
  log "snapshot: $SNAPSHOT ($(du -h "$SNAPSHOT" | cut -f1))"
  cmd_up_container
  load_template
  cmd_reset
}

api_pid() { [ -s "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && cat "$PIDFILE"; }

cmd_serve() {
  cmd_up
  mkdir -p "$SCRATCH"
  if pid=$(api_pid); then log "API already running (pid $pid) on http://localhost:$API_PORT"; return 0; fi
  # .env gives TELEGRAM_API_ID/HASH (required by config) and the S3 settings that serve media.
  # A worktree has no .env, so fall back to the main checkout's.
  local env_file="$REPO/.env"
  [ -f "$env_file" ] || env_file="$(git -C "$REPO" worktree list --porcelain | sed -n '1s/^worktree //p')/.env"
  [ -f "$env_file" ] || die "no .env in $REPO or the main checkout"
  [ -d "$REPO/node_modules" ] || die "$REPO/node_modules is missing. Run: npm ci"
  port_free "$API_PORT" || die "port $API_PORT is already in use. Pick another TEST_DB_NAME or set TEST_API_PORT"
  log "starting offline scraper from $REPO on :$API_PORT (log: $LOG)"
  (
    cd "$REPO"
    export POSTGRES_HOST=localhost POSTGRES_PORT="$PG_PORT" POSTGRES_DB="$DB" POSTGRES_USER=postgres
    export POSTGRES_PASSWORD="$(cat "$DATA/pgpass")"
    export DASHBOARD_PASSWORD="$(cat "$DATA/dashboard_password")"
    export PORT="$API_PORT" NODE_EXTRA_CA_CERTS="$DATA/certs/server.crt"
    export TELEGRAM_OFFLINE=true TELEGRAM_SESSION=
    export DOTENV_CONFIG_PATH="$env_file"
    exec setsid node -r dotenv/config -r ts-node/register src/index.ts
  ) > "$LOG" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 90); do
    if curl -fs -o /dev/null -X POST -H 'Content-Type: application/json' \
      -d "{\"password\":\"$(cat "$DATA/dashboard_password")\"}" "http://localhost:$API_PORT/api/auth/login"; then
      log "API ready: http://localhost:$API_PORT"
      cmd_env
      return 0
    fi
    api_pid >/dev/null || { tail -20 "$LOG" >&2; die "API exited during boot"; }
    sleep 1
  done
  tail -20 "$LOG" >&2
  die "API did not answer within 90s"
}

cmd_stop() {
  if pid=$(api_pid); then
    log "stopping API (pid $pid)"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
    for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  fi
  rm -f "$PIDFILE"
}

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

ui_pid() { [ -s "$UI_PIDFILE" ] && kill -0 "$(cat "$UI_PIDFILE")" 2>/dev/null && cat "$UI_PIDFILE"; }

# Next dev with this session's API and port. NEXT_DIST_DIR keeps it off the
# developer's own `yarn dev`, which locks .next in the same checkout.
cmd_ui() {
  local main dir
  main="$(git -C "$REPO" worktree list --porcelain | sed -n '1s/^worktree //p')"
  dir="$(cd "${1:-$main/../telegram-pipeline-ui}" && pwd)" || die "UI checkout not found"
  [ -f "$dir/next.config.ts" ] || die "$dir is not the mapper UI checkout"
  [ -d "$dir/node_modules" ] || die "$dir/node_modules is missing. Run: yarn"
  cmd_serve
  if pid=$(ui_pid); then log "UI already running (pid $pid) on http://localhost:$UI_PORT"; return 0; fi
  port_free "$UI_PORT" || die "port $UI_PORT is already in use"
  log "starting UI from $dir on :$UI_PORT (log: $UI_LOG)"
  (
    cd "$dir"
    export PIPELINE_API_URL="http://localhost:$API_PORT" PIPELINE_DASHBOARD_PASSWORD="$(cat "$DATA/dashboard_password")"
    export PORT="$UI_PORT" NEXT_DIST_DIR=.next-test
    exec setsid yarn dev
  ) > "$UI_LOG" 2>&1 < /dev/null &
  echo $! > "$UI_PIDFILE"
  for _ in $(seq 1 120); do
    if curl -fs "http://localhost:$UI_PORT/api/pipeline/channels" | grep -q '"success":true'; then
      log "UI ready: http://localhost:$UI_PORT"
      return 0
    fi
    if grep -q 'Unable to acquire lock' "$UI_LOG"; then
      cmd_ui_stop
      die "another test UI holds $dir/.next-test. Run from a git worktree of the UI instead"
    fi
    ui_pid >/dev/null || { tail -20 "$UI_LOG" >&2; die "UI exited during boot"; }
    sleep 1
  done
  tail -20 "$UI_LOG" >&2
  die "UI did not answer within 120s"
}

cmd_ui_stop() {
  if pid=$(ui_pid); then
    log "stopping UI (pid $pid)"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
    for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  fi
  rm -f "$UI_PIDFILE"
}

cmd_drop() {
  [ "$DB" != telegram_test ] || die "drop is for per-session DBs. Use reset for $DB"
  cmd_ui_stop
  cmd_stop
  rm -f "$LOG" "$UI_LOG"
  rm -rf "$SCRATCH"
  container_running && psql_c -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" && log "dropped $DB"
  true
}

cmd_down() { cmd_ui_stop; cmd_stop; container_running && docker stop "$CONTAINER" >/dev/null && log "stopped $CONTAINER"; true; }

cmd_env() {
  [ -s "$DATA/dashboard_password" ] || die "not set up yet. Run: scripts/test-db.sh serve"
  echo "PIPELINE_API_URL=http://localhost:$API_PORT"
  echo "PIPELINE_DASHBOARD_PASSWORD=$(cat "$DATA/dashboard_password")"
  echo "UI_PORT=$UI_PORT"
  echo "SCRATCH=$SCRATCH"
}

cmd_status() {
  if container_running; then
    echo "container: $CONTAINER running on 127.0.0.1:$PG_PORT"
    if db_exists "$DB"; then
      psql_c -d "$DB" -Atc "select 'channels '||count(*) from telegram_channels union all select 'messages '||count(*) from telegram_messages union all select 'batches '||count(*) from channel_batches union all select 'mappings '||count(*) from channel_mappings" | sed 's/^/  /'
    else echo "  database $DB missing (run: reset)"; fi
  else echo "container: $CONTAINER not running"; fi
  [ -s "$SNAPSHOT" ] && echo "snapshot: $SNAPSHOT ($(du -h "$SNAPSHOT" | cut -f1), $(date -r "$SNAPSHOT" '+%F %T'))" || echo "snapshot: none"
  if pid=$(api_pid); then echo "api: running (pid $pid) http://localhost:$API_PORT"; else echo "api: stopped"; fi
  if pid=$(ui_pid); then echo "ui: running (pid $pid) http://localhost:$UI_PORT"; else echo "ui: stopped"; fi
}

cmd="${1:-status}"; shift || true
case "$cmd" in
  snapshot) cmd_snapshot "$@" ;;
  up) cmd_up ;;
  reset) cmd_reset ;;
  serve) cmd_serve ;;
  stop) cmd_stop ;;
  ui) cmd_ui "$@" ;;
  ui-stop) cmd_ui_stop ;;
  drop) cmd_drop ;;
  down) cmd_down ;;
  status) cmd_status ;;
  env) cmd_env ;;
  psql) container_running || die "container not running"; docker exec -it "$CONTAINER" psql -U postgres -d "$DB" "$@" ;;
  help|-h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
