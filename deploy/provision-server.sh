#!/usr/bin/env bash
#
# One-time server provisioning for portal.nare.am (W3b provisioning, fitted to
# the live /opt/stack layout from W3d in W3e). Run ONCE by the owner with sudo
# from a repo checkout:
#
#   sudo deploy/provision-server.sh --pubkey-file <path> [--dry-run]
#
# Idempotent (cmp-based installs, mkdir -p, write-only-if-absent for
# operator-owned files, a marker-delimited caddy block that regenerates
# byte-identically) so re-running it after adding missing pieces (e.g. the
# production compose file or the Caddyfile) converges the server without
# disturbing anything. NEVER run by CI: the pipeline only ever talks to the
# installed forced-command dispatcher.
#
# What it sets up (server layout is fixed):
#   - sqlite3 (apt) — needed by the backup tool for consistent live-db copies
#   - the `deploy` user (no password, NOT in the docker group; login shell
#     /bin/sh so sshd can run the forced command — interactive access is still
#     impossible) and its authorized_keys, pinned to the dispatcher
#   - /usr/local/lib/portal-deploy/{portal-deploy,portal-restore,portal-export,
#     portal-backup,portal-smoke,portal-drill} from scripts/*.sh (this repo is
#     the source of truth; portal-drill only when scripts/portal-drill.sh has
#     shipped, otherwise a [warn] and continue)
#   - /usr/local/sbin/portal-deploy-entry (the dispatcher) and the sudoers
#     drop-in that lets `deploy` run ONLY that dispatcher as root
#   - the daily backup systemd units + /etc/portal-backup.env
#   - the /opt/stack layout dirs and the staging compose project (compose
#     file, .env.staging + .env symlink)
#   - the production Docker network, discovered from the running portal-app
#     container and recorded as PORTAL_NETWORK in the staging env file: the
#     live layout (/opt/stack/docker-compose.yml, mirrored in deploy/portal/)
#     uses a compose-managed network whose real name is project-prefixed, so
#     it is discovered, never hard-coded
#   - the managed staging site block (BEGIN/END markers) in the live
#     /opt/stack/Caddyfile: timestamped backup, the candidate validated inside
#     the caddy container BEFORE the live path is touched, then a reload; on
#     any failure the backup is restored
#
# It deliberately does NOT install /opt/stack/docker-compose.yml,
# /opt/stack/.env or /opt/stack/Caddyfile — those are owner-installed from the
# deploy/portal/ examples (see the NEXT STEPS block at the end). It never
# touches any host-level caddy path: the only caddy config path it uses is the
# container-internal one, and only ever through docker exec.
#
# Safety rails:
#   - BEFORE and AFTER manifests of the production data dirs prove
#     provisioning never touched production data (mismatch -> die).
#   - --dry-run prints every action and changes nothing (no root required).
#   - PORTAL_PROVISION_ROOT ("transplant mode", used by the tests): every
#     absolute target path is prefixed with that root; file/dir work happens
#     under it while system mutations (apt-get, useradd, chown, systemctl)
#     are logged as [skip] instead of executed.

set -euo pipefail

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf '[warn] %s\n' "$*" >&2
}

usage() {
  cat >&2 <<'EOF'
usage: provision-server.sh --pubkey-file <path> [--dry-run]

One-time server provisioning for portal.nare.am. Run ONCE by the owner with
sudo. Idempotent. NEVER run by CI.

  --pubkey-file <path>  File holding the deploy user's SSH public key (one line).
  --dry-run             Print every action it would take; change nothing.

Environment:
  PORTAL_PROVISION_ROOT  Prefix every absolute target path with this root
                         ("transplant mode", used by the tests). System
                         mutations are logged ([skip]), not executed.
  PORTAL_CADDY_CONTAINER Caddy container name (default: caddy).
  PORTAL_CADDYFILE       Live Caddyfile path (default: /opt/stack/Caddyfile).
  PORTAL_APP_CONTAINER   Production app container the network is discovered
                         from (default: portal-app).
  PORTAL_NETWORK         Production Docker network; when set, discovery is
                         skipped and this value is recorded for staging.
EOF
}

# The repo root is the parent of this script's own directory, so the
# installed-script sources and systemd units are read from the checkout the
# owner is provisioning from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- step 1: arguments --------------------------------------------------------

PUBKEY_FILE=""
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pubkey-file)
      [ "$#" -ge 2 ] || die "--pubkey-file requires a value"
      PUBKEY_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$PUBKEY_FILE" ] || { usage; die "--pubkey-file is required"; }
[ -f "$PUBKEY_FILE" ] || die "public key file not found: $PUBKEY_FILE"
[ -r "$PUBKEY_FILE" ] || die "public key file not readable: $PUBKEY_FILE"
[ -s "$PUBKEY_FILE" ] || die "public key file is empty: $PUBKEY_FILE"
# Single line, trimmed; the key type prefix check rejects private keys,
# certificates and other paste mistakes before they reach authorized_keys.
PUBKEY="$(head -n 1 "$PUBKEY_FILE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
case "$PUBKEY" in
  ssh-* | ecdsa-* | sk-*) ;;
  *)
    die "not an SSH public key (must start with ssh-, ecdsa- or sk-): $PUBKEY_FILE"
    ;;
esac

ROOT="${PORTAL_PROVISION_ROOT:-}"
ROOT="${ROOT%/}"

if [ "$DRY_RUN" -eq 0 ] && [ -z "$ROOT" ] && [ "$EUID" -ne 0 ]; then
  die "must run as root — use sudo (or rehearse with --dry-run / PORTAL_PROVISION_ROOT)"
fi

# --- live-layout settings (from W3d) --------------------------------------------
# The live /opt/stack compose project runs the caddy container and the app
# container on a compose-managed network whose real name depends on the
# compose project name, so the network is discovered from the running app
# container — never hard-coded. Every default is overridable for rehearsals
# and tests.

STAGING_DIR="${PORTAL_STAGING_DIR:-$ROOT/opt/stack/staging}"
PORTAL_CADDY_CONTAINER="${PORTAL_CADDY_CONTAINER:-caddy}"
PORTAL_CADDYFILE="${PORTAL_CADDYFILE:-$ROOT/opt/stack/Caddyfile}"
PORTAL_APP_CONTAINER="${PORTAL_APP_CONTAINER:-portal-app}"
PORTAL_NETWORK="${PORTAL_NETWORK:-}"

BEGIN_MARKER="# BEGIN staging.portal.nare.am (managed by provision-server.sh)"
END_MARKER="# END staging.portal.nare.am"

# --- helpers (all filesystem writes funnel through these) ---------------------

TMP_FILES=()
cleanup() {
  if [ "${#TMP_FILES[@]}" -gt 0 ]; then
    rm -f -- "${TMP_FILES[@]}"
  fi
}
trap cleanup EXIT

# stage_content — copy stdin to a temp file and print its path, so heredoc
# content flows through install_file exactly like a repo source file.
stage_content() {
  local tmp
  tmp="$(mktemp)" || die "mktemp failed"
  cat > "$tmp"
  TMP_FILES+=("$tmp")
  printf '%s\n' "$tmp"
}

# mkdir_p <path> — create a directory; print [mkdir] only when something was
# actually created (re-runs stay silent).
mkdir_p() {
  local dir="$1"
  if [ -d "$dir" ]; then
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would mkdir -p %s\n' "$dir"
    return 0
  fi
  mkdir -p -- "$dir" || die "cannot create directory $dir"
  printf '[mkdir] %s\n' "$dir"
}

# install_file <src> <dest> <mode> — cmp-based idempotent install: rewrite
# only when the content differs, so re-runs report [unchanged] instead of
# touching mtimes.
install_file() {
  local src="$1" dest="$2" mode="$3"
  [ -f "$src" ] || die "source not found: $src"
  if [ -f "$dest" ] && cmp -s -- "$src" "$dest"; then
    printf '[unchanged] %s\n' "$dest"
    return 0
  fi
  local verb="install"
  if [ -e "$dest" ]; then
    verb="update"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would %s %s (mode %s)\n' "$verb" "$dest" "$mode"
    return 0
  fi
  mkdir_p "$(dirname -- "$dest")"
  install -m "$mode" -- "$src" "$dest" || die "failed to install $dest"
  printf '[%s] %s\n' "$verb" "$dest"
}

# install_if_absent <src> <dest> <mode> — write only when <dest> does not
# exist: operator-owned settings must never be overwritten by provisioning.
install_if_absent() {
  local src="$1" dest="$2" mode="$3"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    printf '[unchanged] %s\n' "$dest"
    return 0
  fi
  install_file "$src" "$dest" "$mode"
}

# run_system <description> <cmd...> — the one funnel for real system
# mutations, so the dry-run and transplant policies live in a single place.
run_system() {
  local desc="$1"
  shift
  if [ -n "$ROOT" ]; then
    printf '[skip] system step in test root: %s\n' "$*"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would run: %s\n' "$*"
    return 0
  fi
  printf '[run] %s\n' "$desc"
  "$@" || die "system step failed: $*"
}

# compute_manifest — snapshot of the production data dirs: every regular file
# under data/uploads/auth, hashed, paths relative and sorted; MANIFEST_SUMMARY
# is "sha256=<hash-of-listing> files=<n>", MANIFEST_LISTING the listing itself
# (kept for the before/after diff). Missing dirs contribute nothing.
compute_manifest() {
  local portal_dir="$ROOT/opt/stack/portal"
  local listing=""
  if [ -d "$portal_dir" ]; then
    listing="$(
      cd "$portal_dir" || exit 1
      for base in data uploads auth; do
        if [ -d "$base" ]; then
          find "$base" -type f
        fi
      done | LC_ALL=C sort | while IFS= read -r f; do
        sha256sum -- "$f"
      done
    )"
  fi
  MANIFEST_LISTING="$listing"
  local count=0 hash
  if [ -n "$listing" ]; then
    count="$(printf '%s\n' "$listing" | wc -l)"
    hash="$(printf '%s\n' "$listing" | sha256sum | cut -d ' ' -f 1)"
  else
    hash="$(printf '' | sha256sum | cut -d ' ' -f 1)"
  fi
  MANIFEST_SUMMARY="sha256=$hash files=$count"
}

# docker_available — docker is used for network discovery and for validating
# and reloading caddy INSIDE its container. It is not funnelled through
# run_system on purpose: a read-only inspect and a config validate/reload are
# safe in transplant mode (the tests drive them with a PATH stub), and on a
# host without docker every caller below degrades to a [warn].
docker_available() {
  command -v docker > /dev/null 2>&1
}

# caddy_container_running — candidate validation and the reload only happen
# when the caddy container is actually there to run them; otherwise the caller
# warns and skips (deterministic on hosts that have docker but no caddy).
caddy_container_running() {
  docker_available || return 1
  docker ps --format '{{.Names}}' 2> /dev/null | grep -qx -- "$PORTAL_CADDY_CONTAINER"
}

# --- step 2: BEFORE manifest of the production data dirs ----------------------
# Provisioning must never touch production data; the AFTER manifest (step 13)
# is compared against this one and any difference aborts with an error.

compute_manifest
BEFORE_SUMMARY="$MANIFEST_SUMMARY"
BEFORE_LISTING="$MANIFEST_LISTING"
printf 'production data manifest (before): %s\n' "$BEFORE_SUMMARY"

# --- step 3: sqlite3 -----------------------------------------------------------
# The backup tool uses `sqlite3 <db> ".backup ..."` for consistent snapshots
# of the live database; the host package provides the CLI.

if command -v sqlite3 > /dev/null 2>&1; then
  printf '[unchanged] sqlite3 (already installed)\n'
else
  run_system "install sqlite3 (needed for consistent live-database backups)" apt-get install -y sqlite3
fi

# --- step 4: deploy user -------------------------------------------------------
# No password and deliberately NOT in the docker group: the deploy user must
# hold no privilege of its own — all privilege flows through the forced-command
# dispatcher (the only thing sudoers lets it run as root). The login shell is
# /bin/sh, NOT a nologin binary: sshd runs the forced command as
# `<login shell> -c <command>`, so a nologin shell would print "This account
# is currently not available" and exit 1 before the dispatcher ever runs.
# Interactive access stays blocked by the forced command itself, the no-pty
# option and the dispatcher rejecting an empty SSH_ORIGINAL_COMMAND.

if [ -n "$ROOT" ] || [ "$DRY_RUN" -eq 1 ]; then
  run_system "create the deploy user" useradd --create-home --shell /bin/sh deploy
elif id deploy > /dev/null 2>&1; then
  printf '[unchanged] user deploy\n'
else
  run_system "create the deploy user" useradd --create-home --shell /bin/sh deploy
fi

# --- step 5: authorized_keys ---------------------------------------------------
# Exactly one key, locked to the dispatcher: forced command, no forwarding, no
# pty. The deploy user can therefore only ever say the dispatcher's words.

SSH_DIR="$ROOT/home/deploy/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"
mkdir_p "$SSH_DIR"
if [ "$DRY_RUN" -eq 1 ]; then
  if [ ! -d "$SSH_DIR" ]; then
    printf '[dry-run] would chmod 0700 %s\n' "$SSH_DIR"
  fi
else
  chmod 0700 "$SSH_DIR" || die "cannot chmod 0700 $SSH_DIR"
fi
install_file "$(stage_content <<EOF
command="/usr/local/sbin/portal-deploy-entry",no-port-forwarding,no-agent-forwarding,no-pty,no-X11-forwarding $PUBKEY
EOF
)" "$AUTH_KEYS" 0600
run_system "own $SSH_DIR by the deploy user" chown -R deploy:deploy "$SSH_DIR"

# --- step 6: the dispatcher's tool library --------------------------------------
# Installed root-owned under /usr/local/lib/portal-deploy: the pipeline calls
# these through the dispatcher but can never modify them.

LIB_DEST="$ROOT/usr/local/lib/portal-deploy"
install_file "$REPO_ROOT/scripts/vps-deploy.sh" "$LIB_DEST/portal-deploy" 0755
install_file "$REPO_ROOT/scripts/restore-backup.sh" "$LIB_DEST/portal-restore" 0755
install_file "$REPO_ROOT/scripts/export-since.sh" "$LIB_DEST/portal-export" 0755
install_file "$REPO_ROOT/scripts/portal-backup.sh" "$LIB_DEST/portal-backup" 0755
install_file "$REPO_ROOT/scripts/smoke-test.sh" "$LIB_DEST/portal-smoke" 0755
if [ -f "$REPO_ROOT/scripts/portal-drill.sh" ]; then
  install_file "$REPO_ROOT/scripts/portal-drill.sh" "$LIB_DEST/portal-drill" 0755
else
  warn "scripts/portal-drill.sh not found — drill commands unavailable until it ships"
fi

# --- step 7: the forced-command dispatcher --------------------------------------

install_file "$REPO_ROOT/deploy/portal-deploy-entry.sh" "$ROOT/usr/local/sbin/portal-deploy-entry" 0755

# --- step 8: sudoers drop-in -----------------------------------------------------
# Validated with visudo BEFORE install whenever visudo is available: a broken
# sudoers file can lock every admin out of root, so a failed validation dies
# without installing.

SUDOERS_TMP="$(stage_content <<'EOF'
# W3b: the deploy user may run ONLY the forced-command dispatcher as root.
# The dispatcher re-validates every command itself, so this grants no shell.
deploy ALL=(root) NOPASSWD: /usr/local/sbin/portal-deploy-entry
EOF
)"
if command -v visudo > /dev/null 2>&1; then
  visudo -cf "$SUDOERS_TMP" > /dev/null 2>&1 || die "sudoers drop-in failed visudo validation — not installed"
else
  warn "visudo not found — installing sudoers drop-in without validation"
fi
install_file "$SUDOERS_TMP" "$ROOT/etc/sudoers.d/portal-deploy" 0440

# --- step 9: daily backup schedule ------------------------------------------------

SYSTEMD_DIR="$ROOT/etc/systemd/system"
install_file "$REPO_ROOT/deploy/systemd/portal-backup.service" "$SYSTEMD_DIR/portal-backup.service" 0644
install_file "$REPO_ROOT/deploy/systemd/portal-backup.timer" "$SYSTEMD_DIR/portal-backup.timer" 0644
run_system "reload systemd unit definitions" systemctl daemon-reload
run_system "enable and start the daily backup timer" systemctl enable --now portal-backup.timer
install_if_absent "$(stage_content <<'EOF'
# Settings for /usr/local/lib/portal-deploy/portal-backup (see scripts/portal-backup.sh).
PORTAL_BACKUP_KEEP_DAYS=14
# Optional off-server copy hook, run as: <hook> <archive>
#PORTAL_OFFSITE_HOOK=/usr/local/bin/portal-offsite
EOF
)" "$ROOT/etc/portal-backup.env" 0600

# --- step 10: server layout directories ---------------------------------------------
# Most already exist by now (install_file creates parents); these calls are
# silent in that case and only fill in what is still missing.

mkdir_p "$ROOT/opt/stack/portal/data"
mkdir_p "$ROOT/opt/stack/portal/uploads"
mkdir_p "$ROOT/opt/stack/portal/auth"
mkdir_p "$ROOT/opt/stack/portal/src"
mkdir_p "$ROOT/opt/stack/backups"
mkdir_p "$STAGING_DIR/portal/data"
mkdir_p "$STAGING_DIR/portal/uploads"
mkdir_p "$STAGING_DIR/portal/auth"
mkdir_p "$STAGING_DIR/portal/src"
mkdir_p "$STAGING_DIR/backups"
mkdir_p "$ROOT/etc/sudoers.d"
mkdir_p "$ROOT/usr/local/lib/portal-deploy"
mkdir_p "$ROOT/usr/local/sbin"
mkdir_p "$ROOT/etc/systemd/system"
mkdir_p "$ROOT/home/deploy/.ssh"

# --- step 11: staging compose project --------------------------------------------

if [ -f "$REPO_ROOT/deploy/staging/docker-compose.yml" ]; then
  install_file "$REPO_ROOT/deploy/staging/docker-compose.yml" "$STAGING_DIR/docker-compose.yml" 0644
else
  warn "deploy/staging/docker-compose.yml not found — staging compose project not installed"
fi

install_if_absent "$(stage_content <<'EOF'
# Staging environment for https://staging.portal.nare.am — written once by
# deploy/provision-server.sh, then operator-owned. docker compose reads it
# through the .env symlink next to the staging compose file.
WHATSAPP_DISABLED=1
# Credentials are intentionally EMPTY: the staging compose file guards them
# with ${VAR:?}, so staging refuses to boot until the owner fills in real
# values — a forgotten staging must never run with a repo-known session
# secret or admin login (staging can receive production archives via
# `restore <archive>`, so a known admin password here would expose
# production data).
PORTAL_NEXTAUTH_SECRET=
PORTAL_ADMIN_EMAIL=
PORTAL_ADMIN_PASSWORD=
# The production Docker network the staging project joins as an external
# network (its real name is compose-project-prefixed, e.g.
# stack_portal_net). deploy/provision-server.sh discovers it from the
# running portal-app container and records it here; it may also be set by
# hand instead of re-running provisioning.
PORTAL_NETWORK=
# Staging mail goes to a sink, never to real recipients.
PORTAL_SMTP_HOST=mail-sink.invalid
PORTAL_SMTP_PORT=25
PORTAL_SMTP_USER=
PORTAL_SMTP_PASS=
PORTAL_SMTP_FROM=staging@portal.nare.am
EOF
)" "$STAGING_DIR/.env.staging" 0600

# docker compose and the deploy gate only auto-read `.env`; the relative
# symlink keeps .env.staging the single source of truth while giving both
# tools the file they look for.
ENV_LINK="$STAGING_DIR/.env"
if [ -e "$ENV_LINK" ] || [ -L "$ENV_LINK" ]; then
  printf '[unchanged] %s\n' "$ENV_LINK"
elif [ "$DRY_RUN" -eq 1 ]; then
  printf '[dry-run] would symlink %s -> .env.staging\n' "$ENV_LINK"
else
  ln -s .env.staging "$ENV_LINK" || die "failed to create symlink $ENV_LINK"
  printf '[symlink] %s -> .env.staging\n' "$ENV_LINK"
fi

# --- step 12: production network discovery -----------------------------------------
# The staging compose project joins the production network as an external
# network named by PORTAL_NETWORK. The live network name is
# compose-project-prefixed, so it is discovered from the running portal-app
# container. Discovery is best-effort: provisioning also runs before the
# stack exists (the owner installs the production compose file afterwards),
# so a failed discovery warns and is picked up by a later re-run — the
# staging compose :? guard refuses to boot until a value is recorded.

discover_network() {
  # Sets DISCOVERED_NETWORK; empty means "not discoverable right now".
  DISCOVERED_NETWORK=""
  if [ -n "$PORTAL_NETWORK" ]; then
    DISCOVERED_NETWORK="$PORTAL_NETWORK"
    printf 'using preset PORTAL_NETWORK: %s\n' "$DISCOVERED_NETWORK"
    return 0
  fi
  if ! docker_available; then
    warn "docker not found — cannot discover the production network; set PORTAL_NETWORK in $STAGING_DIR/.env.staging or re-run once the stack is up"
    return 0
  fi
  local networks
  if ! networks="$(docker inspect --format '{{range $name, $conf := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$PORTAL_APP_CONTAINER" 2> /dev/null)"; then
    warn "could not inspect container '$PORTAL_APP_CONTAINER' (is the live stack running?) — PORTAL_NETWORK not recorded; set it in $STAGING_DIR/.env.staging or re-run after the stack is up"
    return 0
  fi
  DISCOVERED_NETWORK="$(printf '%s\n' "$networks" | awk 'NF { print; exit }')"
  if [ -z "$DISCOVERED_NETWORK" ]; then
    warn "container '$PORTAL_APP_CONTAINER' reported no attached networks — set PORTAL_NETWORK explicitly"
    return 0
  fi
  printf 'discovered production network from %s: %s\n' "$PORTAL_APP_CONTAINER" "$DISCOVERED_NETWORK"
}

record_staging_network() {
  local network="$1"
  [ -n "$network" ] || return 0
  local env_file="$STAGING_DIR/.env.staging"
  local current=""
  if [ -f "$env_file" ]; then
    current="$(sed -n 's/^PORTAL_NETWORK=//p' "$env_file" | head -n 1)"
  fi
  if [ "$current" = "$network" ]; then
    printf '[unchanged] PORTAL_NETWORK in %s\n' "$env_file"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would set PORTAL_NETWORK=%s in %s\n' "$network" "$env_file"
    return 0
  fi
  if [ -f "$env_file" ] && grep -q '^PORTAL_NETWORK=' "$env_file"; then
    sed -i "s|^PORTAL_NETWORK=.*|PORTAL_NETWORK=${network}|" "$env_file" || die "failed to record PORTAL_NETWORK in $env_file"
  else
    printf 'PORTAL_NETWORK=%s\n' "$network" >> "$env_file" || die "failed to record PORTAL_NETWORK in $env_file"
  fi
  printf '[update] PORTAL_NETWORK=%s in %s\n' "$network" "$env_file"
}

discover_network
record_staging_network "$DISCOVERED_NETWORK"

# --- step 13: staging Caddy site block ------------------------------------------------
# The staging site is a managed block (BEGIN/END markers) inside the live
# Caddyfile, NOT a separate host file: the live layout mounts a single
# Caddyfile into the caddy container. The candidate (old block dropped,
# trailing blank lines trimmed, fresh block appended) is byte-identical on
# every re-run, validated inside the caddy container BEFORE the live path is
# touched, and the live file is restored from its timestamped backup when
# anything fails.

install_staging_caddy_block() {
  if [ ! -f "$PORTAL_CADDYFILE" ]; then
    warn "$PORTAL_CADDYFILE not found — install it from deploy/portal/Caddyfile.example and re-run; staging block not installed"
    return 0
  fi

  local candidate
  candidate="$(mktemp)" || die "mktemp failed"
  TMP_FILES+=("$candidate")
  {
    awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
      $0 == begin { skip = 1; next }
      $0 == end { skip = 0; next }
      skip { next }
      { lines[++n] = $0 }
      END {
        while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--
        for (i = 1; i <= n; i++) print lines[i]
      }
    ' "$PORTAL_CADDYFILE"
    printf '\n'
    printf '%s\n' "$BEGIN_MARKER"
    printf 'staging.portal.nare.am {\n\tencode gzip\n\treverse_proxy portal-staging:3000\n}\n'
    printf '%s\n' "$END_MARKER"
  } > "$candidate" || die "failed to build the staging Caddyfile candidate"

  if cmp -s -- "$candidate" "$PORTAL_CADDYFILE"; then
    printf '[unchanged] %s (staging block present)\n' "$PORTAL_CADDYFILE"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would install the staging block into %s\n' "$PORTAL_CADDYFILE"
    return 0
  fi

  local backup
  backup="$PORTAL_CADDYFILE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a -- "$PORTAL_CADDYFILE" "$backup" || die "failed to back up $PORTAL_CADDYFILE"
  printf '[backup] %s -> %s\n' "$PORTAL_CADDYFILE" "$backup"

  # Validate the CANDIDATE inside the caddy container before the live path is
  # touched — an invalid file must never be installed. A validation failure
  # leaves the live Caddyfile exactly as it was (the backup is kept for
  # inspection).
  if caddy_container_running; then
    if ! docker exec -i "$PORTAL_CADDY_CONTAINER" sh -c 'cat > /tmp/Caddyfile.provision-candidate && caddy validate --config /tmp/Caddyfile.provision-candidate' < "$candidate"; then
      die "candidate Caddyfile failed validation inside the $PORTAL_CADDY_CONTAINER container — live Caddyfile untouched (backup: $backup)"
    fi
    printf '[caddy] candidate validated inside the %s container\n' "$PORTAL_CADDY_CONTAINER"
  else
    warn "$PORTAL_CADDY_CONTAINER container not reachable — installing the staging block WITHOUT validation"
  fi

  # Write the candidate IN PLACE, preserving the inode: the live layout
  # bind-mounts the single Caddyfile into the caddy container as a single
  # file, and a single-file bind mount stays
  # pinned to the inode it was created with. Unlinking and recreating the file
  # (install/mv) would leave the container serving the OLD content — the
  # reload below would succeed against the old file and the staging site would
  # never activate until a container restart.
  cat -- "$candidate" > "$PORTAL_CADDYFILE" || die "failed to install the staging block into $PORTAL_CADDYFILE"
  printf '[caddy] staging block installed in %s\n' "$PORTAL_CADDYFILE"

  # The reload targets the container-internal config path (where the live
  # Caddyfile is mounted): only the caddy container ever sees that path, and
  # only through docker exec.
  if caddy_container_running; then
    if ! docker exec "$PORTAL_CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile; then
      # In-place restore as well (same single-file bind-mount reason as above).
      cat -- "$backup" > "$PORTAL_CADDYFILE"
      docker exec "$PORTAL_CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile > /dev/null 2>&1 || true
      die "caddy reload failed — restored $PORTAL_CADDYFILE from $backup and reloaded the previous config"
    fi
    printf '[caddy] reloaded inside the %s container\n' "$PORTAL_CADDY_CONTAINER"
  else
    warn "$PORTAL_CADDY_CONTAINER container not reachable — reload caddy once the stack is up to activate the staging site"
  fi
}

install_staging_caddy_block

# --- step 14: AFTER manifest — provisioning must never touch production data -------

compute_manifest
printf 'production data manifest (after): %s\n' "$MANIFEST_SUMMARY"
if [ "$MANIFEST_SUMMARY" != "$BEFORE_SUMMARY" ]; then
  diff <(printf '%s\n' "$BEFORE_LISTING") <(printf '%s\n' "$MANIFEST_LISTING") >&2 || true
  die "production data dirs changed during provisioning"
fi

# --- step 15: what remains for the owner ----------------------------------------------

cat <<'EOF'
NEXT STEPS:
  1. Leave the live files exactly as they are: /opt/stack/docker-compose.yml,
     /opt/stack/.env and /opt/stack/Caddyfile already exist on this server
     and are never installed or overwritten by provisioning or by a deploy
     (deploy/portal/docker-compose.yml in the repo is only a reference copy
     of the live layout).
  2. Set the staging credentials in /opt/stack/staging/.env.staging
     (PORTAL_NEXTAUTH_SECRET, PORTAL_ADMIN_EMAIL, PORTAL_ADMIN_PASSWORD) —
     provisioning leaves them empty on purpose, and the compose :? guards
     refuse to boot staging until real values are set.
  3. Re-run this script once the production stack is up (or set
     PORTAL_NETWORK in /opt/stack/staging/.env.staging by hand) so the
     production network is recorded and the staging Caddy block is
     validated and activated.
  4. Add the DEPLOY_* secrets and the PORTAL_URL / STAGING_URL variables to
     the CI project settings.
  5. Run the staging drills (drill-rollback / drill-restore through the
     deploy key) before enabling the production release pipeline.
EOF
