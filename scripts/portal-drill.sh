#!/usr/bin/env bash
#
# Staging operational drills (W3c, task portal-drills). Installed by the
# portal provisioning tooling as /usr/local/lib/portal-deploy/portal-drill
# and invoked by the portal dispatcher as:
#
#   PORTAL_ENV_NAME=staging /usr/local/lib/portal-deploy/portal-drill rollback|restore
#
#   rollback   Deploy the staging app with the vps-deploy.sh drill hook
#              (PORTAL_DRILL_FAIL_HEALTH=1) so the post-cutover health check
#              fails on purpose, then verify the automatic rollback: the
#              container runs the previous image, /login is healthy, and the
#              staging data is byte-for-byte unchanged.
#   restore    Take a verified backup of the staging data dirs, plant a
#              marker file, run restore-backup.sh over the staging data, then
#              verify the marker is gone and the restored data matches the
#              backup byte for byte.
#
# Both drills run against the STAGING copy of the app (default root
# /root/stagingapp), whose layout mirrors production: wacontrol-data/,
# wacontrol-uploads/, wacontrol-auth/, docker-compose.yml, backups/,
# wacontrol-source.tar.gz and wacontrol-src/scripts/{vps-deploy.sh,
# restore-backup.sh}.
#
# Safety: the drills refuse to run unless PORTAL_ENV_NAME is exactly
# "staging", the staging root does not overlap the production root, and every
# data path resolves strictly inside the staging root (symlinks pointing
# outside are caught). Production is never touched: the child tools are
# pointed at the staging root through WACONTROL_* overrides.

set -euo pipefail

DRILL_NAME="${1:-}"

usage() {
  cat >&2 <<'EOF'
usage: portal-drill rollback|restore

  rollback   Run the staging rollback drill: deploy with the drill hook
             (PORTAL_DRILL_FAIL_HEALTH=1) and verify the automatic rollback
             leaves the staging app healthy and the data unchanged.
  restore    Run the staging restore drill: verified backup, marker file,
             restore-backup.sh, then verify the marker is gone and the data
             matches the backup.

Refuses to run unless PORTAL_ENV_NAME=staging.
EOF
}

case "$DRILL_NAME" in
  rollback | restore) ;;
  *)
    usage
    exit 2
    ;;
esac

STAGING_ROOT="${PORTAL_STAGING_ROOT:-/root/stagingapp}"
PRODUCTION_ROOT="${PORTAL_PRODUCTION_ROOT:-/root/productionapp}"
APP_CONTAINER="${PORTAL_APP_CONTAINER:-wacontrol-staging-app}"
CANDIDATE_IMAGE="${PORTAL_CANDIDATE_IMAGE:-wacontrol-staging:candidate}"
PREVIOUS_IMAGE="${PORTAL_PREVIOUS_IMAGE:-wacontrol-staging:previous}"
LATEST_IMAGE="${PORTAL_LATEST_IMAGE:-wacontrol-staging:latest}"
DEPLOY_SCRIPT="${PORTAL_DEPLOY_SCRIPT:-$STAGING_ROOT/wacontrol-src/scripts/vps-deploy.sh}"
RESTORE_SCRIPT="${PORTAL_RESTORE_SCRIPT:-$STAGING_ROOT/wacontrol-src/scripts/restore-backup.sh}"
SOURCE_TARBALL="${PORTAL_SOURCE_TARBALL:-$STAGING_ROOT/wacontrol-source.tar.gz}"
HEALTH_RETRIES="${PORTAL_HEALTH_RETRIES:-30}"
HEALTH_INTERVAL_SECONDS="${PORTAL_HEALTH_INTERVAL_SECONDS:-3}"

# Derived from the staging root on purpose (NOT separately overridable): the
# safety gate below proves these stay inside the staging root.
DATA_DIR="$STAGING_ROOT/wacontrol-data"
UPLOADS_DIR="$STAGING_ROOT/wacontrol-uploads"
AUTH_DIR="$STAGING_ROOT/wacontrol-auth"
BACKUP_DIR="$STAGING_ROOT/backups"
COMPOSE_FILE="$STAGING_ROOT/docker-compose.yml"

WORK_DIR=""

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

drill_fail() {
  printf 'DRILL FAIL %s: %s\n' "$DRILL_NAME" "$*" >&2
  exit 1
}

drill_pass() {
  printf 'DRILL PASS %s\n' "$DRILL_NAME"
  exit 0
}

cleanup() {
  # Best-effort removal of the work dir; never masks the exit code.
  if [ -n "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

assert_staging_safety() {
  # Runs FIRST in every drill, before any file existence check and before any
  # docker call: the drills destroy and recreate staging data, so a mistaken
  # run against production must be impossible.
  local env_name="${PORTAL_ENV_NAME:-}"
  local got
  if [ "$env_name" != "staging" ]; then
    got="$env_name"
    if [ -z "$got" ]; then
      got="<unset>"
    fi
    drill_fail "refusing to run: PORTAL_ENV_NAME must be 'staging' (got '$got')"
  fi

  local resolved_staging
  local resolved_prod
  resolved_staging="$(realpath -m -- "$STAGING_ROOT")"
  resolved_prod="$(realpath -m -- "$PRODUCTION_ROOT")"
  case "$resolved_staging" in
    "$resolved_prod" | "$resolved_prod"/*)
      drill_fail "refusing to run: staging root '$resolved_staging' overlaps the production root '$resolved_prod'"
      ;;
  esac
  case "$resolved_prod" in
    "$resolved_staging"/*)
      drill_fail "refusing to run: staging root '$resolved_staging' overlaps the production root '$resolved_prod'"
      ;;
  esac

  # Every path the drill or its children act on must resolve strictly under
  # the staging root; realpath -m resolves symlinks, so a path linked out of
  # the staging tree is caught. The overridable inputs (source tarball, child
  # deploy/restore scripts, compose file) are checked too: vps-deploy.sh
  # deletes the tarball and restore-backup.sh consumes the compose files, so a
  # stray override pointing at production must be refused here, before any
  # docker call.
  local path
  local resolved
  for path in "$DATA_DIR" "$UPLOADS_DIR" "$AUTH_DIR" "$BACKUP_DIR" \
    "$SOURCE_TARBALL" "$DEPLOY_SCRIPT" "$RESTORE_SCRIPT" "$COMPOSE_FILE"; do
    resolved="$(realpath -m -- "$path")"
    case "$resolved" in
      "$resolved_staging"/*) ;;
      *)
        drill_fail "refusing to run: data path '$path' resolves to '$resolved', outside the staging root '$resolved_staging'"
        ;;
    esac
  done
}

write_manifest() {
  # $1 = output file. sha256 of every regular file in each data dir; the list
  # is sorted (NUL-delimited, so odd filenames survive) to keep the manifest
  # deterministic. Compare manifests with cmp -s.
  local out="$1"
  local dir
  for dir in "$DATA_DIR" "$UPLOADS_DIR" "$AUTH_DIR"; do
    [ -d "$dir" ] || drill_fail "data dir missing: $dir"
    printf '== %s ==\n' "$(basename "$dir")" >> "$out"
    (cd "$dir" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) >> "$out"
  done
}

# Internal health check (same approach as vps-deploy.sh): the image has no
# curl, but it has Node 20 with global fetch, and the container probes its own
# HTTP server so no port has to be published beyond localhost.
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

export_child_environment() {
  # Point the child tool (vps-deploy.sh / restore-backup.sh) at the staging
  # layout. PORTAL_ENV_NAME itself is inherited from the environment, so the
  # vps-deploy.sh drill hook stays staging-only.
  export WACONTROL_APP_ROOT="$STAGING_ROOT"
  export WACONTROL_APP_CONTAINER="$APP_CONTAINER"
  export WACONTROL_SOURCE_TARBALL="$SOURCE_TARBALL"
  export WACONTROL_CANDIDATE_IMAGE="$CANDIDATE_IMAGE"
  export WACONTROL_PREVIOUS_IMAGE="$PREVIOUS_IMAGE"
  export WACONTROL_LATEST_IMAGE="$LATEST_IMAGE"
  export WACONTROL_HEALTH_RETRIES="$HEALTH_RETRIES"
  export WACONTROL_HEALTH_INTERVAL_SECONDS="$HEALTH_INTERVAL_SECONDS"
  # Pin the remaining child overrides too: restore-backup.sh honours
  # WACONTROL_COMPOSE_FILE / WACONTROL_PAUSE_COMPOSE_FILE and vps-deploy.sh
  # honours WACONTROL_ENV_FILE, so an inherited value from the caller would
  # make a child write to a non-staging compose project or read a foreign
  # .env. assert_staging_safety already proved these paths are inside the
  # staging root.
  export WACONTROL_COMPOSE_FILE="$COMPOSE_FILE"
  export WACONTROL_PAUSE_COMPOSE_FILE="$STAGING_ROOT/wacontrol-restore-paused.compose.yml"
  export WACONTROL_ENV_FILE="$STAGING_ROOT/.env"
}

drill_rollback() {
  assert_staging_safety
  command -v docker >/dev/null 2>&1 || drill_fail "docker is required on PATH"
  [ -f "$DEPLOY_SCRIPT" ] || drill_fail "deploy script not found: $DEPLOY_SCRIPT"
  [ -f "$SOURCE_TARBALL" ] || drill_fail "source tarball not found: $SOURCE_TARBALL"

  WORK_DIR="$(mktemp -d)" || drill_fail "failed to create a work dir"
  local before_manifest="$WORK_DIR/manifest.before"
  local after_manifest="$WORK_DIR/manifest.after"

  write_manifest "$before_manifest"

  export_child_environment

  # The drill hook in vps-deploy.sh fails the post-cutover health check on
  # purpose, so the deploy MUST reach the cutover, fail there, and roll back.
  # A non-zero exit alone does not prove that: any pre-cutover failure (build,
  # tarball extract, backup, trial) also exits 1 with the container untouched
  # — and the container already runs PREVIOUS_IMAGE after every successful
  # rollback drill, so the container checks below would false-pass. Capture
  # the child output (while still streaming it) and require BOTH the hook's
  # cutover failure marker and the rollback success line. The deploy status is
  # taken from PIPESTATUS[0] (tee's status is irrelevant) without tripping
  # set -e.
  log "running the deploy with PORTAL_DRILL_FAIL_HEALTH=1 — expecting a cutover failure and an automatic rollback"
  local deploy_log="$WORK_DIR/deploy.log"
  local status=0
  PORTAL_DRILL_FAIL_HEALTH=1 bash "$DEPLOY_SCRIPT" 2>&1 | tee "$deploy_log" || status="${PIPESTATUS[0]}"

  if [ "$status" -eq 0 ]; then
    drill_fail "the deploy succeeded although PORTAL_DRILL_FAIL_HEALTH=1 — the drill hook was ignored"
  fi
  if ! grep -q 'CUTOVER FAILED: drill hook PORTAL_DRILL_FAIL_HEALTH=1' "$deploy_log"; then
    drill_fail "the deploy failed before the cutover or rollback: the drill hook never fired (no 'CUTOVER FAILED: drill hook' line in the deploy log), so no rollback was exercised"
  fi
  if ! grep -q 'rollback OK:' "$deploy_log"; then
    drill_fail "the deploy failed at the cutover but the rollback did not complete (no 'rollback OK:' line in the deploy log)"
  fi
  log "deploy exited with status $status at the hook-induced cutover and rolled back; verifying the rollback"

  if [ "$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER")" != "true" ]; then
    drill_fail "$APP_CONTAINER is not running after the rollback"
  fi
  local image
  image="$(docker inspect -f '{{.Config.Image}}' "$APP_CONTAINER")"
  # The rollback starts PREVIOUS_IMAGE via rollback-compose.yml, so the
  # container must report exactly that ref. Accepting LATEST_IMAGE too would
  # false-pass when the rollback `compose up` failed and the candidate (started
  # under the latest tag) is still running.
  if [ "$image" != "$PREVIOUS_IMAGE" ]; then
    drill_fail "$APP_CONTAINER runs image '$image' after the rollback, expected '$PREVIOUS_IMAGE'"
  fi

  if ! wait_for_login "$APP_CONTAINER"; then
    drill_fail "/login did not answer HTTP 200 inside $APP_CONTAINER after the rollback"
  fi

  write_manifest "$after_manifest"
  if ! cmp -s "$before_manifest" "$after_manifest"; then
    drill_fail "staging data changed during the rolled-back deploy"
  fi

  drill_pass
}

drill_restore() {
  assert_staging_safety
  command -v docker >/dev/null 2>&1 || drill_fail "docker is required on PATH"
  [ -f "$RESTORE_SCRIPT" ] || drill_fail "restore script not found: $RESTORE_SCRIPT"
  [ -f "$COMPOSE_FILE" ] || drill_fail "compose file not found: $COMPOSE_FILE"

  WORK_DIR="$(mktemp -d)" || drill_fail "failed to create a work dir"
  local before_manifest="$WORK_DIR/manifest.before"
  local after_manifest="$WORK_DIR/manifest.after"

  # A previous run that failed before the restore extracted the archive may
  # have left its marker behind. If it stayed, it would be captured by the
  # manifest and the backup below, restored from that backup, and then fail
  # this run as "the drill marker survived the restore" — on every subsequent
  # run, wrongly implicating restore-backup.sh. Remove it up front.
  if [ -e "$DATA_DIR/DRILL-MARKER.txt" ]; then
    log "removing a leftover drill marker from a previous run: $DATA_DIR/DRILL-MARKER.txt"
    rm -f -- "$DATA_DIR/DRILL-MARKER.txt"
  fi

  write_manifest "$before_manifest"

  export_child_environment

  # Verified backup in the same format as the deploy gate's backup_data_dirs
  # (verified tar + sha256 sidecar), so restore-backup.sh can consume it.
  local stamp
  local backup
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$BACKUP_DIR/wacontrol-$stamp.tar.gz"
  mkdir -p "$BACKUP_DIR" || drill_fail "failed to take the staging backup"
  log "backup: archiving staging data dirs to $backup"
  tar -czf "$backup" -C "$STAGING_ROOT" wacontrol-data wacontrol-uploads wacontrol-auth \
    || drill_fail "failed to take the staging backup"
  tar -tzf "$backup" >/dev/null || drill_fail "failed to take the staging backup"
  sha256sum "$backup" > "$backup.sha256" || drill_fail "failed to take the staging backup"

  # The marker must be wiped by the restore and must not come back.
  printf 'portal drill marker\n' > "$DATA_DIR/DRILL-MARKER.txt"

  # The backup above was taken from the currently running release, so restore
  # with the image that matches it: the running latest (restore-backup.sh's
  # retag of latest becomes a no-op). Restoring the older `previous` image
  # would boot old code on current-schema data — and refuse to run at all on a
  # staging host where no previous tag exists yet.
  export WACONTROL_RESTORE_IMAGE="$LATEST_IMAGE"

  # --no-export-ack is correct here: the drill intentionally discards the
  # marker, so no export-since output exists.
  log "restoring $(basename "$backup") over the staging data dirs"
  local status=0
  bash "$RESTORE_SCRIPT" "$backup" --yes --no-export-ack || status=$?
  if [ "$status" -ne 0 ]; then
    # The restore tool can refuse before extracting the archive (missing
    # restore image, another container mounting a data dir, missing compose
    # file). The marker planted above is then still in the live data dir and
    # must not poison the next run.
    rm -f -- "$DATA_DIR/DRILL-MARKER.txt"
    drill_fail "the restore tool failed (exit $status)"
  fi

  if [ -e "$DATA_DIR/DRILL-MARKER.txt" ]; then
    drill_fail "the drill marker survived the restore"
  fi

  write_manifest "$after_manifest"
  if ! cmp -s "$before_manifest" "$after_manifest"; then
    drill_fail "restored data differs from the backup"
  fi

  if ! wait_for_login "$APP_CONTAINER"; then
    drill_fail "the staging app is not healthy after the restore"
  fi

  log "note: the restore leaves notification delivery paused via the restore override compose file (staging-only, deliberate)"
  drill_pass
}

case "$DRILL_NAME" in
  rollback) drill_rollback ;;
  restore) drill_restore ;;
esac
