# WAControl — Agent Guide

## Project overview

WAControl is a web dashboard for reading and sending WhatsApp messages through
WhatsApp Web automation (QR-code login). It includes role-based login (ADMIN /
USER / ADVISOR / VALIDATOR), an admin panel for managing the WhatsApp
connection and users, audit logs, a real-time chat UI, and a B2B travel
module.

Key facts:

- **Node.js + TypeScript, Next.js 15 (App Router) + React 19** on **port 3000**.
- The app runs on a **custom server (`server.ts`, executed with `tsx`)** that
  combines Next.js, an HTTP server, and Socket.io. Never rely on plain
  `next dev` / `next start` — Socket.io and the WhatsApp client would not
  start.
- **whatsapp-web.js + Puppeteer (headless Chromium)** drive the WhatsApp Web
  session. This is NOT an official API; it breaks when WhatsApp Web changes
  (see "WhatsApp integration pitfalls" below).
- **Prisma 5 + SQLite** for persistence. Database file is `prisma/dev.db`
  locally, `/app/data/dev.db` in Docker.
- **NextAuth 4 (credentials provider, JWT sessions)** for auth; passwords are
  bcrypt-hashed.
- TailwindCSS 3 with shadcn/ui-style components built on Radix primitives.
- Package version (`package.json` `version`) is surfaced in the admin panel as
  the deployed-build indicator — bump it on releases.

## Build and run commands

```bash
npm install            # installs deps; postinstall runs `prisma generate`
cp .env.example .env   # then fill in values
npm run db:push        # apply Prisma schema to SQLite
npm run db:seed        # seed admin user from ADMIN_EMAIL / ADMIN_PASSWORD
npm run dev            # dev server (custom server with Socket.io) on :3000
npm run build          # next build
npm run start          # production: NODE_ENV=production tsx server.ts
npm run db:reset       # prisma migrate reset --force && db:seed (destroys data)
npm test               # run the Vitest suite (vitest run)
```

Type-checking: `npx tsc --noEmit` (strict mode is on). **Tests: `npm test`**
runs the Vitest suite (`vitest run`; config `vitest.config.ts`, JSX compiled
via `tsconfig.test.json`). Suites under `tests/`: access, auth, deploy,
email, engine, messaging, pdf, qa, socket, travel-db, workflow — DB-backed
suites push the Prisma schema to throwaway SQLite files in `/tmp`. There is
no linter configured. `npm run build` is the standard build verification; CI
runs `tsc --noEmit`, the Vitest suite and `next build` on every push to
`main` before deploying (see "Deployment").

Environment variables: `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD`, optional `PUPPETEER_EXECUTABLE_PATH` (system
Chromium, used in Docker). See `.env.example`.

## Code layout and module map

- `server.ts` — custom server: Next.js handler + Socket.io (path
  `/api/socket`) + delayed `initializeWhatsApp()`. `server.js` is a stale
  compiled variant expecting a `dist/` folder; **`server.ts` is the source of
  truth** (package.json scripts use it via `tsx`).
- `lib/whatsapp.ts` — the core service. Singleton WhatsApp client state
  (anchored on `globalThis.__waControlState` — see pitfall #1 below), client
  lifecycle (init with retries, QR, ready watchdog, logout, reconnect),
  message persistence (`persistMessage`), media download to
  `public/uploads/`, backfill of recent chats after `ready`, and
  `sendWhatsAppMessage()`.
- `lib/auth.ts` — NextAuth options (credentials + JWT; `role` is carried in
  the token/session). `lib/prisma.ts` — Prisma singleton. `lib/audit.ts` —
  `writeAuditLog()` (never throws). `lib/utils.ts` — `cn()` class merging.
  `lib/access-policy.ts` — the W1 interim access policy (inbox-role gates;
  every gate re-reads the user row from the DB). `lib/socket-auth.ts` —
  Socket.io origin/session gates, server-managed rooms and revalidation.
  `lib/uploads.ts` — authenticated `/uploads/*` media streaming. `lib/travel/`
  — the B2B travel module (see `doc/travel/IMPLEMENTATION.md`).
- `app/` — App Router pages: `page.tsx` (role-based redirect), `login/`,
  `admin/` (ADMIN only), `dashboard/` (chat UI; inbox roles only — everyone
  else is redirected to `/travel`), `travel/` (B2B travel module),
  `calculator/` (embeds a static HTML calculator from `doc/temp/`). Pages
  guard with `getServerSession(authOptions)` + `redirect` and the interim
  access policy.
- `app/api/` — route handlers. All require a session; the chat APIs
  (`chats`, `messages`, `send`) additionally require an active inbox role
  (ADMIN/USER) via `requireInboxAccess()`; `users` and `logs` require
  `role === "ADMIN"`; `whatsapp/status` GET returns full details to ADMIN and
  `{ connected }` to USER (POST reconnect/logout is ADMIN-only). The travel
  module APIs live under `app/api/travel/`. Request bodies are validated with
  **zod**. Endpoints: `chats` (GET), `messages` (GET), `send` (POST),
  `users` (GET/POST/PATCH/DELETE), `logs` (GET), `whatsapp/status` (GET
  state; POST actions: reconnect/logout), `travel/**`, `auth/[...nextauth]`.
- `components/` — `ui/` (shadcn-style primitives), `admin/AdminDashboard.tsx`,
  `dashboard/ChatDashboard.tsx`, `travel/` (travel module UI),
  `calculator/CalculatorFrame.tsx`.
- `hooks/useSocket.ts` — client hook subscribing to Socket.io events
  (`whatsapp_state`, `message`, `chat_update`).
- `prisma/schema.prisma` — models: `User`, `Chat`, `Message`, `Log`,
  `WhatsAppSession`, plus the travel module models (requests, quote versions,
  scenarios/stays/lines, catalog + rate versions, documents, workflow events,
  notification deliveries, settings). There are **no migrations**; the schema
  is applied with `prisma db push`.
- `doc/` — detailed project docs (`architecture.md`, `api-reference.md`,
  `authentication.md`, `database.md`, `deployment.md`, `security.md`,
  `current-issues.md`, `troubleshooting.md`, etc.). Keep them in sync when
  changing behavior they describe.

## Code style and conventions

- TypeScript strict mode; path alias `@/*` maps to the repo root
  (`@/lib/...`). ES modules, `moduleResolution: bundler`.
- Language of all code, comments, and docs is **English**.
- Server log lines are prefixed, e.g. `[WhatsApp] ...`, `[API /send] ...`.
- Audit log action names are upper snake case (`SEND_MESSAGE`,
  `MESSAGE_RECEIVED`, `WA_READY`, ...). Write audit entries via
  `writeAuditLog()` — it is designed to never throw (retries with
  `userId: null` on stale-user FK violations).
- Message/chat `type`, `status`, and `role` fields are plain strings with
  documented value sets in `schema.prisma` comments — match those values.
- Comments in this codebase tend to document *why* (upstream bugs, WhatsApp
  Web version quirks), not what. Follow that convention.
- UI components follow the shadcn/ui pattern: Radix primitives + `cva`
  variants + `cn()` from `lib/utils.ts`.

## WhatsApp integration pitfalls (read before touching `lib/whatsapp.ts`)

The integration targets a moving, unofficial API. Hard-won workarounds live in
the code and must not be regressed:

1. **Dual module instances.** The custom server and Next.js API routes load
   `lib/whatsapp.ts` through different bundlers. State is anchored on
   `globalThis.__waControlState` so both share one client — keep it that way.
2. **Message id field rename.** On WhatsApp Web 2.3000.1043x+,
   `msg.id._serialized` became `msg.id.$1`; `getMessageId()` reads both.
3. **Avoid `msg.getChat()`** — it crashes with the minified `r: r` error on
   newer versions. Chat ids are derived from `msg.from`/`msg.to` instead.
4. **Runtime patches.** `scripts/patch-wwebjs.js` (run by
   `docker-entrypoint.sh` at container start) applies two exact-string patches
   to whatsapp-web.js's injected `Utils.js`: (a) `getChats()` from
   `Promise.all` to `Promise.allSettled` to survive unserializable chat
   models; (b) `sendMessage()` restores `message.id = newMsgKey` (and deletes
   `__x_id`) after the `mediaOptions` spread — MediaData model internals
   overwrite the id and break every media send with "Data passed to getter
   must include an id property" (wwebjs#201921). It edits `node_modules`
   in-place; each patch is idempotent and non-fatal.
5. **No version pinning.** Pinning WhatsApp Web via `webVersion` snapshots was
   tried and abandoned (stalls at app-state sync). The client runs the live
   version.
6. **`authenticated` → `ready` stalls** on resumed sessions are handled by a
   two-stage watchdog that reloads the Puppeteer page (90s, then warns at
   +150s).
7. **Init is retried** up to 5 times with teardown between attempts, and
   concurrent callers share one in-flight `initPromise`.
8. **Dedupe.** Both `message_create` and `message` events persist; the unique
   `whatsappMessageId` + swallowed P2002 errors make this idempotent.
   `sendMessage()` may resolve to `undefined` even on success — treat a
   missing return as success.
9. **LID system.** WhatsApp may map phone numbers to opaque `@lid` jids;
   `Chat.phone` stores the dialed/known number because contact data cannot be
   trusted for `@lid` chats.

## Deployment

- **Docker** (`Dockerfile`, node:20-bookworm-slim): installs system Chromium
  (`PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`,
  `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`), runs `npm ci` with dev deps,
  `npm run build`, then `docker-entrypoint.sh` (applies `prisma db push`,
  clears stale Chromium `Singleton*` locks, runs the wwebjs patch) and
  `npm run start`.
- **docker-compose.yml** runs the container behind Traefik with host rule
  `wa.hayk.ae`, HTTPS redirect, rate limiting, and volume mounts for
  `wacontrol-data` (SQLite), `wacontrol-uploads` (media), and
  `wacontrol-auth` (WhatsApp session). Secrets come from env vars prefixed
  `WACONTROL_*`.
- **CI/CD** — pushes to `main` run `.github/workflows/ci-cd.yml`: a test job
  (`npm ci`, `prisma generate`, `tsc --noEmit`, `vitest run`, `next build`),
  then a deploy job that uploads the source and pipes `scripts/vps-deploy.sh`
  to the VPS over ssh. The deploy gate builds the candidate image while the
  app keeps serving, tags the running image as `previous`, stops all writers
  (**write freeze**), archives a verified backup of the data dirs, runs
  trial A (candidate on a data copy) and trial B (rollback compatibility of
  the previous image), cuts over, and rolls back or prints the manual
  recovery procedure on failure. Seeds are bootstrap-only (they self-skip
  when data exists). Details: `doc/deployment.md`.
- **Manual fallback** — `deploy-vps.sh` / `deploy.sh` (identical scripts):
  package the source into a tarball, `scp` it to the VPS
  (root@213.136.80.87, key `~/.ssh/wacontrol_deploy`), build the image there,
  and restart via `docker compose`. These scripts hard-code production host
  details — treat them as ops tooling, not library code.

## Security considerations

- Keep secret and never commit: `.env`, `prisma/dev.db`, `public/uploads/`,
  `.wwebjs_auth/`, `.wwebjs_cache/` — they hold admin credentials and the live
  WhatsApp session. All are gitignored.
- `NEXTAUTH_SECRET` must be a random 32+ char value in production; change the
  seeded admin password (`ADMIN_PASSWORD` defaults to `admin123`).
- Auth model: JWT sessions; every API route checks `getServerSession`, and
  admin-only routes check `session.user.role === "ADMIN"`. Preserve these
  checks when adding routes.
- WhatsApp Web automation may violate WhatsApp's ToS and can get the linked
  number restricted — warn before suggesting features that increase message
  volume.
- The linked phone must stay online; only messages arriving while the client
  is `ready` are captured in real time (plus a bounded backfill of 20 chats ×
  50 messages after `ready`).
- **Interim access policy (W1, until W2 grants per-user inbox access)** —
  `lib/access-policy.ts`: only ADMIN/USER may open the chat inbox; ADVISOR and
  VALIDATOR are travel-only. Every gate re-reads the user row from the
  database, so deactivation or a role change takes effect on the next request
  (a revoked user gets 401). Full WhatsApp status details (state, info,
  pairing QR) are ADMIN-only; USER sees availability as `{ connected }`.
- Socket.io (`/api/socket`) is no longer open: the handshake must come from an
  allowed origin (the `NEXTAUTH_URL` origin plus `SOCKET_ALLOWED_ORIGINS`)
  and carry a valid NextAuth session cookie for an active inbox-role user; the
  server places sockets into `inbox`/`admins` rooms and the full
  `whatsapp_state` (with the pairing QR) goes to `admins` only
  (`lib/socket-auth.ts`).
- Media under `public/uploads/` is no longer publicly reachable: the custom
  server intercepts `/uploads/*` and streams files only to authenticated,
  active inbox-role users, with `Cache-Control: private, no-store`
  (`lib/uploads.ts`). Full policy: `doc/security.md`.
