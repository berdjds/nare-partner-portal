#!/usr/bin/env bash
#
# Staging operational drills (W3c, task portal-drills; adapted to the W3b
# portal layout in task layout-merge). Installed by deploy/provision-server.sh
# as /usr/local/lib/portal-deploy/portal-drill and invoked by the portal
# dispatcher as:
#
#   PORTAL_ENV_NAME=staging /usr/local/lib/portal-deploy/portal-drill rollback|restore
#
#   rollback   Deploy the staging stack through the deploy gate
#              (portal-deploy) with the drill hook
#              (PORTAL_DRILL_FAIL_HEALTH=1) so the post-cutover health check
#              fails on purpose, then verify the automatic rollback: the
#              container runs the previous image, /login is healthy, and the
#              staging data is byte-for-byte unchanged. The drill redeploys
#              the currently deployed staging source: when no source tarball
#              is pending it is rebuilt from the staging build context
#              (portal/src) left by the last staging deploy, so at least one
#              staging deploy must have run first.
#   restore    Take a verified backup of the staging data dirs, plant a
#              marker file, run the restore tool (portal-restore) over the
#              staging data, then verify the marker is gone and the restored
#              data matches the backup byte for byte.
#
# Both drills run against the STAGING stack (default root /opt/stack/staging),
# whose layout mirrors production: portal/{data,uploads,auth,src},
# docker-compose.yml, backups/ and — only while a deploy is pending —
# portal-source.tar.gz (the deploy gate deletes it after extracting it into
# portal/src). The child tools are
# the installed deploy/restore tools (portal-deploy / portal-restore under
# /usr/local/lib/portal-deploy), pointed at the staging root through PORTAL_*
# overrides.
#
# Safety: the drills refuse to run unless PORTAL_ENV_NAME is exactly
# "staging", the production root is neither equal to nor inside the staging
# root (the staging root itself MAY be nested under the production root —
# that is the W3b layout, /opt/stack/staging under /opt/stack), every data
# path resolves strictly inside the staging root (symlinks pointing outside
# are caught), and no data path lands in the production data areas
# ($PRODUCTION_ROOT/portal, $PRODUCTION_ROOT/backups) or on the production
# compose/env file. Production is never touched: the child tools are pointed
# at the staging root through PORTAL_* overrides.

set -euo pipefail

DRILL_NAME="${1:-}"

usage() {
  cat >&2 <<'EOF'
usage: portal-drill rollback|restore

  rollback   Run the staging rollback drill: deploy with the drill hook
             (PORTAL_DRILL_FAIL_HEALTH=1) and verify the automatic rollback
             leaves the staging app healthy and the data unchanged.
  restore    Run the staging restore drill: verified backup, marker file,
             portal-restore, then verify the marker is gone and the data
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

LIB_DIR="${PORTAL_DEPLOY_LIB_DIR:-/usr/local/lib/portal-deploy}"
STAGING_ROOT="${PORTAL_STAGING_ROOT:-/opt/stack/staging}"
PRODUCTION_ROOT="${PORTAL_PRODUCTION_ROOT:-/opt/stack}"
APP_CONTAINER="${PORTAL_APP_CONTAINER:-portal-staging}"
CANDIDATE_IMAGE="${PORTAL_CANDIDATE_IMAGE:-portal-staging:candidate}"
PREVIOUS_IMAGE="${PORTAL_PREVIOUS_IMAGE:-portal-staging:previous}"
LATEST_IMAGE="${PORTAL_LATEST_IMAGE:-portal-staging:latest}"
DEPLOY_TOOL="${PORTAL_DEPLOY_TOOL:-$LIB_DIR/portal-deploy}"
RESTORE_TOOL="${PORTAL_RESTORE_TOOL:-$LIB_DIR/portal-restore}"
SOURCE_TARBALL="${PORTAL_SOURCE_TARBALL:-$STAGING_ROOT/portal-source.tar.gz}"
PAUSE_COMPOSE_FILE="${PORTAL_PAUSE_COMPOSE_FILE:-$STAGING_ROOT/portal-restore-paused.compose.yml}"
ENV_FILE="${PORTAL_ENV_FILE:-$STAGING_ROOT/.env}"
HEALTH_RETRIES="${PORTAL_HEALTH_RETRIES:-30}"
HEALTH_INTERVAL_SECONDS="${PORTAL_HEALTH_INTERVAL_SECONDS:-3}"

# Derived from the staging root on purpose (NOT separately overridable): the
# safety gate below proves these stay inside the staging root. Same relative
# layout the deploy gate and the restore tool use under $PORTAL_ROOT.
DATA_DIR="$STAGING_ROOT/portal/data"
UPLOADS_DIR="$STAGING_ROOT/portal/uploads"
AUTH_DIR="$STAGING_ROOT/portal/auth"
SRC_DIR="$STAGING_ROOT/portal/src"
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
  # The staging root MAY live inside the production root — that is the W3b
  # layout (/opt/stack/staging under /opt/stack). Refuse only the reverse:
  # the roots are identical or the production root lies inside the staging
  # root, because then the staging data paths could BE the production ones.
  # Nested staging paths are kept out of the production data areas by the
  # per-path check below.
  case "$resolved_prod" in
    "$resolved_staging" | "$resolved_staging"/*)
      drill_fail "refusing to run: production root '$resolved_prod' equals or lies inside the staging root '$resolved_staging'"
      ;;
  esac

  # Every path the drill or its children act on must resolve strictly under
  # the staging root; realpath -m resolves symlinks, so a path linked out of
  # the staging tree is caught. The overridable inputs (source tarball, pause
  # override, env file) are checked too: the deploy gate deletes the tarball
  # and the restore tool writes the pause override, so a stray override
  # pointing at production must be refused here, before any docker call. The
  # child tools themselves are NOT data paths: by default they are the
  # installed root-owned tools under /usr/local/lib/portal-deploy (the
  # PORTAL_*_TOOL overrides exist for the test suite).
  local path
  local resolved
  for path in "$DATA_DIR" "$UPLOADS_DIR" "$AUTH_DIR" "$BACKUP_DIR" \
    "$SRC_DIR" "$SOURCE_TARBALL" "$COMPOSE_FILE" "$PAUSE_COMPOSE_FILE" "$ENV_FILE"; do
    resolved="$(realpath -m -- "$path")"
    case "$resolved" in
      "$resolved_staging"/*) ;;
      *)
        drill_fail "refusing to run: data path '$path' resolves to '$resolved', outside the staging root '$resolved_staging'"
        ;;
    esac
    # Even inside the staging root a path must never land in the production
    # data areas or on the production compose/env file — possible when the
    # staging root is nested inside the production data dirs, or through a
    # PORTAL_* override.
    case "$resolved" in
      "$resolved_prod/portal" | "$resolved_prod/portal"/* | \
      "$resolved_prod/backups" | "$resolved_prod/backups"/* | \
      "$resolved_prod/docker-compose.yml" | "$resolved_prod/.env")
        drill_fail "refusing to run: data path '$path' resolves to '$resolved', inside the production data areas under '$resolved_prod'"
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

# Internal health check (same approach as the deploy gate): the image has no
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
  # Point the child tool (portal-deploy / portal-restore) at the staging
  # layout. PORTAL_ENV_NAME is pinned to staging (not just inherited): the
  # deploy gate's drill hook stays staging-only and both tools pick the
  # staging defaults (portal-staging container, portal-staging:* images).
  export PORTAL_ENV_NAME="staging"
  export PORTAL_ROOT="$STAGING_ROOT"
  export PORTAL_APP_CONTAINER="$APP_CONTAINER"
  export PORTAL_SOURCE_TARBALL="$SOURCE_TARBALL"
  export PORTAL_CANDIDATE_IMAGE="$CANDIDATE_IMAGE"
  export PORTAL_PREVIOUS_IMAGE="$PREVIOUS_IMAGE"
  export PORTAL_LATEST_IMAGE="$LATEST_IMAGE"
  export PORTAL_HEALTH_RETRIES="$HEALTH_RETRIES"
  export PORTAL_HEALTH_INTERVAL_SECONDS="$HEALTH_INTERVAL_SECONDS"
  # Pin the remaining child overrides too: the restore tool honours
  # PORTAL_PAUSE_COMPOSE_FILE and both tools honour PORTAL_ENV_FILE, so an
  # inherited value from the caller would make a child write to a non-staging
  # compose project or read a foreign .env. assert_staging_safety already
  # proved these paths are inside the staging root.
  export PORTAL_DATA_DIR="$DATA_DIR"
  export PORTAL_UPLOADS_DIR="$UPLOADS_DIR"
  export PORTAL_AUTH_DIR="$AUTH_DIR"
  export PORTAL_SRC_DIR="$SRC_DIR"
  export PORTAL_BACKUP_DIR="$BACKUP_DIR"
  export PORTAL_COMPOSE_FILE="$COMPOSE_FILE"
  export PORTAL_PAUSE_COMPOSE_FILE="$PAUSE_COMPOSE_FILE"
  export PORTAL_ENV_FILE="$ENV_FILE"
}

drill_rollback() {
  assert_staging_safety
  command -v docker >/dev/null 2>&1 || drill_fail "docker is required on PATH"
  [ -f "$DEPLOY_TOOL" ] || drill_fail "deploy tool not found: $DEPLOY_TOOL"
  if [ ! -f "$SOURCE_TARBALL" ]; then
    # On a real W3b host the drill job uploads no source: the pipeline's
    # tarball lands in the deploy user's home and the deploy gate deletes it
    # after extracting it into the build context ($SRC_DIR). Rebuild the
    # tarball from that context — the drill redeploys exactly the currently
    # deployed staging source, so one staging deploy must have run first.
    if [ -d "$SRC_DIR" ] && [ -n "$(find "$SRC_DIR" -mindepth 1 -print -quit)" ]; then
      log "no source tarball at $SOURCE_TARBALL: rebuilding it from the staging build context $SRC_DIR (left by the last staging deploy)"
      tar -czf "$SOURCE_TARBALL" -C "$SRC_DIR" . \
        || drill_fail "failed to rebuild the source tarball from $SRC_DIR"
    else
      drill_fail "source tarball not found: $SOURCE_TARBALL and no staging build context at $SRC_DIR — a staging deploy must run first (it leaves the build context the drill redeploys)"
    fi
  fi

  WORK_DIR="$(mktemp -d)" || drill_fail "failed to create a work dir"
  local before_manifest="$WORK_DIR/manifest.before"
  local after_manifest="$WORK_DIR/manifest.after"

  write_manifest "$before_manifest"

  export_child_environment

  # The drill hook in the deploy gate fails the post-cutover health check on
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
  PORTAL_DRILL_FAIL_HEALTH=1 bash "$DEPLOY_TOOL" staging 2>&1 | tee "$deploy_log" || status="${PIPESTATUS[0]}"

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
  [ -f "$RESTORE_TOOL" ] || drill_fail "restore tool not found: $RESTORE_TOOL"
  [ -f "$COMPOSE_FILE" ] || drill_fail "compose file not found: $COMPOSE_FILE"

  WORK_DIR="$(mktemp -d)" || drill_fail "failed to create a work dir"
  local before_manifest="$WORK_DIR/manifest.before"
  local after_manifest="$WORK_DIR/manifest.after"

  # A previous run that failed before the restore extracted the archive may
  # have left its marker behind. If it stayed, it would be captured by the
  # manifest and the backup below, restored from that backup, and then fail
  # this run as "the drill marker survived the restore" — on every subsequent
  # run, wrongly implicating the restore tool. Remove it up front.
  if [ -e "$DATA_DIR/DRILL-MARKER.txt" ]; then
    log "removing a leftover drill marker from a previous run: $DATA_DIR/DRILL-MARKER.txt"
    rm -f -- "$DATA_DIR/DRILL-MARKER.txt"
  fi

  write_manifest "$before_manifest"

  export_child_environment

  # Verified backup in the same format as the deploy gate's backup_data_dirs
  # (verified tar + sha256 sidecar, data dirs archived by basename), so the
  # restore tool can consume it.
  local stamp
  local backup
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$BACKUP_DIR/portal-staging-$stamp.tar.gz"
  mkdir -p "$BACKUP_DIR" || drill_fail "failed to take the staging backup"
  log "backup: archiving staging data dirs to $backup"
  tar -czf "$backup" -C "$STAGING_ROOT/portal" data uploads auth \
    || drill_fail "failed to take the staging backup"
  tar -tzf "$backup" >/dev/null || drill_fail "failed to take the staging backup"
  sha256sum "$backup" > "$backup.sha256" || drill_fail "failed to take the staging backup"

  # The marker must be wiped by the restore and must not come back.
  printf 'portal drill marker\n' > "$DATA_DIR/DRILL-MARKER.txt"

  # The backup above was taken from the currently running release, so restore
  # with the image that matches it: the running latest (the restore tool's
  # retag of latest becomes a no-op). Restoring the older `previous` image
  # would boot old code on current-schema data — and refuse to run at all on a
  # staging host where no previous tag exists yet.
  export PORTAL_RESTORE_IMAGE="$LATEST_IMAGE"

  # --no-export-ack is correct here: the drill intentionally discards the
  # marker, so no export-since output exists.
  log "restoring $(basename "$backup") over the staging data dirs"
  local status=0
  bash "$RESTORE_TOOL" "$backup" --yes --no-export-ack || status=$?
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
