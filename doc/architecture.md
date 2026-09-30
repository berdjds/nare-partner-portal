# Architecture

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Framework | Next.js 15 (App Router) + React 19 | Web application framework |
| Language | TypeScript 5 | Type safety |
| Styling | TailwindCSS 3 + shadcn/ui-style Radix components | UI styling and components |
| Authentication | NextAuth.js 4 (credentials) | User sessions |
| Database | SQLite via Prisma 5 | Data persistence |
| Real-time | Socket.io | Live message and state updates |
| WhatsApp | whatsapp-web.js + Puppeteer | WhatsApp Web automation |
| Build runner | tsx | Run TypeScript server directly |

## Directory Structure

```
WAControl/
├── app/                    # Next.js App Router pages and API routes
│   ├── (pages)
│   │   ├── page.tsx        # Root redirect
│   │   ├── login/          # Login page
│   │   ├── admin/          # Admin dashboard
│   │   ├── dashboard/      # Chat dashboard
│   │   └── travel/         # B2B travel module
│   └── api/                # API route handlers
│       ├── auth/[...nextauth]/
│       ├── chats/
│       ├── messages/
│       ├── send/
│       ├── users/
│       ├── logs/
│       ├── whatsapp/status/
│       └── travel/         # Travel module API routes
├── components/             # React components
│   ├── ui/                 # shadcn/ui base components
│   ├── admin/              # Admin dashboard UI
│   ├── dashboard/          # Chat dashboard UI
│   └── travel/             # Travel module UI
├── lib/                    # Core business logic
│   ├── auth.ts             # NextAuth configuration
│   ├── prisma.ts           # Prisma singleton
│   ├── utils.ts            # Tailwind class merging
│   ├── whatsapp.ts         # WhatsApp client service
│   └── travel/             # B2B travel module (engine, workflow, …)
├── hooks/                  # React hooks
│   └── useSocket.ts        # Socket.io client hook
├── prisma/                 # Prisma schema and seed
│   ├── schema.prisma
│   └── seed.ts
├── tests/                  # Vitest suites (npm test)
├── server.ts               # Custom Next.js + Socket.io server
└── next.config.js          # Next.js configuration
```

## Application Flow

1. **Startup**: `server.ts` prepares the Next.js app, creates an HTTP server, attaches Socket.io, and initializes the WhatsApp client after a short delay.
2. **Authentication**: Users sign in with email and password. NextAuth validates credentials against the `User` table and issues a JWT session.
3. **WhatsApp Connection**: Each WhatsApp business account (W3: `marhaba`, `nare`) is paired by scanning its own QR code from the admin accounts panel. The `whatsapp-web.js` client authenticates and stores session data in `.wwebjs_auth/`.
4. **Message Handling**: Incoming and outgoing messages are persisted to SQLite and broadcast via Socket.io.
5. **Dashboard**: Active ADMIN/USER view chats and send messages; ADVISOR/VALIDATOR work in the travel module; admins manage users and connection state.

## Server Architecture

The application uses a custom server entry point (`server.ts`) instead of the default Next.js CLI. This allows Socket.io to share the same HTTP server as Next.js.

```
HTTP Server
├── GET/HEAD /uploads/* → lib/uploads.ts (authenticated media streaming,
│   intercepted before the Next.js static handler)
├── Next.js request handler
└── Socket.io server (path: /api/socket, origin + session gated,
    room-scoped — lib/socket-auth.ts)
    └── WhatsApp service events (message, chat_update, whatsapp_state)
```

## Data Flow for Incoming Messages

1. WhatsApp Web emits a `message_create` event.
2. `lib/whatsapp.ts` receives the message, downloads media if present, and saves it to `public/uploads/`.
3. The chat and message are upserted in Prisma.
4. Socket.io emits `message` and `chat_update` to the authenticated `inbox` room (ADMIN/USER sockets) and the full `whatsapp_state` only to the `admins` room.
5. The dashboard UI updates the chat list and message thread.

## Data Flow for Outgoing Messages

1. The user sends a message via the dashboard.
2. The UI calls `POST /api/send`.
3. The server validates the session, checks the WhatsApp client is ready, and calls `sendWhatsAppMessage`.
4. `message_create` fires, and the message is persisted like any other message.

## Travel module (B2B costing & quotations)

Added 2026-09-21. See `doc/travel/IMPLEMENTATION.md` for the full decision record and
`doc/travel/OPERATOR-GUIDE.md` for run instructions.

- `lib/travel/` — module domain layer: `contracts.ts` (frozen shared types; money = decimal
  strings, dates = local `YYYY-MM-DD`), `engine/` (pure deterministic pricing engine,
  decimal.js), `workflow.ts` (quote state machine with hash-bound approvals), `resolve.ts`
  (DB → engine DTO), `codes.ts` (transactional package codes), `snapshots.ts` (canonical JSON +
  sha256), `notifications.ts` (transactional outbox; email via `lib/email.ts`/nodemailer,
  WhatsApp via the existing client), `pdf/` (HTML→PDF via a dedicated puppeteer browser),
  `import.ts` (workbook evidence staging), `settings.ts`, plus `access.ts` (module RBAC),
  `templates.ts`, `whatsapp-docs.ts` (document delivery), `reorder.ts`, `redact.ts` and
  `trace-table.ts`.
- `app/api/travel/` — route handlers following existing session/zod/audit conventions.
- `app/travel/`, `components/travel/` — UI (requests workspace, review queue, templates,
  catalog, notifications).
- `server.ts` additionally starts the notification worker and hourly overdue-validation sweep.
- Tests: `tests/` (vitest; `npm test` = `vitest run`): engine, travel-db,
  workflow, pdf, qa plus access, auth, messaging, email, socket and deploy
  suites.
- Documents are stored under `data/documents/` (not `public/uploads/`) and served through an
  authorized route.
