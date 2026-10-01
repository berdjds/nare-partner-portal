#!/usr/bin/env bash
#
# Scheduled verified backup for portal.nare.am (W3b, task backup-sched). Runs
# ON THE SERVER, started daily 03:30 by the systemd timer
# (deploy/systemd/portal-backup.timer). One-time provisioning installs it as
# /usr/local/lib/portal-deploy/portal-backup and the forced-command dispatcher
# exposes it as `backup`; this repo copy is the source of truth and the
# pipeline can only call the installed copy, not change it.
#
# This complements the deploy gate's pre-deploy backup (portal-<env>-<UTC>.tar.gz
# from scripts/vps-deploy.sh): the gate only backs up on deploys, the timer
# backs up daily. The two never interfere — this script archives only its own
# portal-backup-* files and prunes only those, never the deploy gate's
# portal-<env>-* archives.
#
# What it does:
#   1. reads settings from $PORTAL_BACKUP_ENV (default /etc/portal-backup.env)
#   2. takes a CONSISTENT database snapshot: `sqlite3 <db> ".backup ..."` for
#      every *.db in the data dir. The SQLite backup API is safe while the
#      app keeps writing — a raw file copy of a live db is not (WAL pages in
#      flight would corrupt the copy). WAL/journal sidecars are runtime state
#      and are never archived.
#   3. archives the data / uploads / auth trees (by basename, the same member
#      layout as the deploy gate, so the restore tool validates members the
#      same way) into $PORTAL_BACKUP_DIR/portal-backup-<UTC>.tar.gz, excluding
#      the Chromium profile caches under the auth dir (regenerable, and by
#      far the bulk of that dir). The trees are LIVE — the auth dir is a
#      running Chromium/WhatsApp profile and uploads receive new media — so
#      GNU tar may exit 1 ("file changed as we read it"): that is logged as a
#      warning and the archive is still verified; only tar exit >= 2 is a
#      hard failure. (The deploy gate never hits this — it tars after the
#      write freeze.)
#   4. verifies the archive: the tar listing must be readable and contain all
#      three trees plus at least one .db, and the sha256 sidecar must check
#      out with `sha256sum -c`.
#   5. retention: prunes portal-backup-*.tar.gz (+ .sha256) older than
#      PORTAL_BACKUP_KEEP_DAYS (default 14) — ONLY after the new archive
#      verified, so a failed backup run can never cost the last verified
#      backup.
#   6. optional off-server copy: PORTAL_OFFSITE_HOOK is run with the archive
#      path as its only argument. A hook failure is a warning, never an
#      error — the local verified backup is kept regardless.
#
# On ANY failure before or during verification — including a hard tar failure
# — the partial archive and its sidecar are removed, nothing is pruned, the
# hook is not called, exit 1.
#
# Settings (bash-sourced file; keep it root-owned 0600 on the server). Values
# set in the file override the inherited environment; unset values fall back
# to the environment, then to the defaults:
#   PORTAL_ROOT             default /opt/stack
#   PORTAL_DATA_DIR         default $PORTAL_ROOT/portal/data
#   PORTAL_UPLOADS_DIR      default $PORTAL_ROOT/portal/uploads
#   PORTAL_AUTH_DIR         default $PORTAL_ROOT/portal/auth
#   PORTAL_BACKUP_DIR       default $PORTAL_ROOT/backups
#   PORTAL_BACKUP_KEEP_DAYS default 14
#   PORTAL_OFFSITE_HOOK     optional; executable run as `<hook> <archive>`

set -euo pipefail

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

SETTINGS_FILE="${PORTAL_BACKUP_ENV:-/etc/portal-backup.env}"
if [ -f "$SETTINGS_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$SETTINGS_FILE"
  set +a
fi

ROOT="${PORTAL_ROOT:-/opt/stack}"
DATA_DIR="${PORTAL_DATA_DIR:-$ROOT/portal/data}"
UPLOADS_DIR="${PORTAL_UPLOADS_DIR:-$ROOT/portal/uploads}"
AUTH_DIR="${PORTAL_AUTH_DIR:-$ROOT/portal/auth}"
BACKUP_DIR="${PORTAL_BACKUP_DIR:-$ROOT/backups}"
KEEP_DAYS="${PORTAL_BACKUP_KEEP_DAYS:-14}"
OFFSITE_HOOK="${PORTAL_OFFSITE_HOOK:-}"

# Trailing slashes would break the basename/dirname archiving below.
DATA_DIR="${DATA_DIR%/}"
UPLOADS_DIR="${UPLOADS_DIR%/}"
AUTH_DIR="${AUTH_DIR%/}"

case "$KEEP_DAYS" in
  *[!0-9]* | "")
    die "PORTAL_BACKUP_KEEP_DAYS must be a non-negative integer (got '$KEEP_DAYS')"
    ;;
esac

DATA_BASE="$(basename "$DATA_DIR")"
UPLOADS_BASE="$(basename "$UPLOADS_DIR")"
AUTH_BASE="$(basename "$AUTH_DIR")"

# Each tree is archived by basename; duplicate basenames would collide in the
# archive and corrupt a later restore (same rule as the deploy gate).
dupes="$(printf '%s\n' "$DATA_BASE" "$UPLOADS_BASE" "$AUTH_BASE" | sort | uniq -d)"
[ -z "$dupes" ] || die "data, uploads and auth dirs must have distinct names to be archivable (duplicate: $dupes)"

[ -d "$DATA_DIR" ] || die "data dir not found: $DATA_DIR"
[ -d "$UPLOADS_DIR" ] || die "uploads dir not found: $UPLOADS_DIR"
[ -d "$AUTH_DIR" ] || die "auth dir not found: $AUTH_DIR"

shopt -s nullglob
DB_FILES=("$DATA_DIR"/*.db)
[ "${#DB_FILES[@]}" -gt 0 ] || die "no database files (*.db) in $DATA_DIR — refusing to write a backup without the database"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/portal-backup-$STAMP.tar.gz"
WORK_DIR=""

cleanup() {
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
}
trap cleanup EXIT

WORK_DIR="$(mktemp -d)" || die "mktemp failed"
mkdir -p "$BACKUP_DIR" || die "cannot create backup dir $BACKUP_DIR"

# --- staging tree: consistent sqlite3 .backup snapshots of the databases ----
STAGE_DATA="$WORK_DIR/$DATA_BASE"
mkdir -p "$STAGE_DATA" || die "cannot create staging dir $STAGE_DATA"

shopt -s dotglob
for entry in "$DATA_DIR"/*; do
  case "$(basename "$entry")" in
    # Live db files come from sqlite3 .backup below; WAL/journal sidecars are
    # runtime state and must never be archived — a restored -wal applied to
    # the restored db could corrupt it.
    *.db | *.db-wal | *.db-journal | *.db-shm) continue ;;
  esac
  cp -a "$entry" "$STAGE_DATA/" || die "failed to stage $(basename "$entry") from the data dir"
done

for db in "${DB_FILES[@]}"; do
  log "backup: sqlite3 .backup $DATA_BASE/$(basename "$db")"
  sqlite3 "$db" ".backup '$STAGE_DATA/$(basename "$db")'" \
    || die "sqlite3 .backup failed for $db — is the sqlite3 CLI installed on the host?"
done

# --- archive -----------------------------------------------------------------
# Chromium profile caches are regenerable and by far the bulk of the auth
# dir; everything else (local storage, cookies, session keys) is kept.
CACHE_EXCLUDES=(
  --exclude='*/Cache'
  --exclude='*/Code Cache'
  --exclude='*/GPUCache'
  --exclude='*/CacheStorage'
  --exclude='*/Crashpad'
)

log "backup: archiving to $ARCHIVE"
rm -f -- "$ARCHIVE" "$ARCHIVE.sha256"

fail_unverified() {
  # A partial/corrupt archive must never be mistaken for a verified backup —
  # retention only ever runs after verification, so without this cleanup a
  # persistent failure (e.g. a full disk) would leave one more orphan
  # portal-backup-*.tar.gz every night and nothing would prune them.
  rm -f -- "$ARCHIVE" "$ARCHIVE.sha256"
  die "$1"
}

# GNU tar exits 1 when a file changed or vanished while being read — expected
# here because the trees are live (the auth dir is a running Chromium
# profile, uploads receive new media). The archive is complete apart from
# those members, so exit 1 is a warning and the archive is still verified
# below; only exit >= 2 is a real failure.
tar_status=0
tar -czf "$ARCHIVE" "${CACHE_EXCLUDES[@]}" \
  -C "$WORK_DIR" "$DATA_BASE" \
  -C "$(dirname "$UPLOADS_DIR")" "$UPLOADS_BASE" \
  -C "$(dirname "$AUTH_DIR")" "$AUTH_BASE" \
  || tar_status=$?
if [ "$tar_status" -eq 1 ]; then
  log "warning: tar reported files changed while being archived — continuing with verification" >&2
elif [ "$tar_status" -ge 2 ]; then
  fail_unverified "tar failed (exit $tar_status)"
fi

# --- verify ------------------------------------------------------------------

LISTING="$(tar -tzf "$ARCHIVE" 2>/dev/null)" \
  || fail_unverified "verification failed: $ARCHIVE is not a readable tar archive"
grep -q '\.db$' <<< "$LISTING" \
  || fail_unverified "verification failed: no database file in $ARCHIVE"
for base in "$DATA_BASE" "$UPLOADS_BASE" "$AUTH_BASE"; do
  grep -q "^$base/" <<< "$LISTING" \
    || fail_unverified "verification failed: tree $base/ missing from $ARCHIVE"
done
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256" \
  || fail_unverified "failed to write $ARCHIVE.sha256"
( cd "$BACKUP_DIR" && sha256sum -c -- "$(basename "$ARCHIVE").sha256" > /dev/null ) \
  || fail_unverified "verification failed: sha256 mismatch for $ARCHIVE"
log "backup: verified $(basename "$ARCHIVE") (tar listing ok, sha256 recorded and checked)"

# --- retention ---------------------------------------------------------------
# Only this script's own archives, and only after the new one verified: a
# failed run never reaches this line, so pruning can never cost the last
# verified backup. The deploy gate's portal-<env>-*.tar.gz archives are NOT
# matched by the portal-backup-* pattern.
find "$BACKUP_DIR" \
  \( -name 'portal-backup-*.tar.gz' -o -name 'portal-backup-*.tar.gz.sha256' \) \
  -type f -mtime +"$KEEP_DAYS" -delete \
  || log "warning: retention pruning failed (keeping everything)" >&2
log "backup: pruned portal-backup-* archives older than $KEEP_DAYS days"

# --- off-server hook ---------------------------------------------------------
if [ -n "$OFFSITE_HOOK" ]; then
  log "backup: running off-site hook $OFFSITE_HOOK"
  if "$OFFSITE_HOOK" "$ARCHIVE"; then
    log "backup: off-site hook finished"
  else
    hook_status=$?
    # The local verified archive stays regardless — a failing off-server copy
    # is an off-server problem and must never cost the local backup.
    log "warning: off-site hook failed (exit $hook_status) — the local verified backup is kept" >&2
  fi
fi

log "backup: done ($(basename "$ARCHIVE"))"
