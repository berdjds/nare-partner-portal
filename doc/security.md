# Security

## Known Risks

### Dependency advisory register (W1, updated 2026-09-29)

W1 moved the smallest set of dependencies that removes every critical/high
advisory reachable in this deployment. Entries are grounded in the installed
dependency tree (`package-lock.json`) and in how each package is actually
used in this codebase. Re-run `npm audit` after any dependency change.

**Resolved in W1 (target phase reached):**

- **`next` 14.0.4 → 15.5.26** — middleware authorization bypass via the
  `x-middleware-subrequest` header
  ([CVE-2025-29927](https://github.com/advisories/GHSA-f82v-jwr5-mffw)) and
  the 2024 critical batch on the 14.x line, incl. Server-Actions SSRF
  ([CVE-2024-34351](https://github.com/advisories/GHSA-fr5h-rqp8-mj6g)) and
  cache poisoning
  ([CVE-2024-46982](https://github.com/advisories/GHSA-gp8f-8m3g-qvj9)).
  Fully reachable pre-fix (the app serves sessions and API routes through
  Next.js); fixed by the upgrade.
- **`@auth/core` / `@auth/prisma-adapter`** — the critical Auth.js v5-line
  advisories this stack used to pull. `@auth/prisma-adapter` is no longer a
  dependency and the app authenticates with next-auth v4 (credentials + JWT),
  which never loads `@auth/core`. The `0.34.3` copy still in the tree exists
  only as next-auth's optional peer (never imported) and is the sole reason a
  stale top-level `cookie@0.6.0` copy remains.
- **`sharp` <0.35.0 (bundled libvips CVEs)** — the optional dependency now
  resolves to `0.35.5`, and the image optimizer is never exercised anyway:
  `images.unoptimized: true` in `next.config.js` and no `next/image` usage.
- **`puppeteer` → `ws`** — DoS via excessive HTTP headers
  ([CVE-2024-37890](https://github.com/advisories/GHSA-3h5v-q93c-6p6p), fixed
  ≥8.17.1). `ws` is pinned by the `overrides` block to `^8.21.3` (installed
  `8.22.0`); the reachable surface (the Socket.io server) is patched.
- **`postcss` (via `next`)** — line-return parsing error
  ([CVE-2023-44270](https://www.cve.org/CVERecord?id=CVE-2023-44270), fixed
  ≥8.4.31). Now a direct devDependency at `8.5.28` plus an
  `overrides.next.postcss` pin; build-time only.
- **`cookie` <0.7.0** — out-of-bounds cookie characters
  ([CVE-2024-47764](https://github.com/advisories/GHSA-pxg6-pf52-xh8x), fixed
  0.7.0). The copies the app actually loads (next-auth, engine.io) are
  `0.7.2`; the only `0.6.0` copy belongs to the unused `@auth/core` peer
  above.
- **`axios` (declared `^1.6.3`, installed `1.19.0`)** — SSRF via spoofed
  `X-Forwarded-For`
  ([CVE-2024-39338](https://github.com/advisories/GHSA-8hc4-vh64-cxmj)) and
  absolute-URL base/proxy bypass
  ([CVE-2025-27152](https://github.com/advisories/GHSA-jr5f-v2jv-69x4)). Both
  are server-side impact classes; axios is only imported by client components
  in this repo, and the installed tree is patched anyway.

**Present but not reachable (accepted for W1):**

- **`puppeteer` → `tar-fs` 3.0.4 (installed)** — both tar-fs advisories are
  still in the tree: tar-extraction path traversal
  ([CVE-2025-48387](https://www.cve.org/CVERecord?id=CVE-2025-48387), fixed
  in tar-fs 3.0.9; 2.1.3 / 1.16.5 on the older lines) and symlink-following
  arbitrary file overwrite
  ([CVE-2024-12905](https://www.cve.org/CVERecord?id=CVE-2024-12905), fixed
  in tar-fs 3.0.7). Both live in tar-fs's extraction path, which only runs
  when `@puppeteer/browsers` downloads a browser — this deployment never
  does: Docker sets `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` with the system
  Chromium (`Dockerfile:4`), CI skips the download
  (`.github/workflows/ci-cd.yml:20`), and the travel PDF renderer only
  launches an executable (`lib/travel/pdf/render.ts:29`). Removal target:
  W2 dependency pass.

**Carried forward:** keep `npm audit` clean whenever dependencies are
touched (ongoing, next dependency-changing phase). The residual `@auth/core`
optional peer and its `cookie@0.6.0` artifact disappear when next-auth is
next upgraded or the peer is dropped — target: W2 dependency pass.

### Credentials and Secrets

- Change `NEXTAUTH_SECRET` to a strong random value.
- Change the seeded `ADMIN_PASSWORD` before deployment.
- Do not commit `.env` or `.wwebjs_auth/`.

### WhatsApp Session

The `.wwebjs_auth/` directory contains the authenticated WhatsApp session. Anyone with access to it can impersonate the linked WhatsApp account. Protect it with filesystem permissions and backups.

### CORS / Socket origins

The Socket.io server (`/api/socket`) no longer answers cross-origin requests: the
`allowRequest` hook in `lib/socket-auth.ts` accepts a handshake only when its
`Origin` header exactly matches the origin of `NEXTAUTH_URL` (plus the optional
comma-separated `SOCKET_ALLOWED_ORIGINS`, for local development). There is no
`Access-Control-Allow-Origin: *` response header (the `/api/socket` headers in
`next.config.js` were removed) and a missing `Origin` header is refused too.
On top of the origin gate, every handshake authenticates the NextAuth session
cookie and only ACTIVE `ADMIN`/`USER` sockets connect — see "Interim access
policy" below.

### Input Validation

- API routes use Zod schemas for incoming request bodies.
- File uploads (media messages) are saved with random UUID filenames but should be validated for size and type before deployment.
- Uploaded media is served from `/uploads/` under `public/uploads/`. Since W1 these URLs are authenticated by the custom server (see "Interim access policy" below); before W1 they were publicly reachable.

### Rate Limiting

There is no built-in rate limiting on API routes or the WhatsApp send endpoint. Add rate limiting (e.g., with `rate-limiter-flexible` or a reverse proxy) before public deployment.

### HTTPS

Always serve the application over HTTPS in production. Set `NEXTAUTH_URL` to the HTTPS URL.

### Admin Access

Any user with `ADMIN` role can manage users and the WhatsApp session. Ensure admin accounts are protected with strong passwords and ideally multi-factor authentication if extended.

### Travel module: validation and documents

Since v0.10.0, any active user can be assigned as a travel-request validator, and a validator
may approve their own submission (self-validation is a deliberate small-team mode — the former
SELF_APPROVAL / SELF_ASSIGNMENT blocks were removed by design, not by accident). The control
that remains is the assignment itself: only the currently assigned validator can review, and
users without a travel role only see requests they own or actively validate. INTERNAL quotation
documents (which contain margins) stay restricted: downloads require ADMIN/VALIDATOR role, and
WhatsApp delivery of INTERNAL documents is limited to ADMIN/VALIDATOR users or the assigned
validator.

Since v0.11.0 the travel-request owner sees per-line net costs and full engine results
(`scenarios[].lines`, nightly stay costs) — an operator decision, since the owner runs the
costing. Non-owner advisors are unchanged: they are 404'd from other people's requests and
would see only sell-side fields if redaction ever applied. INTERNAL PDFs remain invisible to
advisors (including owners).

## Interim access policy (until W2)

Implemented in `lib/access-policy.ts` and applied across pages, APIs and media serving.
Documented here as the interim policy; W2 is expected to grant inbox access per user.

**Roles.**

- `canUseInbox(role)`: **ADMIN** or **USER** — may open the WhatsApp chat inbox.
- `canAdministerWhatsApp(role)`: **ADMIN** — full WhatsApp status details and reconnect/logout.
- **ADVISOR** and **VALIDATOR** are travel-only until W2.

**Trust boundary.** Every gate reloads the user from the database on each request: the user
must exist and be active, and the *current* database role decides. The role stored in the JWT
at login is never consulted, so a deactivation or role change takes effect on the next
request, with the same unexpired session token. A deactivated or deleted user gets **401**
(their credential is revoked, not merely under-privileged).

**Pages** (`app/page.tsx`, `app/dashboard/page.tsx`): ADVISOR/VALIDATOR are redirected to
`/travel`; the dashboard additionally requires an inbox role (non-inbox roles → `/travel`,
unknown/inactive sessions → `/login`). ADMIN continues to `/admin`, USER to `/dashboard`.

**Chat APIs** (`/api/chats`, `/api/messages`, `/api/send`): **401** without a session and for
deactivated users; **403** for active ADVISOR/VALIDATOR; ADMIN/USER proceed.

**WhatsApp status** (`/api/whatsapp/status`): GET returns full details (`state`, `info`,
pairing `qrSvg`, `version`, `startedAt`) to ADMIN only; USER receives only
`{ "connected": boolean }` (availability as connected/not connected); other roles get 403.
POST (reconnect/logout) stays ADMIN-only. The dashboard badge shows the raw connection state
to admins and only connected/not connected to other inbox users.

**Media** (`/uploads/*`, served by `lib/uploads.ts` mounted in `server.ts` before the Next.js
handler): the pathname is percent-decoded, slash-collapsed and normalized before matching
(`routeUploadsRequest`), so encoded spellings of `/uploads` (`/%75ploads/…`, `/uploads%2F…`,
`//uploads/…`) are intercepted too instead of being served unsigned by Next's decoded
public/ lookup; undecodable URLs get **400** and non-GET/HEAD methods **405**. The gate
itself requires a valid, unexpired NextAuth session cookie (`next-auth/jwt` decode with
`NEXTAUTH_SECRET`), an active inbox-role user from the database, and a normalized path inside
`public/uploads/`. Responses stream the file with its mime type and
`Cache-Control: private, no-store`. Otherwise: **401** (no/invalid/expired/revoked session),
**403** (active non-inbox role), **404** (traversal or missing file). Existing and missing
files are indistinguishable to unauthorized callers — file existence is never leaked.

**Sockets** (`/api/socket`, wired in `server.ts` + `lib/socket-auth.ts` via
`setSocketServer()`): the origin gate (`allowRequest`) runs before the Socket.io
handshake, then an `io.use` middleware decodes the NextAuth session cookie
(`next-auth/jwt` with `NEXTAUTH_SECRET`) and refuses anything missing, forged or
expired, exactly like the media gate. The user is then loaded from the database
and must be active with an inbox role — anonymous, ADVISOR/VALIDATOR and
deactivated sessions get the `unauthorized` connect_error and never connect.
The SERVER places sockets in rooms (inbox users → `inbox`, ADMIN additionally →
`admins`); no client-to-server handlers exist and anything a client emits is
ignored and logged (`socket.onAny`). Emits are room-scoped: `message` and
`chat_update` go to `inbox` only; availability `{ connected: boolean }` goes to
`inbox` only; the full `whatsapp_state` (including `info` and the pairing
`qrSvg`) goes to `admins` only, including on connection. Two revalidation
mechanisms run while a socket is open: it is disconnected when its token's `exp`
passes, and every 60s the user row is reloaded — deactivation or a role change
disconnects the socket (and room membership is re-synced with the current role),
so logout, expiry, deactivation or demotion all cut the socket promptly. The
client (`hooks/useSocket.ts`) stops reconnecting after an `unauthorized`
connect_error and disconnects on sign-out.

**Known limit carried to W2.** A JWT copied before logout stays valid until it
expires (NextAuth default 30 days) — the 60s revalidation only helps while the
user row is deactivated or demoted. Per-session revocation arrives with W2.

**Rate limiting and media validation.** Still open (see below).

## Security Checklist Before Production

- [ ] Upgrade all dependencies and resolve `npm audit` findings.
- [ ] Generate strong `NEXTAUTH_SECRET` and `ADMIN_PASSWORD`.
- [ ] Serve over HTTPS with a valid certificate.
- [x] Restrict CORS/socket origins (W1: exact-origin allow-list via `allowRequest` in `lib/socket-auth.ts` — see "Interim access policy").
- [x] Authenticate and room-scope Socket.io (W1: session-cookie handshake, server-managed `inbox`/`admins` rooms, 60s + token-expiry revalidation — see "Interim access policy").
- [ ] Add rate limiting and input size limits.
- [x] Protect `/uploads/` (W1: authenticated streaming via the custom server — see "Interim access policy"; media stays under `public/uploads/`).
- [ ] Back up `.wwebjs_auth/` securely.
- [ ] Review Puppeteer sandbox settings for your hosting environment.
