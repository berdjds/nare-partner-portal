#!/usr/bin/env bash
#
# Manual recovery restore (W1, task deploy-recov). Runs ON THE VPS. NEVER
# invoked by scripts/vps-deploy.sh — the deploy gate never restores data on
# its own; this script is the operator-run half of the manual procedure it
# prints after a post-cutover failure with ROLLBACK_COMPATIBLE=no.
#
# Usage:
#   scripts/restore-backup.sh <archive> --yes [--no-export-ack]
#
#   <archive>         A verified backup from scripts/vps-deploy.sh, e.g.
#                     /root/productionapp/backups/wacontrol-20260928T120000Z.tar.gz
#   --yes             Required acknowledgement: the three live data dirs are
#                     overwritten with the backup content.
#   --no-export-ack   Skip the export-since acknowledgement (see below).
#
# Sequence:
#   1. validate the argument and its sha256 sidecar
#   2. refuse to run without --yes
#   3. refuse unless scripts/export-since.sh has been run for this archive
#      (<archive without .tar.gz>.export.json exists) — post-backup rows must
#      be preserved before the restore can destroy them — unless the operator
#      passes --no-export-ack
#   4. verify the restore image exists (WACONTROL_RESTORE_IMAGE, default
#      wacontrol:previous — the pre-deploy image that matches the backup's
#      schema) — checked before anything is stopped
#   5. refuse if any container other than the app mounts a data dir
#   6. validate the archive members: only the three data dir trees may be
#      extracted, and all three must be present
#   7. retag the restore image as the compose service image wacontrol:latest,
#      which after a failed cutover still points at the failed candidate —
#      only after every check that can abort has passed, so a refused
#      restore never leaves wacontrol:latest moved
#   8. stop the app container (all writers stop with it)
#   9. overwrite wacontrol-data / wacontrol-uploads / wacontrol-auth from the
#      archive (nothing else is touched)
#  10. start the app via docker compose with WACONTROL_NOTIFICATIONS_PAUSED=1
#      (compose override file) so outbox entries reverted by the restore are
#      not re-sent, and health-check /login inside the container
#  11. print how to review the export and how to resume notifications
#
# The override file stays in place until the operator deletes it, so
# notifications stay paused across restarts until deliberately resumed.

set -euo pipefail

APP_ROOT="${WACONTROL_APP_ROOT:-/root/productionapp}"
DATA_DIR="$APP_ROOT/wacontrol-data"
UPLOADS_DIR="$APP_ROOT/wacontrol-uploads"
AUTH_DIR="$APP_ROOT/wacontrol-auth"
COMPOSE_FILE="${WACONTROL_COMPOSE_FILE:-$APP_ROOT/docker-compose.yml}"
APP_CONTAINER="${WACONTROL_APP_CONTAINER:-wacontrol-app}"
PAUSE_COMPOSE_FILE="${WACONTROL_PAUSE_COMPOSE_FILE:-$APP_ROOT/wacontrol-restore-paused.compose.yml}"
RESTORE_IMAGE="${WACONTROL_RESTORE_IMAGE:-wacontrol:previous}"
LATEST_IMAGE="${WACONTROL_LATEST_IMAGE:-wacontrol:latest}"
HEALTH_RETRIES="${WACONTROL_HEALTH_RETRIES:-30}"
HEALTH_INTERVAL_SECONDS="${WACONTROL_HEALTH_INTERVAL_SECONDS:-3}"

YES=0
NO_EXPORT_ACK=0
ARCHIVE=""

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: scripts/restore-backup.sh <archive> --yes [--no-export-ack]

  <archive>          Backup archive written by scripts/vps-deploy.sh, e.g.
                     /root/productionapp/backups/wacontrol-20260928T120000Z.tar.gz
  --yes              Required: overwrite the live data dirs with the backup.
  --no-export-ack    Skip the export-since acknowledgement. Without it, the
                     script refuses unless <archive without .tar.gz>.export.json
                     exists (run scripts/export-since.sh <archive> first).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes)
      YES=1
      ;;
    --no-export-ack)
      NO_EXPORT_ACK=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      usage
      die "unknown option: $1"
      ;;
    *)
      if [ -n "$ARCHIVE" ]; then
        usage
        die "unexpected argument: $1"
      fi
      ARCHIVE="$1"
      ;;
  esac
  shift
done

[ -n "$ARCHIVE" ] || { usage; exit 2; }

# The safety gate comes first: everything below destroys live data.
if [ "$YES" -ne 1 ]; then
  usage
  die "refusing to overwrite live data without --yes"
fi

[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
[[ "$ARCHIVE" == *.tar.gz ]] || die "archive must be a .tar.gz backup from scripts/vps-deploy.sh: $ARCHIVE"
[ -f "$ARCHIVE.sha256" ] || die "checksum sidecar missing: $ARCHIVE.sha256"
log "restore: verifying $ARCHIVE against $(basename "$ARCHIVE").sha256"
( cd "$(dirname "$ARCHIVE")" && sha256sum -c -- "$(basename "$ARCHIVE").sha256" ) \
  || die "checksum mismatch — the archive is corrupt or not the verified backup; refusing to restore"

EXPORT_FILE="${ARCHIVE%.tar.gz}.export.json"
if [ "$NO_EXPORT_ACK" -ne 1 ] && [ ! -f "$EXPORT_FILE" ]; then
  die "no export-since output for this archive ($EXPORT_FILE).
Run scripts/export-since.sh $ARCHIVE first to preserve rows written after the
backup, or pass --no-export-ack if post-backup data was preserved another way."
fi

[ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE"

# The service image in $COMPOSE_FILE is $LATEST_IMAGE. After a failed cutover
# with ROLLBACK_COMPATIBLE=no that tag already points at the FAILED candidate
# (vps-deploy.sh tags the candidate as latest for cutover and never retags it
# back), so a plain `compose up` would restart the failing code on the
# restored backup — its entrypoint `prisma db push` would migrate the backup
# with the code that just failed, defeating the restore. The restore therefore
# starts the pre-deploy image that matches the backup's schema, retagged as
# $LATEST_IMAGE so the documented resume step (`compose up` without the
# override) keeps starting it.
if ! docker image inspect "$RESTORE_IMAGE" >/dev/null 2>&1; then
  die "restore image $RESTORE_IMAGE not found — the restore must start the pre-deploy image that matches the backup's schema, not the failed candidate that $LATEST_IMAGE currently points at; tag the intended image or set WACONTROL_RESTORE_IMAGE"
fi

# Nobody but the app container may mount the data dirs: two writers on one
# SQLite file / WhatsApp auth dir corrupts both.
assert_no_other_data_mounts() {
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
          die "container $c mounts '$src'; refusing to restore while another container uses a data dir"
          ;;
      esac
    done <<< "$mounts"
  done <<< "$running"
}

# Validate archive members before anything is deleted: only the three data
# dir trees may be extracted, so a stray or hostile member aborts the restore.
validate_archive_members() {
  local m
  local seen_data=0 seen_uploads=0 seen_auth=0
  while IFS= read -r m; do
    case "$m" in
      wacontrol-data | wacontrol-data/*)
        seen_data=1
        ;;
      wacontrol-uploads | wacontrol-uploads/*)
        seen_uploads=1
        ;;
      wacontrol-auth | wacontrol-auth/*)
        seen_auth=1
        ;;
      *)
        die "refusing to extract unexpected archive member: $m"
        ;;
    esac
  done < <(tar -tzf "$ARCHIVE")
  [ "$seen_data" -eq 1 ] && [ "$seen_uploads" -eq 1 ] && [ "$seen_auth" -eq 1 ] \
    || die "archive does not contain all three data dirs (wacontrol-data, wacontrol-uploads, wacontrol-auth)"
}

assert_no_other_data_mounts
validate_archive_members

# Only now, after every check that can abort has passed, move $LATEST_IMAGE:
# a refused restore (above) must leave wacontrol:latest untouched, or a later
# plain `compose up` would boot the old image against the migrated database.
docker tag "$RESTORE_IMAGE" "$LATEST_IMAGE" || die "failed to tag $RESTORE_IMAGE as $LATEST_IMAGE"
log "restore: $LATEST_IMAGE now points at $RESTORE_IMAGE (the pre-deploy image matching the backup)"

# --- stop the app (HTTP writes, the WhatsApp client and all background jobs) --
log "restore: stopping $APP_CONTAINER"
if docker inspect "$APP_CONTAINER" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null || true)" = "true" ]; then
    docker stop "$APP_CONTAINER" || die "failed to stop $APP_CONTAINER"
    log "restore: $APP_CONTAINER stopped"
  else
    log "restore: $APP_CONTAINER was already stopped"
  fi
else
  log "restore: $APP_CONTAINER does not exist; nothing to stop"
fi

# --- overwrite the three data directories from the backup ---------------------
log "restore: overwriting wacontrol-data, wacontrol-uploads and wacontrol-auth from $(basename "$ARCHIVE")"
rm -rf -- "$DATA_DIR" "$UPLOADS_DIR" "$AUTH_DIR"
tar -xzf "$ARCHIVE" -C "$APP_ROOT" || die "extract failed — the data dirs may be incomplete; restore them from $ARCHIVE manually"
for dir in "$DATA_DIR" "$UPLOADS_DIR" "$AUTH_DIR"; do
  [ -d "$dir" ] || die "extract did not recreate $dir"
done
log "restore: data dirs now hold the backup (including the WhatsApp session state as of the backup)"

# --- start the app with notifications paused ----------------------------------
# Outbox rows written after the backup are gone again after the restore; the
# notification worker must not re-send the reverted entries, so the app is
# started with WACONTROL_NOTIFICATIONS_PAUSED=1 until the operator resumes.
cat > "$PAUSE_COMPOSE_FILE" <<'YML'
# Generated by scripts/restore-backup.sh: restarts the app with the travel
# notification outbox worker paused, so outbox entries reverted by the
# restore are not re-sent. Delete this file and run
# `docker compose -f <compose file> up -d wacontrol_app` to resume delivery.
services:
  wacontrol_app:
    environment:
      - WACONTROL_NOTIFICATIONS_PAUSED=1
YML

compose() {
  docker compose -f "$COMPOSE_FILE" -f "$PAUSE_COMPOSE_FILE" "$@"
}

container_login_ok() {
  docker exec "$1" node -e \
    "fetch('http://127.0.0.1:3000/login').then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))" \
    < /dev/null
}

wait_for_login() {
  for _ in $(seq 1 "$HEALTH_RETRIES"); do
    if container_login_ok "$APP_CONTAINER"; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  return 1
}

log "restore: starting $APP_CONTAINER from $RESTORE_IMAGE with WACONTROL_NOTIFICATIONS_PAUSED=1 ($PAUSE_COMPOSE_FILE)"
compose up -d wacontrol_app || die "docker compose failed to start $APP_CONTAINER"
if ! wait_for_login "$APP_CONTAINER"; then
  die "$APP_CONTAINER did not serve /login (HTTP 200) after the restore — inspect the container; notifications remain paused"
fi
log "restore: $APP_CONTAINER is healthy on $RESTORE_IMAGE; notification delivery is PAUSED"

cat <<EOF
======================================================================
RESTORE COMPLETE (from $(basename "$ARCHIVE"))
======================================================================

The app runs $RESTORE_IMAGE (tagged as $LATEST_IMAGE) on the restored data —
the pre-deploy image matching the backup's schema, not the failed candidate.

Post-backup rows were preserved by export-since:
  $EXPORT_FILE
Review it before re-applying anything, e.g.:
  jq '.counts' "$EXPORT_FILE"

Notifications are PAUSED (WACONTROL_NOTIFICATIONS_PAUSED=1 via
$PAUSE_COMPOSE_FILE): outbox entries reverted by the restore were NOT
re-sent. After reviewing the outbox, resume delivery with:
  rm "$PAUSE_COMPOSE_FILE"
  docker compose -f "$COMPOSE_FILE" up -d wacontrol_app

What this did NOT cover:
  - media files added to wacontrol-uploads after the backup (not in the
    export; preserve them from a separate copy if needed),
  - rows in tables without createdAt/updatedAt (listed under
    "skippedTables" in the export) — re-create those manually,
  - the WhatsApp session is back to its backup-time state; if WhatsApp
    invalidated the session, re-pair from the admin panel.
======================================================================
EOF
