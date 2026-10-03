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
cookie and only active users holding at least one socket-eligible permission
connect (W3: any WhatsApp account's view or admin permission —
`whatsapp.inbox.view`, `whatsapp.nare.view`, `whatsapp.admin`,
`whatsapp.nare.admin`) — see "Access policy and permission model" below.

### Input Validation

- API routes use Zod schemas for incoming request bodies.
- File uploads (media messages) are saved with random UUID filenames but should be validated for size and type before deployment.
- Uploaded media is served from `/uploads/` under `public/uploads/`. Since W1 these URLs are authenticated by the custom server (see "Access policy and permission model" below); before W1 they were publicly reachable.

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
documents (which contain margins) stay restricted under W2: downloading one requires the
`travel.internal.download` permission — preset for ADMIN only until the owner confirms the
permissions migration (D3), so non-admins need an explicit grant, which stays locked (403)
until that confirmation — plus the pre-W2 record rule (ADMIN/VALIDATOR role, or the currently
assigned validator of the request). WhatsApp delivery of INTERNAL documents is refused for
every actor including ADMIN: the send route answers 403 and `sendQuoteDocument()` refuses them
too (audited `QUOTE_DOCUMENT_SEND_REFUSED`), so no code path can bypass the refusal. Internal
costs and margins are redacted from request/calculate responses and INTERNAL documents are
filtered from lists unless the actor holds `travel.internal.view`; client PDFs and
client-facing responses contain no internal costs, margins, or internal notes.

Note: enforcement happens at access time, not after delivery — once a user legitimately
downloads a file (a client PDF or an internal costing sheet), the server cannot prevent them
from sharing it onward.

Since v0.11.0 the travel-request owner sees per-line net costs and full engine results
(`scenarios[].lines`, nightly stay costs) — an operator decision, since the owner runs the
costing. Under W2 that visibility is additionally permission-gated: full engine results and
internal costing leave the APIs only for actors holding `travel.internal.view`, which is preset
for ADMIN only until the migration confirmation (D2) — so owners and validators see the
redacted sell-side view unless explicitly granted the key. Non-owner advisors are unchanged:
they are 404'd from other people's requests. INTERNAL PDFs remain invisible to
advisors (including owners) by default: no non-admin preset holds the internal keys (D2), so
they stay out of reach until an admin grants `travel.internal.download`/`travel.internal.view`
— which itself is locked until the migration report is confirmed.

## Access policy and permission model (W2)

Implemented in `lib/access-policy.ts` and applied across pages, APIs and media serving.
The inbox surfaces (dashboard page, chat APIs, media, sockets, WhatsApp status) are
permission-gated since W2 perm-inbox; W2 perm-travel and perm-admin extend the same keys
to the travel and user-management surfaces (detailed below). The role predicates below
remain only for the role-based redirects and record-level rules.

**Roles.**

- `canUseInbox(role)`: **ADMIN** or **USER** — the role-preset equivalent of the
  `whatsapp.inbox.*` keys; still used by the `/` redirect.
- `canAdministerWhatsApp(role)`: **ADMIN** — the role-preset equivalent of
  `whatsapp.admin`.
- **ADVISOR** and **VALIDATOR** presets hold no inbox keys.

**Trust boundary.** Every gate reloads the user from the database on each request: the user
must exist and be active, and the *current* database role and permission overrides decide.
The role stored in the JWT at login is never consulted, so a deactivation, role change or
override edit takes effect on the next request, with the same unexpired session token. A
deactivated or deleted user gets **401** (their credential is revoked, not merely
under-privileged).

**Pages** (`app/page.tsx`, `app/dashboard/page.tsx`): ADVISOR/VALIDATOR are redirected to
`/travel`; the dashboard requires the view permission of at least one WhatsApp account
(W3: `whatsapp.inbox.view` for marhaba, `whatsapp.nare.view` for nare — without any →
`/travel`, unknown/inactive sessions → `/login`) and shows an account switcher limited to
the accounts the user may view. ADMIN continues to `/admin`, USER to `/dashboard`.
Signed-out visitors of `/` (no session, or an unknown/inactive/revoked user row) get the
public landing page (W5a) instead of a `/login` redirect. The
dashboard hides the composer, attachment and new-message controls when the selected
account's send permission is missing; the admin page's accounts tab shows only the accounts
the caller may administer (the `/api/whatsapp/accounts` API answers 401 when there are
none), withholding their states, QR and actions.

**Chat APIs** (`/api/chats`, `/api/messages`, `/api/send`): **401** without a session and for
deactivated users; **403** for active users without the permission. Every request selects the
WhatsApp account with `?account=` (query for chats/messages) or `account` (body for send),
defaulting to `marhaba` — the pre-W3 behavior for existing callers. Reading (chats, messages)
requires the account's view permission (`whatsapp.inbox.view` for marhaba,
`whatsapp.nare.view` for nare); sending requires its send permission (`whatsapp.inbox.send` /
`whatsapp.nare.send`) — view and send are separate keys per account.

**WhatsApp status** (`/api/whatsapp/status`): the account is selected with `?account=` (GET) or
body `account` (POST), defaulting to `marhaba`; unknown account keys get **400**. GET returns
full details (`state`, `info`, pairing `qrSvg`, `version`, `startedAt`) to holders of the
account's admin permission (`whatsapp.admin` for marhaba, `whatsapp.nare.admin` for nare);
holders of the account's view permission receive only `{ "connected": boolean }` (availability
as connected/not connected); everyone else gets 403. POST (reconnect/logout) requires the
account's admin permission and answers **401** to everyone without it, logged in or not (the
pre-W1 contract). The dashboard badge shows the raw connection state to admin-permission
holders and only connected/not connected to other inbox users.

**WhatsApp accounts admin API** (`/api/whatsapp/accounts`, W3): GET lists the accounts with
their runtime state and pairing QR, filtered to the accounts the caller administrates — a
caller with no account admin permission gets **401**. POST performs the per-account actions
`configure` (display name, public number, enabled), `connect`, `reconnect` and `disconnect`,
each gated by the target account's admin permission (`whatsapp.admin` / `whatsapp.nare.admin`).

**Travel WhatsApp routing (W3, R3).** Every WhatsApp send from the travel module — client
document PDFs via `lib/travel/whatsapp-docs.ts` and workflow notifications via
`lib/travel/notifications.ts` — resolves the account from `TravelSettings.whatsappAccountKey`
(default `nare`), with deliberately **no silent fallback to marhaba**: a disabled account fails
with WorkflowError `TRAVEL_WHATSAPP_ACCOUNT_DISABLED` (503), a missing account row with
`TRAVEL_WHATSAPP_ACCOUNT_NOT_CONFIGURED`, and a not-ready client with a send error naming the
account. The failed `NotificationDelivery` stays retryable and retries go to the SAME account:
the account id is stamped on the row at queue time and is part of the dedup key
(`<accountId>:<eventId>:<recipientId>:<channel>`), so a retry can neither duplicate the
delivery nor switch accounts. This send path is a system path gated by the
`travel.client_docs.send` permission, not by the inbox/nare send keys — so a travel-only user
can deliver client documents without any WhatsApp inbox permission.

**Media** (`/uploads/*`, served by `lib/uploads.ts` mounted in `server.ts` before the Next.js
handler): the pathname is percent-decoded, slash-collapsed and normalized before matching
(`routeUploadsRequest`), so encoded spellings of `/uploads` (`/%75ploads/…`, `/uploads%2F…`,
`//uploads/…`) are intercepted too instead of being served unsigned by Next's decoded
public/ lookup; undecodable URLs get **400** and non-GET/HEAD methods **405**. The gate
itself requires a valid, unexpired NextAuth session cookie (`next-auth/jwt` decode with
`NEXTAUTH_SECRET`), an active user from the database holding the media's account view
permission (W3), and a normalized path inside `public/uploads/`. Media is per account:
files under `/uploads/<accountKey>/` (e.g. `/uploads/nare/…`) require that account's view
key (`whatsapp.nare.view`), flat paths are marhaba's legacy layout (`whatsapp.inbox.view`).
The account is derived from the same decoded, normalized path that is streamed, so the
permission decision and the served file always agree (`/uploads/nare/../x.txt` normalizes
to marhaba's `x.txt`, not a nare file) — a marhaba-only user cannot stream nare media and
vice versa. Responses stream the file with its mime type and
`Cache-Control: private, no-store`. Otherwise: **401** (no/invalid/expired/revoked session),
**403** (active user without the permission), **404** (traversal or missing file). Existing
and missing files are indistinguishable to unauthorized callers — file existence is never
leaked.

**Sockets** (`/api/socket`, wired in `server.ts` + `lib/socket-auth.ts` via
`setSocketServer()`): the origin gate (`allowRequest`) runs before the Socket.io
handshake, then an `io.use` middleware decodes the NextAuth session cookie
(`next-auth/jwt` with `NEXTAUTH_SECRET`) and refuses anything missing, forged or
expired, exactly like the media gate. The user is then loaded from the database
and must be active and hold at least one socket-eligible permission — W3:
ANY account's view or admin permission (`whatsapp.inbox.view`,
`whatsapp.nare.view`, `whatsapp.admin`, `whatsapp.nare.admin`) — anonymous,
travel-only and deactivated sessions get the `unauthorized` connect_error and
never connect. Rooms are per WhatsApp account (W3): `inbox:<accountKey>` and
`admins:<accountKey>` (helpers `inboxRoom`/`adminsRoom`; the legacy
`INBOX_ROOM`/`ADMINS_ROOM` constants equal the marhaba rooms). The SERVER
places sockets in rooms by current effective permission per account
(`whatsapp.inbox.view` → `inbox:marhaba`, `whatsapp.nare.view` → `inbox:nare`,
`whatsapp.admin` → `admins:marhaba`, `whatsapp.nare.admin` → `admins:nare`); no
client-to-server handlers exist and anything a client emits is
ignored and logged (`socket.onAny`). Emits are room- and account-scoped:
`message` and `chat_update` go to the account's `inbox:<key>` room only, with
`accountKey` in the payload; availability `{ accountKey, connected }` goes to
`inbox:<key>` only; the full `whatsapp_state` (including `info` and the
pairing `qrSvg`) goes to that account's `admins:<key>` room only, including on
connection — so an account's pairing QR never leaves its own admins room. Two revalidation
mechanisms run while a socket is open: it is disconnected when its token's `exp`
passes, and every 60s the user row is reloaded — deactivation, session revocation
or losing every socket-eligible permission disconnects the socket, and room
membership is re-synced with the current effective permissions (a grant or deny
takes effect within one interval, without a reconnect). The
client (`hooks/useSocket.ts`) stops reconnecting after an `unauthorized`
connect_error and disconnects on sign-out.

**Session revocation (W1b; RB1 closed).** Every token minted at login carries the
user's session version (`sv`); each HTTP request, upload request and socket
(re)validation re-reads the user row and refuses tokens whose `sv` no longer
matches. Changing a user's password or role, deactivating them (`active=false`),
the admin **Revoke sessions** action (`POST /api/users/[id]/revoke-sessions`,
ADMIN only — 403 for other roles, audit action `SESSIONS_REVOKED`) and the user's
own **Sign out everywhere** (`POST /api/auth/sign-out-everywhere`, audit action
`SIGN_OUT_EVERYWHERE`) all bump `User.sessionVersion` atomically, so every
previously issued token is useless on its next request. Session maxAge is capped
at 7 days. Remaining limits: revocation applies on the NEXT request (nothing
reaches into an in-flight one); open sockets disconnect on the next 60s
revalidation pass, not instantly; tokens minted before W1b carry no `sv` claim
and keep working until the user's FIRST version bump — a missing `sv` reads as
version 0, and the first bump revokes those legacy tokens too. W2 did not add
per-device tokens: revocation is always all-sessions-of-a-user.

**Permission model (W2 core).** `lib/permissions.ts` defines the closed set of
permission keys (`admin.users`, `admin.settings`, `whatsapp.inbox.view`,
`whatsapp.inbox.send`, `whatsapp.admin`, `whatsapp.nare.view`,
`whatsapp.nare.send`, `whatsapp.nare.admin`, `travel.access`, `travel.create`,
`travel.review`, `travel.issue`, `travel.client_docs.download`,
`travel.client_docs.send`, `travel.internal.view`, `travel.internal.download`,
`partners.review`),
a default preset per role and the effective-permission resolution: **(role
preset ∪ grants) − denies** — deny has the highest precedence, a grant adds a
key the preset lacks. Presets reproduce the interim role policy exactly, with
two decided exceptions: (D2) the internal keys (`travel.internal.view`,
`travel.internal.download`) are preset for ADMIN only, so non-admins have no
internal-cost access until the owner confirms the proposed-permissions
migration (D3); and (W3) the Nare triple (`whatsapp.nare.view`,
`whatsapp.nare.send`, `whatsapp.nare.admin`) is likewise preset for ADMIN only
— no other role preset opts in, so other users reach the Nare account only
through per-user overrides. `ACCOUNT_PERMISSIONS` maps each account key
(`marhaba`, `nare`) to its view/send/admin triple. The W5b partner-enrollment
key `partners.review` (the B2B partner application queue and KYC document
download) is also preset for ADMIN only. Per-user overrides live in the `UserPermission` table (one row
per `(userId, key)`, `allowed` = grant/deny; rows with unknown keys are
ignored and can never widen access). `getActiveUser()` /
`getActiveUserById()` resolve the effective set from the same database read
that checks role, active and session version (the override rows load through
the indexed `(userId, key)` relation in the one user query), so an override
edit takes effect on the next request, and `requirePermission(session, key)`
gates on it (401 without an active session, 403 without the key). The inbox
surfaces (W2 perm-inbox: dashboard page, `/api/chats`, `/api/messages`,
`/api/send`, `/api/whatsapp/status`, `/uploads/*`, socket handshake/rooms)
enforce through these keys. The travel surfaces (W2 perm-travel) enforce them
too: `getTravelActor()` requires `travel.access` on top of the role/assignment
rule (so an assignment alone no longer opens the module — the user also needs
the grant); the workflow gates `createRequest`/`createRevision` on
`travel.create`, `review` on `travel.review` and `issue` on `travel.issue`,
with the role and record-level rules (owner, assigned validator) kept as the
minimum — a permission can only narrow, never widen; the document routes gate
CLIENT download/send on `travel.client_docs.download` /
`travel.client_docs.send` (the send key is deliberately separate from
`whatsapp.inbox.send`, so a travel-only user can send a client quotation
without inbox access) and INTERNAL download on `travel.internal.download`
(D2: validators need an explicit grant).

**Permission administration (W2 perm-admin).** User management itself is now
gated on the effective `admin.users` permission, not the raw role:
`/api/users` keeps its historical 401-for-everything semantics, while
`/api/users/[id]/revoke-sessions` keeps its 401/403 split — an ADMIN denied
`admin.users` loses both, and a non-admin granted the key gains them. The
permission matrix lives under `/api/permissions` (`requirePermission(session,
"admin.users")`, 401/403): `GET` returns every user with their overrides,
role preset and resolved effective set plus the `internalLocked` flag; `PUT`
writes per-user overrides (`allowed: true/false`, `null` resets to the preset
by deleting the row) after validating keys against the closed set. Guard
rails, all enforced server-side and writing no audit entry on rejection: a
user cannot change their own permissions (the users API likewise rejects self
role-changes and self-deactivation), and the last active administrator cannot
be demoted, deactivated, deleted or stripped of `admin.users`. Every applied
change runs in a transaction, bumps the target's `User.sessionVersion` (open
sessions and sockets pick up the new set on the next request / revalidation
pass) and writes a `PERMISSIONS_UPDATED` audit row naming the target and the
changed keys — never credentials. No-op saves neither bump nor audit. The D3
migration is served by `/api/permissions/report`: `GET` lists every existing
user with the preset they would receive; the single `POST` Confirm action is
recorded once (a second call answers 409) as a
`PERMISSIONS_MIGRATION_CONFIRMED` audit row, whose presence is the
confirmation state (`lib/permissions-report.ts` — the schema gains no table
for this one-off flag). Until that confirmation exists, `PUT` rejects
granting the internal-cost keys to ANY user with 403, ADMIN-role targets
included — their preset already holds the keys, and an orphan grant row would
survive a later demotion (D2). For the same reason, `PATCH /api/users`
answers 400 when a role change away from ADMIN would leave the user holding
an internal-cost grant row while the report is unconfirmed; removing the row
first (or confirming the report) unblocks the demotion. Denies and resets are
always accepted because they only narrow access. The admin UI
exposes the matrix as a per-user Permissions dialog in the existing users tab
(own row disabled) and the report at `/admin/permissions` (page gated on
`admin.users`, like the API).

**Rate limiting and media validation.** Still open (see below).

## Security Checklist Before Production

- [ ] Upgrade all dependencies and resolve `npm audit` findings.
- [ ] Generate strong `NEXTAUTH_SECRET` and `ADMIN_PASSWORD`.
- [ ] Serve over HTTPS with a valid certificate.
- [x] Restrict CORS/socket origins (W1: exact-origin allow-list via `allowRequest` in `lib/socket-auth.ts` — see "Access policy and permission model").
- [x] Authenticate and room-scope Socket.io (W1: session-cookie handshake, server-managed rooms — W3: per-account `inbox:<accountKey>`/`admins:<accountKey>`, 60s + token-expiry revalidation — see "Access policy and permission model").
- [ ] Add rate limiting and input size limits.
- [x] Protect `/uploads/` (W1: authenticated streaming via the custom server — see "Access policy and permission model"; media stays under `public/uploads/`).
- [ ] Back up `.wwebjs_auth/` securely.
- [ ] Review Puppeteer sandbox settings for your hosting environment.
