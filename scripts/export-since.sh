#!/usr/bin/env bash
#
# Manual recovery export for portal.nare.am (W3b, task script-param). Runs ON
# THE SERVER. One-time provisioning installs it as
# /usr/local/lib/portal-deploy/portal-export; it is operator-run (manual
# recovery), never invoked by the deploy gate or the CI pipeline.
#
# Before the restore tool (portal-restore) overwrites the live data dirs with
# a pre-deploy backup, this script captures every row that was created or
# updated AFTER that backup was taken, so post-backup data can be reviewed
# and re-applied. It reads the LIVE SQLite database read-only: the database
# file is never opened for writing — it is snapshot-copied (together with its
# -wal/-shm/-journal sidecar files, so un-checkpointed WAL commits survive)
# into a scratch directory and only the copy is queried.
#
# Usage:
#   portal-export <archive>
#
#   <archive>  A backup archive written by the deploy gate, e.g.
#              /opt/stack/backups/portal-production-20260928T120000Z.tar.gz
#
# The cutoff timestamp is the archive's own timestamp: parsed from the
# portal-<env>-YYYYMMDDTHHMMSSZ file name when present, otherwise taken from
# the archive file's mtime. Rows with createdAt or updatedAt greater than or
# equal to the cutoff are exported (inclusive, so a row written in the same
# second as the backup is preserved rather than lost).
#
# Scope: every table that has a createdAt or updatedAt column (messages,
# chats, travel requests, quote versions, documents, workflow events,
# notification deliveries, logs, users, ...). Tables are discovered
# dynamically from sqlite_master, so future timestamped tables are covered
# automatically; tables without either column are listed in "skippedTables"
# and are NOT exported.
#
# Output: JSON written to <archive without .tar.gz>.export.json next to the
# archive (rows keyed by table name, plus counts). Progress goes to stderr.
#
# Execution: prefers the repo checkout's node + generated Prisma client
# (tests, dev machines). On the server (no node on the host) it runs the same
# helper inside the app image via `docker run` with read-only mounts;
# PORTAL_EXPORT_IMAGE selects the image (default portal:latest — or
# portal-staging:latest in staging; after a failed cutover that is the image
# whose schema matches the current database).
#
# Server layout and PORTAL_* overrides are the same as in the deploy gate
# (scripts/vps-deploy.sh); PORTAL_DATABASE_FILE overrides the database path
# directly.
#
# Run this while the app is stopped for a consistent snapshot; against a
# running app the copy is best-effort (rows committed mid-copy can be
# missed), which is why the restore tool only records that it ran.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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
    DEFAULT_IMAGE_REPO="portal"
    ;;
  staging)
    DEFAULT_ROOT="/opt/stack/staging"
    DEFAULT_IMAGE_REPO="portal-staging"
    ;;
  *)
    die "PORTAL_ENV_NAME must be 'staging' or 'production' (got '$ENV_NAME')"
    ;;
esac

ROOT="${PORTAL_ROOT:-$DEFAULT_ROOT}"
DATA_DIR="${PORTAL_DATA_DIR:-$ROOT/portal/data}"
DB_FILE="${PORTAL_DATABASE_FILE:-${DATA_DIR%/}/dev.db}"
EXPORT_IMAGE="${PORTAL_EXPORT_IMAGE:-$DEFAULT_IMAGE_REPO:latest}"

usage() {
  cat >&2 <<'EOF'
usage: portal-export <archive>

  <archive>  Backup archive written by the deploy gate, e.g.
             /opt/stack/backups/portal-production-20260928T120000Z.tar.gz

Reads the live SQLite database read-only and writes a JSON export of every
row created or updated at/after the archive's timestamp from every table
that has a createdAt/updatedAt column. Output:
<archive without .tar.gz>.export.json next to the archive.
EOF
}

[ $# -eq 1 ] || { usage; exit 2; }
ARCHIVE="$1"
[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
[ -f "$DB_FILE" ] || die "live database not found: $DB_FILE (set PORTAL_DATA_DIR or PORTAL_DATABASE_FILE?)"

# Cutoff: the archive's timestamp — from the portal-<env>-YYYYMMDDTHHMMSSZ
# file name when present, else the file mtime (GNU date/stat, Linux only).
archive_since() {
  local base="${1##*/}"
  local s
  if [[ "$base" =~ ^portal-(production|staging)-([0-9]{8}T[0-9]{6}Z)\.tar\.gz$ ]]; then
    s="${BASH_REMATCH[2]}"
    printf '%s-%s-%sT%s:%s:%sZ' "${s:0:4}" "${s:4:2}" "${s:6:2}" "${s:9:2}" "${s:11:2}" "${s:13:2}"
  else
    date -u -d "@$(stat -c %Y "$1")" +%Y-%m-%dT%H:%M:%SZ
  fi
}
SINCE="$(archive_since "$ARCHIVE")"

OUT="${ARCHIVE%.tar.gz}.export.json"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/portal-export-since.XXXXXX")"
cleanup() {
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

cp -- "$DB_FILE" "$SCRATCH/dev.db"
for sidecar in -wal -shm -journal; do
  if [ -f "$DB_FILE$sidecar" ]; then
    cp -- "$DB_FILE$sidecar" "$SCRATCH/dev.db$sidecar"
  fi
done

# The helper is the same code in both run modes; stdout must stay pure JSON
# (the .sh redirects it into the export file), so it logs to stderr.
cat > "$SCRATCH/export-since.js" <<'JS'
"use strict";
// export-since helper (W3b, task script-param): dump every row created or
// updated at/after a cutoff from every table that has createdAt/updatedAt.
// Executed either by the repo checkout's node (local mode) or inside the
// portal image (docker mode) — scripts/export-since.sh picks the runner.
const { PrismaClient } = require("@prisma/client");

function usage(msg) {
  if (msg) console.error(`export-since: ${msg}`);
  console.error("usage: node export-since.js --db <sqlite file> --since <ISO-8601> [--archive <name>]");
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db" || a === "--since" || a === "--archive") {
      if (i + 1 >= argv.length) usage(`missing value for ${a}`);
      out[a.slice(2)] = argv[++i];
    } else {
      usage(`unknown argument: ${a}`);
    }
  }
  if (!out.db || !out.since) usage("--db and --since are required");
  return out;
}

// Prisma's SQLite DateTime storage format is an implementation detail; the
// export must not depend on it. Accept every shape a raw query can return.
function toEpochMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const s = value.trim();
    if (/^-?\d{9,}$/.test(s)) {
      const n = Number(s);
      // Prisma stores epoch milliseconds; tolerate epoch seconds too.
      return n < 1e12 ? n * 1000 : n;
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function jsonSafe(_key, value) {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  return value;
}

async function main() {
  const { db, since, archive } = parseArgs(process.argv.slice(2));
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) usage(`invalid --since: ${since}`);

  const prisma = new PrismaClient({ datasources: { db: { url: `file:${db}` } } });
  try {
    const tables = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' ORDER BY name"
    );
    const result = {
      generatedAt: new Date().toISOString(),
      archive: archive || null,
      // Second precision — the export echoes the archive's own stamp, and
      // archive_since() never carries milliseconds.
      since: new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
      source: db.split("/").pop(),
      tables: {},
      counts: {},
      skippedTables: [],
      totalRows: 0,
    };
    for (const row of tables) {
      const table = row.name;
      if (typeof table !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue;
      const cols = await prisma.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
      const names = cols.map((c) => c.name);
      const hasCreated = names.includes("createdAt");
      const hasUpdated = names.includes("updatedAt");
      if (!hasCreated && !hasUpdated) {
        result.skippedTables.push(table);
        continue;
      }
      // Filter in memory: keeps the cutoff comparison independent of how
      // Prisma serialized the timestamps, at recovery-tool data sizes.
      const all = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}"`);
      const kept = [];
      for (const r of all) {
        const created = hasCreated ? toEpochMs(r.createdAt) : null;
        const updated = hasUpdated ? toEpochMs(r.updatedAt) : null;
        if ((created !== null && created >= sinceMs) || (updated !== null && updated >= sinceMs)) {
          kept.push(r);
        }
      }
      result.tables[table] = kept;
      result.counts[table] = kept.length;
      result.totalRows += kept.length;
      process.stderr.write(`export-since: ${table}: ${kept.length}/${all.length} rows since ${since}\n`);
    }
    process.stdout.write(JSON.stringify(result, jsonSafe, 2) + "\n");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`export-since: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
JS

NODE_MODULES="$REPO_ROOT/node_modules"
if command -v node >/dev/null 2>&1 && [ -f "$NODE_MODULES/.prisma/client/index.js" ]; then
  log "export: querying the database copy with the repo Prisma client"
  NODE_PATH="$NODE_MODULES" node "$SCRATCH/export-since.js" \
    --db "$SCRATCH/dev.db" --since "$SINCE" --archive "$(basename "$ARCHIVE")" > "$OUT"
elif command -v docker >/dev/null 2>&1; then
  log "export: querying the database copy inside $EXPORT_IMAGE (read-only mounts)"
  docker run --rm \
    --volume "$SCRATCH:/export:ro" \
    --workdir /app \
    --env NODE_PATH=/app/node_modules \
    --entrypoint node \
    "$EXPORT_IMAGE" \
    /export/export-since.js --db /export/dev.db --since "$SINCE" \
    --archive "$(basename "$ARCHIVE")" > "$OUT"
else
  die "neither node (repo checkout with a generated Prisma client) nor docker is available"
fi

[ -s "$OUT" ] || die "export produced no output"
log "export written: $OUT"
log "review it (e.g.: grep -c '\"id\"' $OUT, or jq '.counts' $OUT) before any restore"
