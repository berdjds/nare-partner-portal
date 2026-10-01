#!/usr/bin/env bash
# Test double for the curl CLI, used by tests/deploy/vps-deploy.test.ts for
# the post-cutover public health check ($PORTAL_PUBLIC_URL/login). Every
# invocation is appended to $STUB_CURL_LOG (one line, space-joined args);
# behavior is driven by STUB_CURL_* environment variables:
#   STUB_CURL_LOG=<path>   required; invocation log file
#   STUB_CURL_FAIL=1       curl exits 1 (the public URL is not serving)
# No `set -e` here on purpose, mirroring docker-stub.sh.

printf '%s\n' "$*" >> "${STUB_CURL_LOG:?STUB_CURL_LOG is required}"

if [ -n "${STUB_CURL_FAIL:-}" ]; then
  exit 1
fi
exit 0
