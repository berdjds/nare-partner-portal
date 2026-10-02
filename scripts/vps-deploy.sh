#!/usr/bin/env bash
#
# Deploy gate for portal.nare.am (W3b, task script-param). Runs ON THE SERVER.
# One-time provisioning installs it as /usr/local/lib/portal-deploy/portal-deploy
# and the CI pipeline can only invoke it through the forced-command dispatcher
# (/usr/local/sbin/portal-deploy-entry) as `deploy <env> <tarball>` — the
# pipeline cannot modify this script, so it cannot widen the deploy authority.
# <env> is `staging` or `production`; anything else is rejected.
#
# Server layout (fixed defaults; every path overridable via PORTAL_* for tests):
#   /opt/stack/docker-compose.yml        caddy + portal compose project
#   /opt/stack/portal/{data,uploads,auth}  live data dirs
#   /opt/stack/portal/src                build context
#   /opt/stack/backups                   verified backups
# Staging is a second compose project under /opt/stack/staging with the same
# relative layout, container portal-staging, URL https://staging.portal.nare.am.
#
# The compose file belongs to provisioning: the deploy gate REFUSES to
# continue when it is missing and never creates, syncs or modifies it.
#
# Sequence (production and staging alike):
#   1. extract the uploaded source into the build context, build
#      $CANDIDATE_IMAGE WHILE the app keeps serving
#   2. tag the running image $PREVIOUS_IMAGE
#   3. assert no OTHER container mounts the three data dirs
#   4. WRITE FREEZE: stop the app container (HTTP writes, the in-process
#      WhatsApp client and all background jobs); freeze start/end are logged
#      with UTC timestamps
#   5. verified backup of the data dirs to portal-<env>-<UTC>.tar.gz
#      (+ .sha256, verified with tar -tzf, pruned to PORTAL_BACKUP_KEEP_DAYS);
#      on failure abort and restart the old container
#   6. TRIAL A: candidate in trial mode (WACONTROL_MODE=trial: no WhatsApp
#      client, no background jobs; no auth dir; localhost-only) on a temporary
#      copy of the data: entrypoint `prisma db push` (never with
#      --accept-data-loss), bootstrap seeds, internal health check (/login
#      must return 200). Failure -> remove trial, restart old container on the
#      untouched data, exit 1
#   7. TRIAL B: previous image in trial mode on the MIGRATED copy; its health
#      check decides ROLLBACK_COMPATIBLE=yes|no (yes also when the schema is
#      unchanged)
#   8. CUTOVER: start the candidate on the real data (writes accepted from
#      here), internal health check, bootstrap seeds, then the PUBLIC health
#      check ($PORTAL_PUBLIC_URL/login must return 200)
#   9. ON ANY FAILURE after the freeze: ROLLBACK_COMPATIBLE=yes -> stop the
#      candidate and start $PREVIOUS_IMAGE on the CURRENT data (newly
#      accepted data is kept; nothing is restored from backup); =no -> stop
#      the candidate, do NOT restore anything automatically, print the manual
#      recovery procedure (export-since, then fix forward or restore-backup),
#      exit 1
#
# Staging: the app is ALWAYS started through a deploy-managed override compose
# file (portal-staging.overrides.yml next to the compose file) that sets
# WHATSAPP_DISABLED=1, so the WhatsApp Web client never starts in staging —
# including on rollback. Staging e-mail goes to a sink through the staging
# project's SMTP_* settings (provisioned with the compose file, not managed
# here).
#
# Hard rule: two containers never mount the same auth dir or data dir at the
# same time — the app is frozen before any trial runs, and each trial runs
# alone on its own private copy.
#
# Container secrets are interpolated by docker compose from the env file next
# to the compose project ($PORTAL_ENV_FILE, default $PORTAL_ROOT/.env).
# Optional env overrides (used by tests): PORTAL_ROOT, PORTAL_COMPOSE_FILE,
# PORTAL_APP_SERVICE, PORTAL_APP_CONTAINER, PORTAL_DATA_DIR,
# PORTAL_UPLOADS_DIR, PORTAL_AUTH_DIR, PORTAL_SRC_DIR, PORTAL_BACKUP_DIR,
# PORTAL_PUBLIC_URL, PORTAL_ENV_NAME, PORTAL_ENV_FILE, PORTAL_SOURCE_TARBALL,
# PORTAL_*_IMAGE (defaults are per-env: portal:* for production,
# portal-staging:* for staging), PORTAL_BACKUP_KEEP_DAYS,
# PORTAL_HEALTH_RETRIES, PORTAL_HEALTH_INTERVAL_SECONDS, PORTAL_TRIAL_A_PORT,
# PORTAL_TRIAL_B_PORT, PORTAL_STAGING_OVERRIDE_FILE.
# W3c staging drill hook: PORTAL_DRILL_FAIL_HEALTH=1 fails the post-cutover health check on purpose; honoured only when the target env is staging.

set -euo pipefail

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: portal-deploy [<env> [<tarball>]]

  <env>      staging | production (default: $PORTAL_ENV_NAME or production)
  <tarball>  source tarball to deploy (default: $PORTAL_SOURCE_TARBALL or
             $PORTAL_ROOT/portal-source.tar.gz)
EOF
}

ARG_ENV=""
ARG_TARBALL=""
case $# in
  0) ;;
  1) ARG_ENV="$1" ;;
  2) ARG_ENV="$1"; ARG_TARBALL="$2" ;;
  *) usage; exit 2 ;;
esac

ENV_NAME="${ARG_ENV:-${PORTAL_ENV_NAME:-production}}"
case "$ENV_NAME" in
  production)
    DEFAULT_ROOT="/opt/stack"
    DEFAULT_CONTAINER="portal-app"
    DEFAULT_PUBLIC_URL="https://portal.nare.am"
    DEFAULT_IMAGE_REPO="portal"
    ;;
  staging)
    DEFAULT_ROOT="/opt/stack/staging"
    DEFAULT_CONTAINER="portal-staging"
    DEFAULT_PUBLIC_URL="https://staging.portal.nare.am"
    DEFAULT_IMAGE_REPO="portal-staging"
    ;;
  *)
    usage
    die "environment must be 'staging' or 'production' (got '$ENV_NAME')"
    ;;
esac

ROOT="${PORTAL_ROOT:-$DEFAULT_ROOT}"
COMPOSE_FILE="${PORTAL_COMPOSE_FILE:-$ROOT/docker-compose.yml}"
APP_SERVICE="${PORTAL_APP_SERVICE:-portal}"
APP_CONTAINER="${PORTAL_APP_CONTAINER:-$DEFAULT_CONTAINER}"
DATA_DIR="${PORTAL_DATA_DIR:-$ROOT/portal/data}"
UPLOADS_DIR="${PORTAL_UPLOADS_DIR:-$ROOT/portal/uploads}"
AUTH_DIR="${PORTAL_AUTH_DIR:-$ROOT/portal/auth}"
SRC_DIR="${PORTAL_SRC_DIR:-$ROOT/portal/src}"
BACKUP_DIR="${PORTAL_BACKUP_DIR:-$ROOT/backups}"
PUBLIC_URL="${PORTAL_PUBLIC_URL:-$DEFAULT_PUBLIC_URL}"
ENV_FILE="${PORTAL_ENV_FILE:-$ROOT/.env}"
SOURCE_TARBALL="${ARG_TARBALL:-${PORTAL_SOURCE_TARBALL:-$ROOT/portal-source.tar.gz}}"
STAGING_OVERRIDE_FILE="${PORTAL_STAGING_OVERRIDE_FILE:-$(dirname "$COMPOSE_FILE")/portal-staging.overrides.yml}"

# Trailing slashes would break the basename/dirname archiving below.
DATA_DIR="${DATA_DIR%/}"
UPLOADS_DIR="${UPLOADS_DIR%/}"
AUTH_DIR="${AUTH_DIR%/}"

# Image tags are per-environment: staging must never move the production
# service tags (portal:latest etc.) — a staging cutover retagging the shared
# portal:latest would make a production rollback pin the staging candidate,
# and any production `compose up` between the two deploys would boot the
# ungated candidate on production data.
CANDIDATE_IMAGE="${PORTAL_CANDIDATE_IMAGE:-$DEFAULT_IMAGE_REPO:candidate}"
PREVIOUS_IMAGE="${PORTAL_PREVIOUS_IMAGE:-$DEFAULT_IMAGE_REPO:previous}"
LATEST_IMAGE="${PORTAL_LATEST_IMAGE:-$DEFAULT_IMAGE_REPO:latest}"

BACKUP_KEEP_DAYS="${PORTAL_BACKUP_KEEP_DAYS:-14}"
HEALTH_RETRIES="${PORTAL_HEALTH_RETRIES:-30}"
HEALTH_INTERVAL_SECONDS="${PORTAL_HEALTH_INTERVAL_SECONDS:-3}"

TRIAL_A_CONTAINER="portal-trial-a"
TRIAL_B_CONTAINER="portal-trial-b"
TRIAL_A_PORT="${PORTAL_TRIAL_A_PORT:-13001}"
TRIAL_B_PORT="${PORTAL_TRIAL_B_PORT:-13002}"

# W3c drill hook (staging-only): the portal rollback drill sets
# PORTAL_ENV_NAME=staging and PORTAL_DRILL_FAIL_HEALTH=1 so the post-cutover
# health check fails on purpose and the automatic rollback is exercised.
# Ignored in production even when the variable is set.
DRILL_FAIL_HEALTH="false"
if [ "$ENV_NAME" = "staging" ] && [ "${PORTAL_DRILL_FAIL_HEALTH:-}" = "1" ]; then
  DRILL_FAIL_HEALTH="true"
fi

APP_WAS_RUNNING="false"
CURRENT_IMAGE="$LATEST_IMAGE"
BACKUP_FILE=""
FREEZE_START_TS=""
ROLLBACK_COMPATIBLE="no"
WORK_DIR=""

# compose file set merged for every `compose up` of the real app: the
# provisioning-owned compose file, plus the deploy-managed staging override
# (WHATSAPP_DISABLED=1) when deploying staging. Never written by merge — the
# override is generated by ensure_staging_override() below.
COMPOSE_ARGS=(-f "$COMPOSE_FILE")

compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}

cleanup() {
  # Best-effort removal of trial leftovers; never masks the exit code.
  if [ -n "$WORK_DIR" ]; then
    docker rm -f "$TRIAL_A_CONTAINER" "$TRIAL_B_CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

assert_distinct_dir_names() {
  # The backup archives each data dir by basename; duplicate basenames would
  # collide in the archive and corrupt a later restore.
  local dupes
  dupes="$(printf '%s\n' "$(basename "$DATA_DIR")" "$(basename "$UPLOADS_DIR")" "$(basename "$AUTH_DIR")" | sort | uniq -d)"
  [ -z "$dupes" ] || die "data, uploads and auth dirs must have distinct names to be archivable (duplicate: $dupes)"
}

ensure_staging_override() {
  # Staging must NEVER start the WhatsApp Web client. The server compose file
  # is provisioning-owned and never touched, so the gate lives in a
  # deploy-managed override that every staging `compose up` merges — cutover,
  # rollback and any later restart through this tooling.
  if [ "$ENV_NAME" != "staging" ]; then
    return 0
  fi
  cat > "$STAGING_OVERRIDE_FILE" <<EOF
# Managed by the deploy gate (scripts/vps-deploy.sh, installed as
# portal-deploy): staging runs WITHOUT the WhatsApp Web client
# (WHATSAPP_DISABLED=1). Do not edit by hand — the deploy gate rewrites this
# file on every staging deploy. Staging e-mail goes to a sink via the staging
# project's SMTP_* settings.
services:
  $APP_SERVICE:
    environment:
      - WHATSAPP_DISABLED=1
EOF
  COMPOSE_ARGS+=(-f "$STAGING_OVERRIDE_FILE")
  log "staging mode: $APP_SERVICE is started with WHATSAPP_DISABLED=1 via $STAGING_OVERRIDE_FILE"
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
  for _ in $(seq 1 "$HEALTH_RETRIES"); do
    if container_login_ok "$container"; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  return 1
}

# Public health check: after cutover the site must answer through its public
# URL (caddy in front of the app), not only inside the container.
public_login_ok() {
  curl -fsS --max-time 10 -o /dev/null "$PUBLIC_URL/login"
}

wait_for_public_login() {
  for _ in $(seq 1 "$HEALTH_RETRIES"); do
    if public_login_ok; then
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
  docker exec "$container" npm run db:seed < /dev/null || return 1
  docker exec "$container" npx tsx scripts/seed-travel-catalog.ts < /dev/null || return 1
}

write_trial_compose_file() {
  cat > "$WORK_DIR/trial-compose.yml" <<'YML'
# Generated by the deploy gate (scripts/vps-deploy.sh) — isolated trial
# containers: no reverse-proxy labels, no auth dir, bound to localhost only.
# Keep the environment mapping in sync with the server compose project.
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
      - NEXTAUTH_SECRET=${PORTAL_NEXTAUTH_SECRET:?PORTAL_NEXTAUTH_SECRET must be set in the env file}
      - ADMIN_EMAIL=${PORTAL_ADMIN_EMAIL:?PORTAL_ADMIN_EMAIL must be set in the env file}
      - ADMIN_PASSWORD=${PORTAL_ADMIN_PASSWORD:?PORTAL_ADMIN_PASSWORD must be set in the env file}
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
# Generated by the deploy gate (scripts/vps-deploy.sh): restart the previously
# running image on the CURRENT data dirs (compose merge overrides only the
# image reference).
services:
  $APP_SERVICE:
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
  running="$(docker ps -q --no-trunc)"
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
  backup="$BACKUP_DIR/portal-$ENV_NAME-$stamp.tar.gz"
  mkdir -p "$BACKUP_DIR" || return 1
  log "backup: archiving the data dirs to $backup"
  # Each dir is archived by basename relative to its parent, so the PORTAL_*
  # dir overrides keep working and the restore can validate members by name.
  tar -czf "$backup" \
    -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" \
    -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" \
    -C "$(dirname "$AUTH_DIR")" "$(basename "$AUTH_DIR")" || return 1
  tar -tzf "$backup" >/dev/null || return 1
  sha256sum "$backup" > "$backup.sha256" || return 1
  # Pruning failure must not abort the deploy.
  find "$BACKUP_DIR" \( -name "portal-$ENV_NAME-*.tar.gz" -o -name "portal-$ENV_NAME-*.tar.gz.sha256" \) -type f -mtime +"$BACKUP_KEEP_DAYS" -delete || true
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
   restore — run the export-since tool (portal-export) on $BACKUP_FILE to
   diff the current database against the backup.
2. Then choose exactly ONE:
   a) fix forward: build a fixed candidate and re-run the deploy gate — it
      will freeze, back up the CURRENT data (including the newly accepted
      rows) and gate the deploy again.
   b) restore-backup: run the restore tool (portal-restore) on
      $BACKUP_FILE; it stops the app, overwrites the data dirs from the
      archive, starts $PREVIOUS_IMAGE on the restored data with
      notifications paused, and tells you how to re-apply the
      export-since output.
======================================================================
EOF
}

cutover_failed() {
  log "CUTOVER FAILED: $1" >&2
  if [ "$ROLLBACK_COMPATIBLE" = "yes" ]; then
    log "rolling back: starting $PREVIOUS_IMAGE on the CURRENT data (newly accepted data kept; nothing is restored from backup)" >&2
    write_rollback_compose_file
    if compose -f "$WORK_DIR/rollback-compose.yml" up -d "$APP_SERVICE"; then
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
  command -v curl >/dev/null 2>&1 || die "curl is required on PATH (public health check)"
  [ -f "$SOURCE_TARBALL" ] || die "source tarball not found: $SOURCE_TARBALL"
  # The compose file is provisioning-owned: the deploy gate refuses to run
  # without it and never creates, syncs or modifies it.
  [ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE — provisioning installs it; the deploy gate never creates or modifies it"
  [ -n "$PUBLIC_URL" ] || die "PORTAL_PUBLIC_URL must be set (public health check)"
  assert_distinct_dir_names
  mkdir -p "$DATA_DIR" "$UPLOADS_DIR" "$AUTH_DIR" || die "failed to create the data dirs"

  if [ "$DRILL_FAIL_HEALTH" = "true" ]; then
    log "DRILL HOOK active (staging): PORTAL_DRILL_FAIL_HEALTH=1 — the post-cutover health check will fail on purpose"
  fi

  # --- 1. extract + build while the app runs ---------------------------------
  log "deploy gate [$ENV_NAME]: extracting $(basename "$SOURCE_TARBALL")"
  rm -rf "${SRC_DIR:?}"
  mkdir -p "$SRC_DIR" || die "failed to create $SRC_DIR"
  tar -xzf "$SOURCE_TARBALL" -C "$SRC_DIR" || die "failed to extract the source tarball"
  rm -f "$SOURCE_TARBALL"

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

  WORK_DIR="$(mktemp -d "$ROOT/.deploy.XXXXXX")" || die "failed to create a work dir"
  write_trial_compose_file
  ensure_staging_override

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
  if ! compose up -d "$APP_SERVICE"; then
    cutover_failed "docker compose failed to start the candidate"
  fi
  if [ "$DRILL_FAIL_HEALTH" = "true" ]; then
    cutover_failed "drill hook PORTAL_DRILL_FAIL_HEALTH=1 (staging only): simulating a post-cutover health check failure"
  fi
  if ! wait_for_login "$APP_CONTAINER"; then
    cutover_failed "$APP_CONTAINER did not serve /login (HTTP 200) after cutover"
  fi
  if ! run_bootstrap_seeds "$APP_CONTAINER"; then
    cutover_failed "bootstrap seeds failed after cutover"
  fi
  if ! wait_for_public_login; then
    cutover_failed "public health check failed: $PUBLIC_URL/login did not return 200"
  fi
  log "CUTOVER complete: $APP_CONTAINER runs $CANDIDATE_IMAGE; bootstrap seeds ran; $PUBLIC_URL/login is 200"
  log "deploy finished successfully (ROLLBACK_COMPATIBLE=$ROLLBACK_COMPATIBLE, backup: $BACKUP_FILE)"
}

main
