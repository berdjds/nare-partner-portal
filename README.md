# WAControl

A web dashboard to read and send WhatsApp messages using WhatsApp Web (QR-code login). Includes admin configuration, user management, and audit logs.

## Features

- **WhatsApp QR-code login** — scan the QR code with your phone to link the session.
- **Two WhatsApp business accounts** — Marhaba Armenia (`marhaba`, the chat inbox) and Nare Travel and Tours (`nare`, the travel module, disabled by default). Each account is enabled and paired separately from the admin **Accounts** tab.
- **Real-time messaging** — incoming/outgoing messages sync via Socket.io.
- **Send to new numbers** — start a chat and send messages to unsaved phone numbers from the dashboard.
- **Text, image, voice, document** — send and view media messages.
- **Admin panel** — manage WhatsApp connection, users, and logs.
- **Role-based login with per-user permissions** — role presets by default (ADMIN runs everything, USER the WhatsApp chat inbox, ADVISOR/VALIDATOR the B2B travel module), adjustable per user through the permissions matrix in the admin panel. Internal-cost access is separate and off by default for non-admins until the owner confirms the permissions migration — see `doc/security.md` and `doc/authentication.md`.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- TailwindCSS + shadcn/ui-style components
- NextAuth (credentials) for authentication
- Prisma + SQLite
- whatsapp-web.js + Puppeteer
- Socket.io

## Quick start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```

3. Create the database and seed the admin user:
   ```bash
   npm run db:push
   npm run db:seed
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

5. Open http://localhost:3000 and sign in with the seeded admin credentials (see `.env`).

## Important notes

- **WhatsApp Web is not an official API.** Using it may violate WhatsApp's Terms of Service and can lead to account restrictions. For production, consider the official [WhatsApp Business Platform / Cloud API](https://business.whatsapp.com/products/business-platform).
- **Real-time messages, plus a bounded backfill.** The dashboard receives messages that arrive while the WhatsApp session is `ready`; right after connecting, the app also backfills at most the 20 most recent chats × 50 messages each. Anything older is not captured.
- **Your phone must be online.** The phone does not need to be open or in the foreground, but it must have an active internet connection to keep the WhatsApp Web session alive.
- **Travel sends never fall back between accounts.** All travel-module WhatsApp sends go through the account configured in the travel settings (`nare` by default); if it is disabled or not paired the send fails and is retried on the same account — never via Marhaba. See `doc/architecture.md` and `doc/deployment.md` for the accounts model and the Nare pairing runbook.
- The first startup downloads a Chromium browser for Puppeteer. On Linux servers you may need to install additional system dependencies.
- Keep `.wwebjs_auth/`, `.wwebjs_cache/`, `.env`, and the SQLite database secret — they contain the WhatsApp session and admin credentials.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file:./dev.db` | SQLite database path |
| `NEXTAUTH_URL` | `http://localhost:3000` | App URL |
| `NEXTAUTH_SECRET` | — | Random secret for JWT signing |
| `ADMIN_EMAIL` | `admin@example.com` | Seeded admin email |
| `ADMIN_PASSWORD` | `admin123` | Seeded admin password |

## Scripts

- `npm run dev` — start the app with the custom Socket.io server
- `npm run build` — build the Next.js app
- `npm run start` — run the production server
- `npm run db:push` — apply the Prisma schema
- `npm run db:seed` — seed the admin user
- `npm test` — run the Vitest test suite (also runs in CI before every deploy)

## Documentation

- [doc/README.md](doc/README.md) — full documentation index
- [doc/landing-content.md](doc/landing-content.md) — public landing page copy: where it lives (`lib/portal-content.ts`), the owner review rule before launch, the claims left out on purpose, and how to add a section
- [doc/deployment.md](doc/deployment.md) — production release path for portal.nare.am: server provisioning, the CI release pipeline (staging → production), rollback/restore runbooks, backups and drills

The repo-root `docker-compose.yml` is for **local development only**; the
production and staging compose projects live under `deploy/portal/` and
`deploy/staging/` (see [doc/deployment.md](doc/deployment.md)).
