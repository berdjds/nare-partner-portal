# Deployment

## Important Disclaimer

WhatsApp Web automation through `whatsapp-web.js` is not an official WhatsApp API. Using it may violate WhatsApp's Terms of Service and can result in account restrictions or bans. For production workloads, use the official [WhatsApp Business Platform / Cloud API](https://business.whatsapp.com/products/business-platform).

## Environment Variables

Before deploying, set strong values for all required variables:

```env
DATABASE_URL="file:./dev.db"
NEXTAUTH_URL="https://your-domain.com"
NEXTAUTH_SECRET="<random-32-char-secret>"
ADMIN_EMAIL="admin@example.com"
ADMIN_PASSWORD="<strong-password>"
```

Generate a secure secret:

```bash
openssl rand -base64 32
```

## Build

```bash
npm install
npm run db:push
npm run db:seed
npm run build
npm run start
```

## Production Server

The production entry point is `server.ts`, started with `npm run start`. It runs the custom Next.js + Socket.io server on port `3000` (or `PORT` environment variable).

## Files to Protect

Never commit or expose these files:

- `.env`
- `.wwebjs_auth/`
- `.wwebjs_cache/`
- `dev.db`
- `public/uploads/`

These are already listed in `.gitignore`.

## Reverse Proxy (Recommended)

Place the Node.js server behind a reverse proxy such as Nginx or Traefik. Configure HTTPS termination and WebSocket support for Socket.io.

Example Nginx WebSocket configuration:

```nginx
location /api/socket/ {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Puppeteer on Linux

Puppeteer may require additional system dependencies on Linux servers. You can install them with the documented package list for Chromium or run Puppeteer with `--no-sandbox` (already configured in `lib/whatsapp.ts`).

## Docker Deployment

A `Dockerfile` is included in the project root. It uses a Node.js 20 base image and installs the system Chromium required by Puppeteer.

### Build the image

```bash
docker build -t wacontrol:latest .
```

### Environment variables for Docker

Add these to the VPS `.env` file:

```env
WACONTROL_NEXTAUTH_SECRET=<random-32-char-secret>
WACONTROL_ADMIN_EMAIL=admin@example.com
WACONTROL_ADMIN_PASSWORD=<strong-password>
```

### Add to an existing Traefik compose file

Append this service block to the existing `docker-compose.yml` on the VPS. It follows the same Traefik routing and rate-limiting pattern as the other Node apps.

```yaml
  wacontrol_app:
    image: wacontrol:latest
    container_name: wacontrol-app
    restart: always
    networks:
      - web
    environment:
      - NODE_ENV=production
      - HOSTNAME=0.0.0.0
      - DATABASE_URL=file:/app/data/dev.db
      - NEXTAUTH_URL=https://wa.hayk.ae
      - NEXTAUTH_SECRET=${WACONTROL_NEXTAUTH_SECRET}
      - ADMIN_EMAIL=${WACONTROL_ADMIN_EMAIL}
      - ADMIN_PASSWORD=${WACONTROL_ADMIN_PASSWORD}
      - PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
    volumes:
      - ./wacontrol-data:/app/data
      - ./wacontrol-uploads:/app/public/uploads
      - ./wacontrol-auth:/app/.wwebjs_auth
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.wacontrol.rule=Host(`wa.hayk.ae`)"
      - "traefik.http.routers.wacontrol.entrypoints=web"
      - "traefik.http.routers.wacontrol.middlewares=redirect-to-https"
      - "traefik.http.routers.wacontrol-secure.rule=Host(`wa.hayk.ae`)"
      - "traefik.http.routers.wacontrol-secure.entrypoints=websecure"
      - "traefik.http.routers.wacontrol-secure.tls.certresolver=le"
      - "traefik.http.routers.wacontrol-secure.middlewares=wacontrol-rate"
      - "traefik.http.middlewares.wacontrol-rate.ratelimit.average=10"
      - "traefik.http.middlewares.wacontrol-rate.ratelimit.burst=20"
      - "traefik.http.services.wacontrol.loadbalancer.server.port=3000"
    expose:
      - "3000"
```

### First run on the VPS

1. Copy the project source to the VPS.
2. Build the image: `docker build -t wacontrol:latest .`
3. Add the service block to `/root/productionapp/docker-compose.yml`.
4. Add the environment variables to `/root/productionapp/.env`.
5. Create host directories for persistence:

   ```bash
   mkdir -p /root/productionapp/wacontrol-data
   mkdir -p /root/productionapp/wacontrol-uploads
   mkdir -p /root/productionapp/wacontrol-auth
   ```

6. Start the container:

   ```bash
   cd /root/productionapp
   docker compose up -d wacontrol_app
   ```

7. The container entry point automatically runs `npm run db:push` on every start to ensure the SQLite schema exists.
8. Seed the admin user once:

   ```bash
   docker compose exec wacontrol_app npm run db:seed
   ```

### Notes

- The SQLite database lives in `./wacontrol-data/dev.db` on the host. Make sure the `DATABASE_URL` environment variable uses the absolute path `file:/app/data/dev.db` inside the container.
- Uploaded media is stored in `./wacontrol-uploads/`.
- The WhatsApp session is stored in `./wacontrol-auth/`; protect this directory.
- The container exposes port `3000` and relies on the existing `web` Docker network and Traefik container.
- WebSocket traffic for Socket.io uses path `/api/socket`; Traefik passes WebSocket upgrade headers automatically.
- **Real-time messages only:** messages that arrive while the session is `ready` are saved and displayed. After the client connects, the app also backfills at most the 20 most recent chats × 50 messages each (`BACKFILL_CHAT_LIMIT`/`BACKFILL_MESSAGE_LIMIT` in `lib/whatsapp.ts`); anything older is not captured.
- **Phone must be online:** the mobile device does not need to be open, but it must have an internet connection for the WhatsApp Web session to receive messages.
- Use the dashboard **New message** button to send messages to unsaved phone numbers.

## Scaling Notes

WAControl maintains the WhatsApp client as an in-memory singleton in `lib/whatsapp.ts`. It is designed for a single server instance. Scaling horizontally would require externalizing the WhatsApp session state and message queue.

## CI/CD (GitHub Actions)

`.github/workflows/ci-cd.yml` runs on every push to `main`:

1. **Test job** — `npm ci` (Chromium download skipped), `prisma generate`, `tsc --noEmit`,
   `vitest run`, `next build`.
2. **Deploy job** (main only, serialized via concurrency group) — tars the source, uploads to
   the VPS (`213.136.80.87`, `/root/productionapp`), builds the Docker image, restarts
   `wacontrol-app` via docker compose, seeds the admin user, runs the travel catalog seed,
   then health-checks `https://wa.hayk.ae/login`.

**Seeds are bootstrap-only.** Deploys never re-seed a populated travel catalog: the catalog
seed (`scripts/seed-travel-catalog.ts`) counts vehicle/hotel/service products first and skips
when any exist, so operator deletes and edits survive deployments. To reseed deliberately,
run `SEED_FORCE=true npx tsx scripts/seed-travel-catalog.ts` inside the container. The
workbook import (`scripts/import-workbook.ts`) is manual-only and no longer runs on deploy —
the workbook is stale compared to the curated production catalog.

Repository secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (dedicated CI keypair
`~/.ssh/wacontrol_ci`, authorized on the VPS — revocable without touching the manual deploy
key). The manual `deploy.sh` / `deploy-vps.sh` scripts remain available as a fallback.

On a post-cutover failure with `ROLLBACK_COMPATIBLE=no` the deploy gate stops the candidate and
prints the manual recovery procedure; the tools and runbook for it live in
[Manual recovery](#manual-recovery-export-since--restore-backup) below. The deploy gate never
restores data on its own.

Optional production env for travel email notifications: `WACONTROL_SMTP_HOST`,
`WACONTROL_SMTP_PORT`, `WACONTROL_SMTP_USER`, `WACONTROL_SMTP_PASS`, `WACONTROL_SMTP_FROM`
(in `/root/productionapp/.env` on the VPS).

## Manual recovery: export-since & restore-backup

The deploy gate (`scripts/vps-deploy.sh`) covers the safe paths on its own: a pre-deploy
failure restarts the previously running image on the untouched data, and a post-cutover
failure with `ROLLBACK_COMPATIBLE=yes` rolls back to the previous image **on the current
data** — newly accepted rows are kept and nothing is ever restored from a backup
automatically. This section is the runbook for the remaining case: post-cutover failure
with `ROLLBACK_COMPATIBLE=no`, where the candidate migrated the database and the previous
image can no longer serve it. The tools are `scripts/export-since.sh` and
`scripts/restore-backup.sh`; both run on the VPS and are operator-invoked only.

### The write freeze and its writers

Between the freeze start and cutover the deploy gate stops the `wacontrol-app` container,
which stops every writer:

- the Next.js API routes and Socket.io handlers (all HTTP writes),
- the in-process WhatsApp Web client (inbound message persistence and outbound sends),
- the travel notification outbox worker (EMAIL/WHATSAPP deliveries) and the
  overdue-validation sweep,
- bootstrap seeds (they run only through the deploy gate), and the container-entrypoint
  `prisma db push` (no container is running to execute it).

The gate logs `WRITE FREEZE start` with a UTC timestamp just before it stops the app, and
`WRITE FREEZE end` once all writers have stopped. Writers stay stopped through backup,
trial A, trial B and cutover, and the freeze only ends when the cutover `compose up` starts
the candidate (or when `restart_frozen_app` / rollback restarts the old image) — backup,
trials and cutover do not sit between the two log lines.

### Inbound WhatsApp during the freeze

While the container is stopped the WhatsApp Web session is offline: incoming customer
messages are **not received by the app** and are not queued anywhere for later delivery.
After the app reconnects, only live events from that point onward plus the bounded backfill
(at most 20 chats × 50 messages each, `lib/whatsapp.ts`) are captured — messages that
arrived while the session was offline are visible in the dashboard only if WhatsApp Web
happens to surface them inside that backfill window. Budget customer communication
accordingly around deploys.

### Trial A / trial B and rollback compatibility

- **Trial A:** the candidate image runs on a temporary copy of the data (no auth dir) and
  must migrate it (`prisma db push`, never with `--accept-data-loss`), pass bootstrap seeds
  and answer `/login` with HTTP 200. Failure → the old container restarts on the untouched
  data.
- **Trial B:** the previous image runs on the *migrated* copy. Whether it comes up healthy
  decides `ROLLBACK_COMPATIBLE=yes|no` (also `yes` when the schema did not change). It
  proves whether the previous image can still serve the new schema — nothing else.
- **Compatible (`yes`):** a post-cutover failure restarts the previous image on the current
  data. Newly accepted data is kept; no restore happens.
- **Incompatible (`no`):** **do not restart the previous image against the migrated
  database** — its schema compatibility is unproven by the failed trial, and an old binary
  running `db push` against a newer schema can destroy data. Use the runbook below.

### Guarantees

- `export-since` exports every row with `createdAt`/`updatedAt` greater than or equal to the
  archive's timestamp from **every table that has those columns** (messages, chats, travel
  requests, quote versions, documents, workflow events, notification deliveries, logs,
  users, and any future timestamped table — discovered dynamically). The export is written
  next to the archive as `wacontrol-<stamp>.export.json`.
- `restore-backup` replaces the three data dirs (`wacontrol-data`, `wacontrol-uploads`,
  `wacontrol-auth`) with exactly the verified backup content and restarts the app **on the
  previous (pre-deploy) image** — the one matching the backup's schema, never the failed
  candidate — with notifications paused.
- **Not guaranteed:** media files added to `wacontrol-uploads/` after the backup (they are
  neither in the export nor restored — preserve them from a separate copy if needed); rows
  in tables without `createdAt`/`updatedAt` (listed under `skippedTables` in the export —
  re-create those manually); the WhatsApp session returns to its backup-time state and may
  require re-pairing; messages that arrived while the session was offline (see above).

### Runbook: post-cutover failure with `ROLLBACK_COMPATIBLE=no`

The candidate is stopped. The data dirs hold the pre-deploy data plus everything the
candidate accepted after cutover. The pre-deploy backup is
`backups/wacontrol-<stamp>.tar.gz` (with a `.sha256` sidecar).

1. **Preserve the post-backup rows** (app is stopped, so the snapshot is consistent):

   ```bash
   bash /root/productionapp/wacontrol-src/scripts/export-since.sh \
     /root/productionapp/backups/wacontrol-<stamp>.tar.gz
   ```

   This writes `backups/wacontrol-<stamp>.export.json`. Review it, e.g.
   `jq '.counts' /root/productionapp/backups/wacontrol-<stamp>.export.json`.

2. **Choose exactly one:**

   a. **Fix forward (preferred).** Land the fix and push; the deploy gate freezes, backs up
      the *current* data (including the newly accepted rows) and re-gates the deploy.

   b. **Restore the backup.** Only when the backup's state is the known-good one:

      ```bash
      bash /root/productionapp/wacontrol-src/scripts/restore-backup.sh \
        /root/productionapp/backups/wacontrol-<stamp>.tar.gz --yes
      ```

      The script verifies the sha256 sidecar, refuses without `--yes`, and — unless
      `--no-export-ack` is given — refuses until step 1 has produced the export for this
      archive. It then stops the app, overwrites the three data dirs (archive members are
      validated; nothing else is touched), and starts the app via docker compose with
      `WACONTROL_NOTIFICATIONS_PAUSED=1` (compose override file
      `wacontrol-restore-paused.compose.yml`) so outbox entries reverted by the restore are
      not re-sent. Crucially, the restore starts the **previous (pre-deploy) image**
      (`wacontrol:previous`, overridable via `WACONTROL_RESTORE_IMAGE`) — the image that
      matches the backup's schema — **not the failed candidate**: after a failed cutover the
      compose service image `wacontrol:latest` still points at the candidate (the deploy
      gate tags it for cutover and does not retag on `ROLLBACK_COMPATIBLE=no`), and a plain
      `compose up` would boot it on the restored backup, whose entrypoint `prisma db push`
      would re-run the failing migration. The script therefore checks the restore image
      exists (`docker image inspect`) before stopping anything and retags it as
      `wacontrol:latest` before `compose up`. It health-checks `/login` inside the container
      and prints review/resume instructions.

3. **Resume notifications after reviewing** the paused outbox and re-applying any rows from
   the export that must survive (review is manual — no automatic merge exists):

   ```bash
   rm /root/productionapp/wacontrol-restore-paused.compose.yml
   cd /root/productionapp && docker compose up -d wacontrol_app
   ```

   This plain `compose up` stays correct after the restore: `wacontrol:latest` was retagged
   to the pre-deploy image, so the app keeps running the image matching the restored schema
   once the pause override is gone.

Both recovery scripts take `WACONTROL_APP_ROOT` (default `/root/productionapp`) and are
covered by `tests/deploy/recovery.test.ts`.
