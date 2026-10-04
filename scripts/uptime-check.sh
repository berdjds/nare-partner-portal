#!/usr/bin/env bash
#
# Production uptime check for portal.nare.am. Read-only: only anonymous GET
# requests. Unlike the post-deploy smoke test it checks RENDERED content, not
# only status codes, because a page can answer 200 and still be broken (the
# application page once shipped a fail-closed notice baked in at build time).
#
# Usage:
#   uptime-check.sh <base-url>
#
# Checks (one PASS/FAIL line each; each request is retried twice, 5 s apart,
# so a single network blip does not raise an alarm):
#   1. GET /                 200 and mentions the product name (landing renders)
#   2. GET /login            200 with the sign-in title, and the page's JavaScript
#                            assets load (the form itself renders in the browser,
#                            so a broken or missing asset is what breaks sign-in)
#   3. GET /partners/apply   200 and contains the signed form token field
#                            (the page is rendered per request, not fail-closed)
#   4. GET /terms, /privacy  200 (public legal pages)
#   5. GET /api/chats        401 anonymously (the access gate holds)
#   6. TLS certificate       valid for at least 14 more days
#   7. Each page answers within 8 seconds
#
# Exit status: 0 when every check passed, 1 otherwise. A summary line is
# always printed last. Dependencies: curl, openssl, date.

set -uo pipefail

[ "$#" -eq 1 ] || { printf 'Usage: %s <base-url>\n' "$(basename "$0")" >&2; exit 2; }
BASE="${1%/}"
case "$BASE" in https://*) ;; *) printf 'ERROR: base URL must start with https://\n' >&2; exit 2 ;; esac
HOST="$(printf '%s' "$BASE" | sed -E 's#^https://([^/:]+).*#\1#')"

MAX_TIME=8
fails=0
passes=0
body="$(mktemp)"
trap 'rm -f "$body"' EXIT

ok() { passes=$((passes + 1)); printf 'PASS %s\n' "$1"; }
bad() { fails=$((fails + 1)); printf 'FAIL %s (%s)\n' "$1" "$2"; }

# fetch <path> -> sets CODE and TIME, leaves the body in $body; retries twice.
fetch() {
  local attempt out
  for attempt in 1 2 3; do
    out="$(curl -sS --noproxy '*' --max-time "$MAX_TIME" -o "$body" -w '%{http_code} %{time_total}' "$BASE$1" 2>/dev/null)" || out="000 0"
    CODE="${out%% *}"
    TIME="${out##* }"
    [ "$CODE" != "000" ] && [ "${CODE:0:1}" != "5" ] && return 0
    [ "$attempt" -lt 3 ] && sleep 5
  done
  return 0
}

check_page() { # path, expected-code, needle-or-empty, label
  fetch "$1"
  if [ "$CODE" != "$2" ]; then bad "$4" "GET $1 returned $CODE, expected $2"; return; fi
  if [ -n "$3" ] && ! grep -q -F -- "$3" "$body"; then bad "$4" "GET $1 answered $CODE but the page does not contain the expected content"; return; fi
  ok "$4"
  if awk -v t="$TIME" 'BEGIN { exit !(t > 8) }'; then bad "$4 (speed)" "GET $1 took ${TIME}s"; fi
}

check_page "/" 200 "Nare Travel and Tours" "landing page renders"
check_page "/login" 200 "Sign in" "sign-in page answers"
# The sign-in form is a client component: verify the scripts the page references are served.
assets="$(grep -o -E '/_next/static/[^"]+\.js' "$body" | sort -u | head -4)"
if [ -z "$assets" ]; then
  bad "sign-in assets" "no script assets referenced by /login"
else
  asset_fail=0
  for a in $assets; do
    code="$(curl -sS --noproxy '*' --max-time "$MAX_TIME" -o /dev/null -w '%{http_code}' "$BASE$a" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] || { asset_fail=1; bad "sign-in assets" "$a returned $code"; }
  done
  [ "$asset_fail" -eq 0 ] && ok "sign-in page scripts load"
fi
check_page "/partners/apply" 200 'name="formToken"' "application page renders with its form token"
check_page "/terms" 200 "" "terms page"
check_page "/privacy" 200 "" "privacy page"
check_page "/api/chats" 401 "" "access gate holds (anonymous API refused)"

end="$(printf '' | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')"
if [ -z "$end" ]; then
  bad "TLS certificate" "could not read the certificate of $HOST"
else
  days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  if [ "$days" -ge 14 ]; then ok "TLS certificate valid for $days more days"; else bad "TLS certificate" "expires in $days days"; fi
fi

printf 'SUMMARY %s passed, %s failed\n' "$passes" "$fails"
[ "$fails" -eq 0 ]
