# Security

## Known Risks

### Dependency Vulnerabilities

The project currently depends on older package versions with known security advisories:

- `next` 14.0.4 — multiple critical advisories (SSRF, cache poisoning, authorization bypass, XSS).
- `@auth/core` via `next-auth` / `@auth/prisma-adapter` — critical authentication advisories.
- `sharp` <0.35.0 — libvips CVEs.
- `puppeteer` → `tar-fs`, `ws` — path traversal and DoS.
- `postcss` via `next` — XSS / arbitrary file read.
- `cookie` <0.7.0 — OOB cookie characters.

Run `npm audit` and upgrade dependencies before production use.

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
