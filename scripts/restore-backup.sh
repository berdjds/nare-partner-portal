#!/usr/bin/env bash
#
# Manual recovery restore for portal.nare.am (W3b, task script-param). Runs ON
# THE SERVER. One-time provisioning installs it as
# /usr/local/lib/portal-deploy/portal-restore; the forced-command dispatcher
# exposes it as `restore <archive>` (staging only unless the dispatcher is
# given --production, in which case it sets PORTAL_ENV_NAME=production). NEVER
# invoked by the deploy gate — the deploy gate never restores data on its own;
# this script is the operator-run half of the manual procedure the gate prints
# after a post-cutover failure with ROLLBACK_COMPATIBLE=no.
#
# Usage:
#   portal-restore <archive> --yes [--no-export-ack]
#
#   <archive>         A verified backup from the deploy gate, e.g.
#                     /opt/stack/backups/portal-production-20260928T120000Z.tar.gz
#   --yes             Required acknowledgement: the three live data dirs are
#                     overwritten with the backup content.
#   --no-export-ack   Skip the export-since acknowledgement (see below).
#
# Sequence:
#   1. validate the argument and its sha256 sidecar
#   2. refuse to run without --yes
#   3. refuse unless the export-since tool (portal-export) has been run for
#      this archive (<archive without .tar.gz>.export.json exists) —
#      post-backup rows must be preserved before the restore can destroy
#      them — unless the operator passes --no-export-ack
#   4. verify the restore image exists (PORTAL_RESTORE_IMAGE, default
#      portal:previous — or portal-staging:previous in staging — the
#      pre-deploy image that matches the backup's schema) — checked before
#      anything is stopped
#   5. refuse if any container other than the app mounts a data dir
#   6. validate the archive members: only the three data dir trees may be
#      extracted, and all three must be present
#   7. retag the restore image as the compose service image (portal:latest,
#      or portal-staging:latest in staging), which after a failed cutover
#      still points at the failed candidate —
#      only after every check that can abort has passed, so a refused
#      restore never leaves the service tag moved
#   8. stop the app container (all writers stop with it)
#   9. overwrite the data / uploads / auth dirs from the archive (nothing
#      else is touched)
#  10. start the app via docker compose with WACONTROL_NOTIFICATIONS_PAUSED=1
#      (compose override file) so outbox entries reverted by the restore are
#      not re-sent — in staging the WHATSAPP_DISABLED=1 override is merged
#      too — and health-check /login inside the container
#  11. print how to review the export and how to resume notifications
#
# The compose file is provisioning-owned: this script refuses to run without
# it and never creates, syncs or modifies it. The pause override file stays
# in place until the operator deletes it, so notifications stay paused across
# restarts until deliberately resumed.
#
# Server layout and PORTAL_* overrides are the same as in the deploy gate
# (scripts/vps-deploy.sh).

set -euo pipefail

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

ENV_NAME="${PORTAL_ENV_NAME:-production}"
case "$ENV_NAME" in
  production)
    DEFAULT_ROOT="/opt/stack"
    DEFAULT_CONTAINER="portal-app"
    DEFAULT_SERVICE="portal"
    DEFAULT_IMAGE_REPO="portal"
    ;;
  staging)
    DEFAULT_ROOT="/opt/stack/staging"
    DEFAULT_CONTAINER="portal-staging"
    DEFAULT_SERVICE="portal-staging"
    DEFAULT_IMAGE_REPO="portal-staging"
    ;;
  *)
    die "PORTAL_ENV_NAME must be 'staging' or 'production' (got '$ENV_NAME')"
    ;;
esac

ROOT="${PORTAL_ROOT:-$DEFAULT_ROOT}"
COMPOSE_FILE="${PORTAL_COMPOSE_FILE:-$ROOT/docker-compose.yml}"
# Per-environment service name (portal production, portal-staging staging —
# see the DNS-alias note in scripts/vps-deploy.sh).
APP_SERVICE="${PORTAL_APP_SERVICE:-$DEFAULT_SERVICE}"
APP_CONTAINER="${PORTAL_APP_CONTAINER:-$DEFAULT_CONTAINER}"
DATA_DIR="${PORTAL_DATA_DIR:-$ROOT/portal/data}"
UPLOADS_DIR="${PORTAL_UPLOADS_DIR:-$ROOT/portal/uploads}"
AUTH_DIR="${PORTAL_AUTH_DIR:-$ROOT/portal/auth}"
PAUSE_COMPOSE_FILE="${PORTAL_PAUSE_COMPOSE_FILE:-$ROOT/portal-restore-paused.compose.yml}"
STAGING_OVERRIDE_FILE="${PORTAL_STAGING_OVERRIDE_FILE:-$(dirname "$COMPOSE_FILE")/portal-staging.overrides.yml}"
# Image tags are per-environment (portal:* production, portal-staging:*
# staging): a staging restore must never move the production service tags.
RESTORE_IMAGE="${PORTAL_RESTORE_IMAGE:-$DEFAULT_IMAGE_REPO:previous}"
LATEST_IMAGE="${PORTAL_LATEST_IMAGE:-$DEFAULT_IMAGE_REPO:latest}"
HEALTH_RETRIES="${PORTAL_HEALTH_RETRIES:-30}"
HEALTH_INTERVAL_SECONDS="${PORTAL_HEALTH_INTERVAL_SECONDS:-3}"

# Trailing slashes would break the basename/dirname extraction below.
DATA_DIR="${DATA_DIR%/}"
UPLOADS_DIR="${UPLOADS_DIR%/}"
AUTH_DIR="${AUTH_DIR%/}"

YES=0
NO_EXPORT_ACK=0
ARCHIVE=""

usage() {
  cat >&2 <<'EOF'
usage: portal-restore <archive> --yes [--no-export-ack]

  <archive>          Backup archive written by the deploy gate, e.g.
                     /opt/stack/backups/portal-production-20260928T120000Z.tar.gz
  --yes              Required: overwrite the live data dirs with the backup.
  --no-export-ack    Skip the export-since acknowledgement. Without it, the
                     script refuses unless <archive without .tar.gz>.export.json
                     exists (run the export-since tool, portal-export, first).
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
[[ "$ARCHIVE" == *.tar.gz ]] || die "archive must be a .tar.gz backup written by the deploy gate: $ARCHIVE"
[ -f "$ARCHIVE.sha256" ] || die "checksum sidecar missing: $ARCHIVE.sha256"
log "restore [$ENV_NAME]: verifying $ARCHIVE against $(basename "$ARCHIVE").sha256"
( cd "$(dirname "$ARCHIVE")" && sha256sum -c -- "$(basename "$ARCHIVE").sha256" ) \
  || die "checksum mismatch — the archive is corrupt or not the verified backup; refusing to restore"

EXPORT_FILE="${ARCHIVE%.tar.gz}.export.json"
if [ "$NO_EXPORT_ACK" -ne 1 ] && [ ! -f "$EXPORT_FILE" ]; then
  die "no export-since output for this archive ($EXPORT_FILE).
Run the export-since tool (portal-export) on $ARCHIVE first to preserve rows
written after the backup, or pass --no-export-ack if post-backup data was
preserved another way."
fi

# The compose file is provisioning-owned: the restore refuses to run without
# it and never creates, syncs or modifies it.
[ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE — provisioning installs it; the restore never creates or modifies it"

# The service image in $COMPOSE_FILE is $LATEST_IMAGE. After a failed cutover
# with ROLLBACK_COMPATIBLE=no that tag already points at the FAILED candidate
# (the deploy gate tags the candidate as latest for cutover and never retags
# it back), so a plain `compose up` would restart the failing code on the
# restored backup — its entrypoint `prisma db push` would migrate the backup
# with the code that just failed, defeating the restore. The restore therefore
# starts the pre-deploy image that matches the backup's schema, retagged as
# $LATEST_IMAGE so the documented resume step (`compose up` without the
# override) keeps starting it.
if ! docker image inspect "$RESTORE_IMAGE" >/dev/null 2>&1; then
  die "restore image $RESTORE_IMAGE not found — the restore must start the pre-deploy image that matches the backup's schema, not the failed candidate that $LATEST_IMAGE currently points at; tag the intended image or set PORTAL_RESTORE_IMAGE"
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
# dir trees (by basename) may be extracted, so a stray or hostile member
# aborts the restore.
validate_archive_members() {
  local m
  local b_data b_uploads b_auth
  local seen_data=0 seen_uploads=0 seen_auth=0
  b_data="$(basename "$DATA_DIR")"
  b_uploads="$(basename "$UPLOADS_DIR")"
  b_auth="$(basename "$AUTH_DIR")"
  while IFS= read -r m; do
    case "$m" in
      "$b_data" | "$b_data"/*)
        seen_data=1
        ;;
      "$b_uploads" | "$b_uploads"/*)
        seen_uploads=1
        ;;
      "$b_auth" | "$b_auth"/*)
        seen_auth=1
        ;;
      *)
        die "refusing to extract unexpected archive member: $m"
        ;;
    esac
  done < <(tar -tzf "$ARCHIVE")
  if [ "$seen_data" -ne 1 ] || [ "$seen_uploads" -ne 1 ] || [ "$seen_auth" -ne 1 ]; then
    die "archive does not contain all three data dirs ($b_data, $b_uploads, $b_auth)"
  fi
}

assert_no_other_data_mounts
validate_archive_members

# Only now, after every check that can abort has passed, move $LATEST_IMAGE:
# a refused restore (above) must leave $LATEST_IMAGE untouched, or a later
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
log "restore: overwriting $(basename "$DATA_DIR"), $(basename "$UPLOADS_DIR") and $(basename "$AUTH_DIR") from $(basename "$ARCHIVE")"
rm -rf -- "$DATA_DIR" "$UPLOADS_DIR" "$AUTH_DIR"
tar -xzf "$ARCHIVE" \
  -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" \
  -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" \
  -C "$(dirname "$AUTH_DIR")" "$(basename "$AUTH_DIR")" \
  || die "extract failed — the data dirs may be incomplete; restore them from $ARCHIVE manually"
for dir in "$DATA_DIR" "$UPLOADS_DIR" "$AUTH_DIR"; do
  [ -d "$dir" ] || die "extract did not recreate $dir"
done
log "restore: data dirs now hold the backup (including the WhatsApp session state as of the backup)"

# --- start the app with notifications paused ----------------------------------
# Outbox rows written after the backup are gone again after the restore; the
# notification worker must not re-send the reverted entries, so the app is
# started with WACONTROL_NOTIFICATIONS_PAUSED=1 until the operator resumes.
cat > "$PAUSE_COMPOSE_FILE" <<YML
# Generated by the restore tool (scripts/restore-backup.sh, installed as
# portal-restore): restarts the app with the travel notification outbox worker
# paused, so outbox entries reverted by the restore are not re-sent. Delete
# this file and run the documented resume command to resume delivery.
services:
  $APP_SERVICE:
    environment:
      - WACONTROL_NOTIFICATIONS_PAUSED=1
YML

# compose file set for the restarted app: the provisioning-owned compose file
# plus the pause override; staging also merges the deploy-managed
# WHATSAPP_DISABLED=1 override so a restored staging never starts the
# WhatsApp client.
COMPOSE_ARGS=(-f "$COMPOSE_FILE")
if [ "$ENV_NAME" = "staging" ]; then
  if [ ! -f "$STAGING_OVERRIDE_FILE" ]; then
    cat > "$STAGING_OVERRIDE_FILE" <<YML
# Managed by the deploy gate (scripts/vps-deploy.sh, installed as
# portal-deploy): staging runs WITHOUT the WhatsApp Web client
# (WHATSAPP_DISABLED=1). Written here by the restore tool because the file was
# missing; the deploy gate rewrites it on every staging deploy.
services:
  $APP_SERVICE:
    environment:
      - WHATSAPP_DISABLED=1
YML
  fi
  COMPOSE_ARGS+=(-f "$STAGING_OVERRIDE_FILE")
fi
COMPOSE_ARGS+=(-f "$PAUSE_COMPOSE_FILE")

compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
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

RESUME_COMPOSE_ARGS="-f $COMPOSE_FILE"
if [ "$ENV_NAME" = "staging" ]; then
  RESUME_COMPOSE_ARGS="-f $COMPOSE_FILE -f $STAGING_OVERRIDE_FILE"
fi

log "restore: starting $APP_CONTAINER from $RESTORE_IMAGE with WACONTROL_NOTIFICATIONS_PAUSED=1 ($PAUSE_COMPOSE_FILE)"
compose up -d "$APP_SERVICE" || die "docker compose failed to start $APP_CONTAINER"
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
  docker compose $RESUME_COMPOSE_ARGS up -d $APP_SERVICE

What this did NOT cover:
  - media files added to $(basename "$UPLOADS_DIR") after the backup (not in
    the export; preserve them from a separate copy if needed),
  - rows in tables without createdAt/updatedAt (listed under
    "skippedTables" in the export) — re-create those manually,
  - the WhatsApp session is back to its backup-time state; if WhatsApp
    invalidated the session, re-pair from the admin panel.
======================================================================
EOF
