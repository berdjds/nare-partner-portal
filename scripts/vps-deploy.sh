#!/usr/bin/env bash
#
# Deploy gate for wa.hayk (W1, task deploy-gate). Runs ON THE VPS, invoked by
# .github/workflows/ci-cd.yml: the workflow uploads the source tarball and
# pipes this script to `bash -s` over ssh (it ships inside the tarball, so it
# always matches the candidate being deployed).
#
# Sequence:
#   1. extract the uploaded source, sync docker-compose.yml, build
#      wacontrol:candidate WHILE the app keeps serving
#   2. tag the running image wacontrol:previous
#   3. assert no OTHER container mounts the three data dirs
#   4. WRITE FREEZE: stop wacontrol-app (HTTP writes, the in-process WhatsApp
#      client and all background jobs; seeds run only through this script);
#      freeze start/end are logged with UTC timestamps
#   5. archive wacontrol-data/-uploads/-auth to backups/wacontrol-<UTC>.tar.gz
#      (+ .sha256, verified with tar -tzf, pruned to 14 days); on failure abort
#      and restart the old container
#   6. TRIAL A: candidate in trial mode (no Traefik labels, no auth dir) on a
#      temporary copy of the data: entrypoint `prisma db push` (never with
#      --accept-data-loss), bootstrap seeds, internal health check (/login
#      must return 200). Failure -> remove trial, restart old container on the
#      untouched data, exit 1
#   7. TRIAL B: previous image in trial mode on the MIGRATED copy; its health
#      check decides ROLLBACK_COMPATIBLE=yes|no (yes also when the schema is
#      unchanged)
#   8. CUTOVER: start the candidate on the real data (writes accepted from
#      here), internal health check, bootstrap seeds
#   9. POST-CUTOVER FAILURE: ROLLBACK_COMPATIBLE=yes -> stop the candidate and
#      start wacontrol:previous on the CURRENT data (newly accepted data is
#      kept; nothing is restored from backup); =no -> stop the candidate, do
#      NOT restore anything automatically, print the manual recovery
#      procedure (export-since, then fix forward or restore-backup), exit 1
#
# Hard rule: two containers never mount the same auth dir or data dir at the
# same time — the app is frozen before any trial runs, and each trial runs
# alone on its own private copy.
#
# Paths stay /root/productionapp as today; no hostnames or secrets in this
# script. Container secrets are interpolated by docker compose from
# /root/productionapp/.env (same source as the production compose project).
# Optional env overrides (used by tests): WACONTROL_APP_ROOT, WACONTROL_SOURCE_TARBALL,
# WACONTROL_HEALTH_RETRIES, WACONTROL_HEALTH_INTERVAL_SECONDS, image/container names.

set -euo pipefail

APP_ROOT="${WACONTROL_APP_ROOT:-/root/productionapp}"
SRC_DIR="$APP_ROOT/wacontrol-src"
DATA_DIR="$APP_ROOT/wacontrol-data"
UPLOADS_DIR="$APP_ROOT/wacontrol-uploads"
AUTH_DIR="$APP_ROOT/wacontrol-auth"
BACKUP_DIR="$APP_ROOT/backups"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
ENV_FILE="${WACONTROL_ENV_FILE:-$APP_ROOT/.env}"
SOURCE_TARBALL="${WACONTROL_SOURCE_TARBALL:-$APP_ROOT/wacontrol-source.tar.gz}"

APP_CONTAINER="${WACONTROL_APP_CONTAINER:-wacontrol-app}"
CANDIDATE_IMAGE="${WACONTROL_CANDIDATE_IMAGE:-wacontrol:candidate}"
PREVIOUS_IMAGE="${WACONTROL_PREVIOUS_IMAGE:-wacontrol:previous}"
LATEST_IMAGE="${WACONTROL_LATEST_IMAGE:-wacontrol:latest}"

BACKUP_KEEP_DAYS="${WACONTROL_BACKUP_KEEP_DAYS:-14}"
HEALTH_RETRIES="${WACONTROL_HEALTH_RETRIES:-30}"
HEALTH_INTERVAL_SECONDS="${WACONTROL_HEALTH_INTERVAL_SECONDS:-3}"

TRIAL_A_CONTAINER="wacontrol-trial-a"
TRIAL_B_CONTAINER="wacontrol-trial-b"
TRIAL_A_PORT="${WACONTROL_TRIAL_A_PORT:-13001}"
TRIAL_B_PORT="${WACONTROL_TRIAL_B_PORT:-13002}"

APP_WAS_RUNNING="false"
CURRENT_IMAGE="$LATEST_IMAGE"
BACKUP_FILE=""
FREEZE_START_TS=""
ROLLBACK_COMPATIBLE="no"
WORK_DIR=""

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

cleanup() {
  # Best-effort removal of trial leftovers; never masks the exit code.
  if [ -n "$WORK_DIR" ]; then
    docker rm -f "$TRIAL_A_CONTAINER" "$TRIAL_B_CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

# Internal health check: the image has no curl, but it does have Node 20 with
# global fetch. The container probes its own HTTP server, so no port has to be
# published beyond localhost and no external URL is needed.
container_login_ok() {
  docker exec "$1" node -e \
    "fetch('http://127.0.0.1:3000/login').then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))" \
    < /dev/null
}

wait_for_login() {
  local container="$1"
  local attempt
  for attempt in $(seq 1 "$HEALTH_RETRIES"); do
    if container_login_ok "$container"; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  return 1
}

run_bootstrap_seeds() {
  # $1 = container name. Bootstrap-only seeds (they self-skip when the catalog
  # is populated); failures must be loud — a silently skipped seed once left
  # the production catalog empty.
  local container="$1"
  docker exec "$container" npm run db:seed < /dev/null
  docker exec "$container" npx tsx scripts/seed-travel-catalog.ts < /dev/null
}

write_trial_compose_file() {
  cat > "$WORK_DIR/trial-compose.yml" <<'YML'
# Generated by scripts/vps-deploy.sh — isolated trial containers for the
# deploy gate: no Traefik labels, no auth dir, bound to localhost only.
# Keep the environment mapping in sync with docker-compose.yml.
services:
  app:
    image: ${TRIAL_IMAGE:?TRIAL_IMAGE is required}
    container_name: ${TRIAL_CONTAINER_NAME:?TRIAL_CONTAINER_NAME is required}
    restart: "no"
    environment:
      - NODE_ENV=production
      - HOSTNAME=0.0.0.0
      - PORT=3000
      - DATABASE_URL=file:/app/data/dev.db
      - NEXTAUTH_URL=http://127.0.0.1:${TRIAL_PORT:?TRIAL_PORT is required}
      - NEXTAUTH_SECRET=${WACONTROL_NEXTAUTH_SECRET:?WACONTROL_NEXTAUTH_SECRET must be set in .env}
      - ADMIN_EMAIL=${WACONTROL_ADMIN_EMAIL:?WACONTROL_ADMIN_EMAIL must be set in .env}
      - ADMIN_PASSWORD=${WACONTROL_ADMIN_PASSWORD:?WACONTROL_ADMIN_PASSWORD must be set in .env}
      - PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
      - WACONTROL_MODE=trial
      - WACONTROL_NOTIFICATIONS_PAUSED=${WACONTROL_NOTIFICATIONS_PAUSED:-1}
    volumes:
      - ${TRIAL_DATA_DIR:?TRIAL_DATA_DIR is required}:/app/data
      - ${TRIAL_UPLOADS_DIR:?TRIAL_UPLOADS_DIR is required}:/app/public/uploads
    ports:
      - 127.0.0.1:${TRIAL_PORT:?}:3000
YML
}

write_rollback_compose_file() {
  cat > "$WORK_DIR/rollback-compose.yml" <<EOF
# Generated by scripts/vps-deploy.sh: restart the previously running image on
# the CURRENT data dirs (compose merge overrides only the image reference).
services:
  wacontrol_app:
    image: $PREVIOUS_IMAGE
EOF
}

run_trial_container() {
  local image="$1"
  local name="$2"
  local port="$3"
  local data_dir="$4"
  local uploads_dir="$5"
  local env_args=()
  if [ -f "$ENV_FILE" ]; then
    env_args=(--env-file "$ENV_FILE")
  fi
  # The trial image's entrypoint applies `prisma db push` (never with
  # --accept-data-loss) when the container starts.
  TRIAL_IMAGE="$image" \
    TRIAL_CONTAINER_NAME="$name" \
    TRIAL_PORT="$port" \
    TRIAL_DATA_DIR="$data_dir" \
    TRIAL_UPLOADS_DIR="$uploads_dir" \
    docker compose "${env_args[@]}" -p "$name" -f "$WORK_DIR/trial-compose.yml" up -d app
}

remove_trial_container() {
  local name="$1"
  local env_args=()
  if [ -f "$ENV_FILE" ]; then
    env_args=(--env-file "$ENV_FILE")
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  # Also drop the trial project's network so repeated deploys don't litter.
  docker compose "${env_args[@]}" -p "$name" -f "$WORK_DIR/trial-compose.yml" down >/dev/null 2>&1 || true
}

assert_exclusive_data_mounts() {
  # Nobody but the app container may mount the data dirs: two writers on one
  # SQLite file / WhatsApp auth dir corrupts both.
  local app_id=""
  local running
  local c
  local mounts
  local src
  if docker inspect "$APP_CONTAINER" >/dev/null 2>&1; then
    app_id="$(docker inspect -f '{{.Id}}' "$APP_CONTAINER" 2>/dev/null || true)"
  fi
  running="$(docker ps -q)"
  while IFS= read -r c; do
    if [ -z "$c" ] || [ "$c" = "$app_id" ]; then
      continue
    fi
    mounts="$(docker inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$c" 2>/dev/null || true)"
    while IFS= read -r src; do
      if [ -z "$src" ]; then
        continue
      fi
      case "$src" in
        "$DATA_DIR" | "$DATA_DIR"/* | "$UPLOADS_DIR" | "$UPLOADS_DIR"/* | "$AUTH_DIR" | "$AUTH_DIR"/*)
          die "container $c mounts '$src'; refusing to deploy while another container uses a data dir"
          ;;
      esac
    done <<< "$mounts"
  done <<< "$running"
  log "no other container mounts the data dirs"
}

backup_data_dirs() {
  # Called in a condition context (set -e is suspended): every critical step
  # fails explicitly with `|| return 1`.
  local stamp
  local backup
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$BACKUP_DIR/wacontrol-$stamp.tar.gz"
  mkdir -p "$BACKUP_DIR" || return 1
  log "backup: archiving data dirs to $backup"
  tar -czf "$backup" -C "$APP_ROOT" wacontrol-data wacontrol-uploads wacontrol-auth || return 1
  tar -tzf "$backup" >/dev/null || return 1
  sha256sum "$backup" > "$backup.sha256" || return 1
  # Pruning failure must not abort the deploy.
  find "$BACKUP_DIR" \( -name 'wacontrol-*.tar.gz' -o -name 'wacontrol-*.tar.gz.sha256' \) -type f -mtime +"$BACKUP_KEEP_DAYS" -delete || true
  BACKUP_FILE="$backup"
  log "backup: verified $(basename "$backup") (sha256 recorded, backups older than $BACKUP_KEEP_DAYS days pruned)"
  return 0
}

restart_frozen_app() {
  if [ "$APP_WAS_RUNNING" != "true" ]; then
    log "the app container was not running before the freeze; nothing to restart"
    return 0
  fi
  log "restarting $APP_CONTAINER on its untouched data"
  if docker start "$APP_CONTAINER"; then
    if wait_for_login "$APP_CONTAINER"; then
      log "app container is back and serving"
    else
      log "warning: restarted app container did not pass the health check — inspect $APP_CONTAINER" >&2
    fi
  else
    log "ERROR: failed to restart $APP_CONTAINER — the app is DOWN" >&2
  fi
}

print_manual_recovery_procedure() {
  cat >&2 <<EOF
======================================================================
MANUAL RECOVERY PROCEDURE (no automatic restore was performed)
======================================================================
The candidate container was stopped. The data dirs hold everything the
candidate accepted after cutover PLUS all pre-deploy data.

Pre-deploy backup: $BACKUP_FILE
                   ($BACKUP_FILE.sha256)
Freeze started:    $FREEZE_START_TS

1. export-since: capture the rows written after the freeze before any
   restore — extract the backup to a scratch dir and diff against the
   current data dirs, or export the new rows from the current database.
2. Then choose exactly ONE:
   a) fix forward: build a fixed candidate and re-run
      scripts/vps-deploy.sh — it will freeze, back up the CURRENT data
      (including the newly accepted rows) and gate the deploy again.
   b) restore-backup: stop the app container, manually extract
      $BACKUP_FILE into $APP_ROOT, then start $PREVIOUS_IMAGE on the
      restored data and re-apply the export-since output.
======================================================================
EOF
}

cutover_failed() {
  log "CUTOVER FAILED: $1" >&2
  if [ "$ROLLBACK_COMPATIBLE" = "yes" ]; then
    log "rolling back: starting $PREVIOUS_IMAGE on the CURRENT data (newly accepted data kept; nothing is restored from backup)" >&2
    write_rollback_compose_file
    if compose -f "$WORK_DIR/rollback-compose.yml" up -d wacontrol_app; then
      docker tag "$PREVIOUS_IMAGE" "$LATEST_IMAGE" || log "warning: failed to retag $LATEST_IMAGE back to $PREVIOUS_IMAGE" >&2
      if wait_for_login "$APP_CONTAINER"; then
        log "rollback OK: $APP_CONTAINER serves $PREVIOUS_IMAGE with all data kept"
      else
        log "warning: rollback container did not pass the health check — inspect $APP_CONTAINER" >&2
      fi
    else
      log "ERROR: rollback failed to start $PREVIOUS_IMAGE — manual recovery required" >&2
    fi
  else
    log "ROLLBACK_COMPATIBLE=no: stopping the candidate and leaving the data exactly as the candidate wrote it" >&2
    docker stop "$APP_CONTAINER" >/dev/null 2>&1 || true
    print_manual_recovery_procedure
  fi
  exit 1
}

main() {
  command -v docker >/dev/null 2>&1 || die "docker is required on PATH"
  [ -f "$SOURCE_TARBALL" ] || die "source tarball not found: $SOURCE_TARBALL"
  [ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE"
  mkdir -p "$DATA_DIR" "$UPLOADS_DIR" "$AUTH_DIR" || die "failed to create data dirs"

  # --- 1. extract + build while the app runs ---------------------------------
  log "deploy gate: extracting $(basename "$SOURCE_TARBALL")"
  rm -rf "${SRC_DIR:?}"
  mkdir -p "$SRC_DIR" || die "failed to create $SRC_DIR"
  tar -xzf "$SOURCE_TARBALL" -C "$SRC_DIR" || die "failed to extract the source tarball"
  rm -f "$SOURCE_TARBALL"

  # Keep the compose file in sync with the repo, backing up any local variant.
  if [ ! -f "$COMPOSE_FILE" ] || ! cmp -s "$SRC_DIR/docker-compose.yml" "$COMPOSE_FILE" 2>/dev/null; then
    if [ -f "$COMPOSE_FILE" ]; then
      cp "$COMPOSE_FILE" "$COMPOSE_FILE.bak-$(date -u +%Y%m%dT%H%M%SZ)" || true
    fi
    cp "$SRC_DIR/docker-compose.yml" "$COMPOSE_FILE" || die "failed to sync docker-compose.yml"
  fi

  log "building $CANDIDATE_IMAGE while $APP_CONTAINER keeps serving"
  docker build -t "$CANDIDATE_IMAGE" "$SRC_DIR" || die "candidate build failed; the running app is untouched"

  # --- 2. tag the running image as previous ----------------------------------
  if docker inspect "$APP_CONTAINER" >/dev/null 2>&1; then
    if [ "$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null || true)" = "true" ]; then
      APP_WAS_RUNNING="true"
      CURRENT_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$APP_CONTAINER" 2>/dev/null || true)"
      [ -n "$CURRENT_IMAGE" ] || die "could not determine the image of the running $APP_CONTAINER"
    fi
  fi
  docker tag "$CURRENT_IMAGE" "$PREVIOUS_IMAGE" || die "failed to tag $CURRENT_IMAGE as $PREVIOUS_IMAGE"
  log "tagged $CURRENT_IMAGE as $PREVIOUS_IMAGE (rollback target)"

  # --- 3. nobody else may mount the data dirs --------------------------------
  assert_exclusive_data_mounts

  WORK_DIR="$(mktemp -d "$APP_ROOT/.deploy.XXXXXX")" || die "failed to create a work dir"
  write_trial_compose_file

  # --- 4. WRITE FREEZE ---------------------------------------------------------
  FREEZE_START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "WRITE FREEZE start $FREEZE_START_TS: stopping $APP_CONTAINER (HTTP writes, the WhatsApp client and all background jobs stop; seeds run only through this script)"
  if [ "$APP_WAS_RUNNING" = "true" ]; then
    docker stop "$APP_CONTAINER" || die "failed to stop $APP_CONTAINER"
  fi
  log "WRITE FREEZE end $(date -u +%Y-%m-%dT%H:%M:%SZ): all writers stopped"

  # --- 5. backup ---------------------------------------------------------------
  if ! backup_data_dirs; then
    log "backup failed — aborting the deploy and restarting the old container on untouched data" >&2
    restart_frozen_app
    exit 1
  fi

  # --- 6. TRIAL A: candidate on a temporary copy of the data -------------------
  TRIAL_DATA="$WORK_DIR/trial-data"
  mkdir -p "$TRIAL_DATA/data" "$TRIAL_DATA/uploads" || { restart_frozen_app; exit 1; }
  cp -a "$DATA_DIR/." "$TRIAL_DATA/data/" || { restart_frozen_app; exit 1; }
  cp -a "$UPLOADS_DIR/." "$TRIAL_DATA/uploads/" || { restart_frozen_app; exit 1; }

  if ! run_trial_container "$CANDIDATE_IMAGE" "$TRIAL_A_CONTAINER" "$TRIAL_A_PORT" "$TRIAL_DATA/data" "$TRIAL_DATA/uploads" \
    || ! wait_for_login "$TRIAL_A_CONTAINER" \
    || ! run_bootstrap_seeds "$TRIAL_A_CONTAINER"; then
    log "TRIAL A failed — removing the trial container and restarting the old container on the untouched data" >&2
    remove_trial_container "$TRIAL_A_CONTAINER"
    restart_frozen_app
    exit 1
  fi
  remove_trial_container "$TRIAL_A_CONTAINER"
  log "TRIAL A passed: candidate migrated the copy, bootstrap seeds ran, /login is 200"

  # --- 7. TRIAL B: previous image on the migrated copy --------------------------
  if run_trial_container "$PREVIOUS_IMAGE" "$TRIAL_B_CONTAINER" "$TRIAL_B_PORT" "$TRIAL_DATA/data" "$TRIAL_DATA/uploads" \
    && wait_for_login "$TRIAL_B_CONTAINER"; then
    ROLLBACK_COMPATIBLE="yes"
  fi
  remove_trial_container "$TRIAL_B_CONTAINER"
  log "ROLLBACK_COMPATIBLE=$ROLLBACK_COMPATIBLE (previous image $PREVIOUS_IMAGE on the migrated copy)"

  # --- 8. CUTOVER: candidate on the real data -----------------------------------
  log "CUTOVER: starting the candidate on the real data (writes accepted from here)"
  docker tag "$CANDIDATE_IMAGE" "$LATEST_IMAGE" || cutover_failed "failed to tag $CANDIDATE_IMAGE as $LATEST_IMAGE"
  if ! compose up -d wacontrol_app; then
    cutover_failed "docker compose failed to start the candidate"
  fi
  if ! wait_for_login "$APP_CONTAINER"; then
    cutover_failed "$APP_CONTAINER did not serve /login (HTTP 200) after cutover"
  fi
  if ! run_bootstrap_seeds "$APP_CONTAINER"; then
    cutover_failed "bootstrap seeds failed after cutover"
  fi
  log "CUTOVER complete: $APP_CONTAINER runs $CANDIDATE_IMAGE; bootstrap seeds ran"
  log "deploy finished successfully (ROLLBACK_COMPATIBLE=$ROLLBACK_COMPATIBLE, backup: $BACKUP_FILE)"
}

main "$@"
