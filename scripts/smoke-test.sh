#!/usr/bin/env bash
#
# Post-deploy smoke test for portal.nare.am (W3b, task smoke-test). Verifies
# that a freshly deployed portal is serving and that its anonymous-access
# gates hold. Runs from CI (deploy gate, after the public health check) or
# from any operator machine; the only dependency is curl. One-time
# provisioning installs the same script on the server as
# /usr/local/lib/portal-deploy/portal-smoke; this repo copy is the source of
# truth and the pipeline can only call the installed copy, not change it.
#
# Usage:
#   smoke-test.sh <base-url>
#
#   <base-url>  e.g. https://portal.nare.am or https://staging.portal.nare.am
#
# Checks (one PASS/FAIL line each):
#   1. GET /login returns 200 (the app is up).
#   2. GET /api/whatsapp/status returns 401 anonymously.
#   3. GET /api/chats returns 401 anonymously.
#   4. GET /api/permissions returns 401 anonymously.
#   5. GET /api/users returns 401 anonymously.
#   6. GET /uploads/x.jpg returns 401 anonymously (media is not public).
#   7. Socket.io handshake with a foreign Origin is refused with 403 before
#      the handshake runs (engine.io allowRequest gate, lib/socket-auth.ts).
#   8. Socket.io handshake with the site's own Origin but no session cookie
#      opens at the engine.io level (HTTP 200) but the Socket.io namespace
#      connect is refused with the connect error "unauthorized".
#
# The Origin header for checks 7/8 is derived from <base-url> (scheme +
# authority). Every failed check prints a FAIL line with the observed
# response; at the end the script prints a summary and exits non-zero if any
# check failed.
#
# SMOKE_CURL_MAX_TIME overrides the per-request curl timeout in seconds
# (default 15).

set -euo pipefail

usage() {
  printf 'Usage: %s <base-url>\n' "$(basename "$0")" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage

BASE_URL="${1%/}"
case "$BASE_URL" in
  http://* | https://*) ;;
  *)
    printf 'ERROR: base URL must start with http:// or https://\n' >&2
    usage
    ;;
esac

# The socket origin gate compares origins exactly, so derive scheme +
# authority (no path, no trailing slash) from the base URL.
ORIGIN="$(printf '%s' "$BASE_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"

CURL_MAX_TIME="${SMOKE_CURL_MAX_TIME:-15}"
SOCKET_PATH="$BASE_URL/api/socket/"
FOREIGN_ORIGIN="https://foreign.example.invalid"

pass_count=0
fail_count=0
failed_checks=()

report_pass() {
  pass_count=$((pass_count + 1))
  printf 'PASS %s\n' "$1"
}

report_fail() {
  fail_count=$((fail_count + 1))
  failed_checks+=("$1")
  printf 'FAIL %s (%s)\n' "$1" "$2"
}

# http_code <curl-args...> prints the response status code, or 000 on a
# transport error. Never returns non-zero (set -e safe).
# --noproxy '*' keeps the checks deterministic: a proxy configured in the
# caller's environment must not intercept (or hang) requests to the portal.
http_code() {
  local code
  code="$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time "$CURL_MAX_TIME" "$@" 2>/dev/null)" || code="000"
  printf '%s' "$code"
}

# check_status <name> <expected-code> <curl-args...>
check_status() {
  local name="$1" expected="$2"
  shift 2
  local code
  code="$(http_code "$@")"
  if [ "$code" = "$expected" ]; then
    report_pass "$name"
  else
    report_fail "$name" "expected HTTP $expected, got HTTP $code"
  fi
}

check_status "GET /login returns 200" 200 "$BASE_URL/login"
check_status "GET /api/whatsapp/status requires auth" 401 "$BASE_URL/api/whatsapp/status"
check_status "GET /api/chats requires auth" 401 "$BASE_URL/api/chats"
check_status "GET /api/permissions requires auth" 401 "$BASE_URL/api/permissions"
check_status "GET /api/users requires auth" 401 "$BASE_URL/api/users"
check_status "GET /uploads/x.jpg requires auth" 401 "$BASE_URL/uploads/x.jpg"

# A foreign Origin is rejected by the engine.io allowRequest gate with 403
# before any Socket.io handshake runs.
check_status "socket handshake with foreign Origin returns 403" 403 \
  -H "Origin: $FOREIGN_ORIGIN" \
  "$SOCKET_PATH?EIO=4&transport=polling"

# The site's own Origin without a session cookie: engine.io opens the
# connection (handshake with a sid), then the Socket.io namespace connect is
# refused by the auth middleware; the refusal is delivered as a connect-error
# packet ({"message":"unauthorized"}) on the next poll.
check_socket_unauthorized() {
  local name="socket connect without cookie is refused (unauthorized)"
  local handshake sid reply
  handshake="$(curl -sS --noproxy '*' --max-time "$CURL_MAX_TIME" -H "Origin: $ORIGIN" \
    "$SOCKET_PATH?EIO=4&transport=polling" 2>/dev/null)" || {
    report_fail "$name" "handshake request failed"
    return 0
  }
  sid="$(printf '%s' "$handshake" | sed -n 's/^0{"sid":"\([^"]*\)".*/\1/p')"
  if [ -z "$sid" ]; then
    report_fail "$name" "no engine.io handshake (got: ${handshake:0:80})"
    return 0
  fi
  # Namespace connect packet; engine.io answers the POST itself with "ok".
  curl -sS --noproxy '*' -o /dev/null --max-time "$CURL_MAX_TIME" -X POST \
    -H "Origin: $ORIGIN" -H "Content-Type: text/plain;charset=UTF-8" \
    --data-binary '40' \
    "$SOCKET_PATH?EIO=4&transport=polling&sid=$sid" 2>/dev/null || true
  reply="$(curl -sS --noproxy '*' --max-time "$CURL_MAX_TIME" -H "Origin: $ORIGIN" \
    "$SOCKET_PATH?EIO=4&transport=polling&sid=$sid" 2>/dev/null)" || reply=""
  if printf '%s' "$reply" | grep -q '"unauthorized"'; then
    report_pass "$name"
  else
    report_fail "$name" "expected connect error unauthorized (got: ${reply:0:80})"
  fi
}

check_socket_unauthorized

printf '\nSmoke test for %s: %d passed, %d failed\n' "$BASE_URL" "$pass_count" "$fail_count"
if [ "$fail_count" -gt 0 ]; then
  printf 'Failed checks:\n'
  printf '  - %s\n' "${failed_checks[@]}"
  exit 1
fi

exit 0
