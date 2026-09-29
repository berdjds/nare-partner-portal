#!/usr/bin/env bash
set -euo pipefail

# Ensure the Prisma schema is applied to the SQLite database before starting.
# A schema change that would destroy existing rows must abort loudly — never
# tell the push to accept data loss (the deploy gate's trials rely on this
# failing rather than silently dropping data).
npm run db:push --

# Clear Chromium session locks from any previous container so the browser can start.
find /app/.wwebjs_auth -type f \( -name "SingletonLock" -o -name "SingletonSocket" -o -name "SingletonCookie" \) -delete 2>/dev/null || true
find /app/.wwebjs_auth -type l -name "SingletonLock" -delete 2>/dev/null || true

# Patch whatsapp-web.js injected getChats() so one unserializable chat model
# doesn't reject the whole evaluation (upstream "r: r" breakage).
node scripts/patch-wwebjs.js || true

exec "$@"
