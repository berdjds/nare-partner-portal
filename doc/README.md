# WAControl Documentation

WAControl is a web dashboard for managing WhatsApp Web sessions. It allows authenticated users to read and send WhatsApp messages, view chats, manage users, and monitor connection status through a browser-based interface.

## What is WAControl?

WAControl connects to WhatsApp Web using Puppeteer and the `whatsapp-web.js` library. An admin scans a QR code to authenticate the session, after which the application can:

- Receive incoming messages in real time.
- Send text, image, voice, and document messages.
- Persist chats and messages to a local SQLite database.
- Manage users and view audit logs from an admin panel.

## Documentation Index

- [Architecture](./architecture.md) — system overview, tech stack, and data flow.
- [Setup](./setup.md) — installation, environment variables, and first run.
- [Database](./database.md) — Prisma schema and model descriptions.
- [API Reference](./api-reference.md) — HTTP and Socket.io endpoints.
- [Authentication](./authentication.md) — roles, sessions, and login flow.
- [Components](./components.md) — React components and hooks.
- [Deployment](./deployment.md) — portal.nare.am release path: provisioning, CI pipeline, staging, rollback/restore, backups and drills.
- [Security](./security.md) — security considerations and best practices.
- [Troubleshooting](./troubleshooting.md) — common issues and fixes.

## Quick Start

```bash
npm install
cp .env.example .env
npm run db:push
npm run db:seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with the seeded admin credentials configured in `.env`.
