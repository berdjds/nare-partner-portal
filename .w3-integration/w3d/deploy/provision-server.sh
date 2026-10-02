#!/usr/bin/env bash
# One-time provisioning for the staging site (staging.portal.nare.am) on the
# owner's server.
#
# The live layout (/opt/stack/docker-compose.yml, mirrored in
# deploy/portal/docker-compose.yml) runs the caddy and portal-app containers
# on a compose-managed Docker network whose real name depends on the compose
# project name, so it must be discovered from the running portal-app
# container — never hard-coded. This script:
#   1. creates the staging data layout under $PORTAL_STAGING_DIR,
#   2. discovers the production network and records it in the staging .env
#      (deploy/staging/docker-compose.yml joins it as an external network),
#   3. installs a managed staging block into the live Caddyfile, validating
#      the candidate inside the caddy container BEFORE it touches the live
#      path, then reloads caddy.
# It never rewrites the live compose file and never touches any host-level
# caddy path. Re-running is safe: the managed block is regenerated in place
# and the resulting Caddyfile is byte-identical.
set -euo pipefail

log() {
  printf '[provision] %s\n' "$*"
}

die() {
  printf '[provision] ERROR: %s\n' "$*" >&2
  exit 1
}

PORTAL_CADDY_CONTAINER="${PORTAL_CADDY_CONTAINER:-caddy}"
PORTAL_CADDYFILE="${PORTAL_CADDYFILE:-/opt/stack/Caddyfile}"
PORTAL_NETWORK="${PORTAL_NETWORK:-}"
PORTAL_APP_CONTAINER="${PORTAL_APP_CONTAINER:-portal-app}"
PORTAL_STAGING_DIR="${PORTAL_STAGING_DIR:-/opt/stack/staging}"

BEGIN_MARKER="# BEGIN staging.portal.nare.am (managed by provision-server.sh)"
END_MARKER="# END staging.portal.nare.am"

check_preconditions() {
  command -v docker >/dev/null 2>&1 \
    || die "docker CLI not found on PATH; run this on the server hosting the live stack"
  [ -f "$PORTAL_CADDYFILE" ] \
    || die "live Caddyfile not found: $PORTAL_CADDYFILE (set PORTAL_CADDYFILE to override)"
}

create_staging_dirs() {
  mkdir -p "$PORTAL_STAGING_DIR/data" "$PORTAL_STAGING_DIR/uploads" "$PORTAL_STAGING_DIR/auth"
  log "staging dirs ready under $PORTAL_STAGING_DIR"
}

discover_network() {
  if [ -n "$PORTAL_NETWORK" ]; then
    log "using preset network: $PORTAL_NETWORK"
    return
  fi
  local networks
  if ! networks="$(docker inspect --format '{{range $name, $conf := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$PORTAL_APP_CONTAINER")"; then
    die "could not inspect container '$PORTAL_APP_CONTAINER'; is the live stack running? (or set PORTAL_NETWORK explicitly)"
  fi
  PORTAL_NETWORK="$(printf '%s\n' "$networks" | awk 'NF { print; exit }')"
  [ -n "$PORTAL_NETWORK" ] \
    || die "container '$PORTAL_APP_CONTAINER' reported no attached networks; set PORTAL_NETWORK explicitly"
  log "discovered network from $PORTAL_APP_CONTAINER: $PORTAL_NETWORK"
}

write_staging_env() {
  local env_file="$PORTAL_STAGING_DIR/.env"
  touch "$env_file"
  if grep -q '^PORTAL_NETWORK=' "$env_file"; then
    sed -i "s|^PORTAL_NETWORK=.*|PORTAL_NETWORK=${PORTAL_NETWORK}|" "$env_file"
  else
    printf 'PORTAL_NETWORK=%s\n' "$PORTAL_NETWORK" >> "$env_file"
  fi
  chmod 600 "$env_file"
  log "recorded PORTAL_NETWORK in $env_file"
}

install_caddy_block() {
  local backup candidate
  backup="${PORTAL_CADDYFILE}.bak.$(date +%Y%m%dT%H%M%S)"
  cp -p "$PORTAL_CADDYFILE" "$backup"
  log "backup written: $backup"

  # Drop any previous managed block, then trailing blank lines, so a re-run
  # regenerates a byte-identical file instead of appending a second block.
  candidate="$(mktemp)"
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
  } > "$candidate"

  # Validate the candidate inside the caddy container without touching the
  # live path — an invalid file must never be installed.
  if ! docker exec -i "$PORTAL_CADDY_CONTAINER" sh -c 'cat > /tmp/Caddyfile.provision-candidate && caddy validate --config /tmp/Caddyfile.provision-candidate' < "$candidate"; then
    cp -p "$backup" "$PORTAL_CADDYFILE"
    rm -f "$candidate"
    die "candidate Caddyfile failed validation; live Caddyfile restored from backup ($backup)"
  fi

  cp "$candidate" "$PORTAL_CADDYFILE"
  rm -f "$candidate"
  log "staging block installed in $PORTAL_CADDYFILE"

  # The reload targets the container-internal config path (where the live
  # Caddyfile is mounted); only the caddy container ever sees it.
  if ! docker exec "$PORTAL_CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile; then
    cp -p "$backup" "$PORTAL_CADDYFILE"
    docker exec "$PORTAL_CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile || true
    die "caddy reload failed; restored the backup and reloaded the previous config"
  fi
  log "caddy reloaded"
}

print_summary() {
  log "provisioning complete"
  log "  network:      $PORTAL_NETWORK"
  log "  staging .env: $PORTAL_STAGING_DIR/.env"
  log "next steps: start the staging project with PORTAL_NETWORK set, e.g."
  log "  PORTAL_NETWORK=$PORTAL_NETWORK docker compose -f deploy/staging/docker-compose.yml up -d"
}

main() {
  check_preconditions
  create_staging_dirs
  discover_network
  write_staging_env
  install_caddy_block
  print_summary
}

main "$@"
