# Deployment

## Important Disclaimer

WhatsApp Web automation through `whatsapp-web.js` is not an official WhatsApp API. Using it may violate WhatsApp's Terms of Service and can result in account restrictions or bans. For production workloads, use the official [WhatsApp Business Platform / Cloud API](https://business.whatsapp.com/products/business-platform).

## Environment Variables

Before deploying, set strong values for all required variables:

```env
DATABASE_URL="file:./dev.db"
NEXTAUTH_URL="https://portal.nare.am"
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

## Live Server Layout (/opt/stack)

The owner's production server runs a single host with everything under `/opt/stack`:

```text
/opt/stack/
├── docker-compose.yml      # live compose file (caddy + portal) — never rewritten by tooling
├── Caddyfile               # live Caddy config, mounted into the caddy container read-only
├── .env                    # production app secrets (env_file of the portal service)
├── portal/
│   ├── src/                # checked-out source the portal image is built from
│   ├── data/               # SQLite database (mounted at /app/data)
│   ├── uploads/            # message media (mounted at /app/public/uploads)
│   └── auth/               # WhatsApp session (mounted at /app/.wwebjs_auth)
└── staging/                # staging data layout (created by deploy/provision-server.sh)
    ├── data/  uploads/  auth/
    └── .env                # staging settings, incl. the discovered PORTAL_NETWORK
```

Two containers run in production, both attached to the compose project's `portal_net` network:

| Container | Compose service | Role |
| --- | --- | --- |
| `caddy` | `caddy` (image `caddy:2`) | TLS termination and reverse proxy; the only public ports (80, 443, 443/udp) |
| `portal-app` | `portal` (built from `./portal/src`, image `portal:<date>`) | the app on internal port 3000; never exposed to the host |

The live compose file and Caddyfile are mirrored in the repo as reference copies: `deploy/portal/docker-compose.yml` (secrets as `${VAR}` placeholders) and `deploy/portal/Caddyfile.example`. The provisioning script and the staging project are written against these copies — keep them in sync when the live layout changes. The live Caddyfile is:

```caddyfile
{
	email admin@nare.am
}

portal.nare.am {
	encode gzip
	reverse_proxy portal:3000
}
```

The caddy container mounts `./Caddyfile` read-only at its container-internal config path; every caddy admin command runs inside the container via `docker exec`. There is no host-level caddy installation and no host-level caddy config path involved anywhere.

The portal container's entrypoint applies the Prisma schema (`db push`) on every start; seed the admin user once with `npm run db:seed` inside the container. Socket.io WebSocket traffic (path `/api/socket`) passes through caddy's `reverse_proxy` without extra configuration.

### The Docker network is discovered, never hard-coded

The compose project owns the `portal_net` network, whose real name depends on the compose project name (e.g. `stack_portal_net`). Nothing in the repo hard-codes it: `deploy/provision-server.sh` discovers it at provisioning time from the running `portal-app` container:

```bash
docker inspect --format '{{range $name, $conf := .NetworkSettings.Networks}}{{println $name}}{{end}}' portal-app
```

The discovered name is recorded as `PORTAL_NETWORK` in `/opt/stack/staging/.env`, and the staging project (`deploy/staging/docker-compose.yml`) joins that network as an external network, so the existing caddy container can reach the staging container as `portal-staging:3000`.

## Puppeteer on Linux

Puppeteer may require additional system dependencies on Linux servers. You can install them with the documented package list for Chromium or run Puppeteer with `--no-sandbox` (already configured in `lib/whatsapp.ts`).

## Docker Image

The `Dockerfile` in the project root uses a Node.js 20 base image and installs the system Chromium required by Puppeteer (`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`). On the server the image is built by docker compose from `./portal/src` (service `portal`, tagged `portal:<date>`); staging builds the same source as `portal:staging`.

## Staging Site (staging.portal.nare.am)

Staging runs on the same server alongside production: its own container `portal-staging` (image `portal:staging`), its own data folders under `/opt/stack/staging` (`data`, `uploads`, `auth`), WhatsApp automation disabled (`WHATSAPP_DISABLED=1`), joined to the production Docker network as an external network. Production data, the production containers and the live compose file are never touched.

### DNS

Before provisioning, point `staging.portal.nare.am` at the same server (A/AAAA record next to `portal.nare.am`). Caddy issues the certificate automatically once the site block is live and DNS resolves; validation and reload do not depend on DNS, but the first HTTPS request does.

### The managed Caddyfile block

Provisioning edits the live `/opt/stack/Caddyfile` in exactly one place: a managed block delimited by marker lines, regenerated in place on every run:

```caddyfile
# BEGIN staging.portal.nare.am (managed by provision-server.sh)
staging.portal.nare.am {
	encode gzip
	reverse_proxy portal-staging:3000
}
# END staging.portal.nare.am
```

Never edit between the markers by hand — re-running the provisioning script replaces the block. Content outside the markers (including the production `portal.nare.am` site) is preserved untouched.

### Provisioning walkthrough

Run `deploy/provision-server.sh` once on the server, as a user with docker access and the live stack running. The script: creates `/opt/stack/staging/{data,uploads,auth}`, discovers `PORTAL_NETWORK` from the `portal-app` container (unless preset), records it in `/opt/stack/staging/.env` (mode 600), then installs the managed block: it writes a timestamped backup (`/opt/stack/Caddyfile.bak.<timestamp>`), builds a candidate file, validates the candidate **inside the caddy container** against a temporary copy (`docker exec caddy ... caddy validate`) so an invalid file never reaches the live path, installs the candidate, and reloads caddy inside the container (`docker exec caddy caddy reload --config <container-internal Caddyfile path>` — the path where the Caddyfile is mounted inside the container). Production keeps serving throughout.

1. **Dry run — exercise everything against scratch copies without touching the live file.** Point the script at a copy of the live Caddyfile and a scratch staging dir:

   ```bash
   cp -p /opt/stack/Caddyfile /tmp/Caddyfile.provision-dryrun
   PORTAL_CADDYFILE=/tmp/Caddyfile.provision-dryrun \
   PORTAL_STAGING_DIR=/tmp/portal-staging-dryrun \
   bash deploy/provision-server.sh
   ```

   This performs the real network discovery, validates the candidate inside the real caddy container, and reloads caddy with the unchanged live config (a no-op reload) — but writes only to `/tmp`. Review the managed block in `/tmp/Caddyfile.provision-dryrun` and the discovered network in `/tmp/portal-staging-dryrun/.env`, then remove the scratch files.

2. **Record the before checksum** of the live Caddyfile:

   ```bash
   sha256sum /opt/stack/Caddyfile
   ```

3. **Run the real provisioning:**

   ```bash
   bash deploy/provision-server.sh
   ```

4. **Verify the after checksum and the block.** The checksum now differs from the before checksum (exactly the managed block was added), and exactly one marker pair exists:

   ```bash
   sha256sum /opt/stack/Caddyfile
   grep -c 'BEGIN staging.portal.nare.am' /opt/stack/Caddyfile   # must print 1
   ```

5. **Re-run safety.** Running the script again regenerates the block in place: the checksum after a second run is identical to the one after the first (byte-identical file, still exactly one block). This makes the script safe to re-apply, e.g. after the production network name changed.

6. **Start the staging project** with the discovered network (the script prints this line at the end of a run):

   ```bash
   PORTAL_NETWORK=<discovered-name> docker compose -f deploy/staging/docker-compose.yml up -d
   ```

   `deploy/staging/docker-compose.yml` refuses to start without `PORTAL_NETWORK` and mounts only the staging folders. Browse to `https://staging.portal.nare.am` to confirm caddy routes to `portal-staging:3000`.

**Failure handling.** If candidate validation fails, the script restores the backup and exits 1 without attempting a reload — the live Caddyfile is never replaced. If the reload fails, it restores the backup and reloads the previous config before exiting 1. Either way the timestamped backup remains next to the live Caddyfile for inspection.

### Provisioning settings and secrets

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `PORTAL_CADDY_CONTAINER` | `caddy` | `deploy/provision-server.sh` | name of the live caddy container |
| `PORTAL_CADDYFILE` | `/opt/stack/Caddyfile` | `deploy/provision-server.sh` | path of the live Caddyfile on the host |
| `PORTAL_APP_CONTAINER` | `portal-app` | `deploy/provision-server.sh` | container the network is discovered from |
| `PORTAL_NETWORK` | *(discovered)* | provisioning, staging compose | production Docker network the staging project joins; set only to override discovery |
| `PORTAL_STAGING_DIR` | `/opt/stack/staging` | `deploy/provision-server.sh` | staging data root |
| `PORTAL_STAGING_SRC` | `/opt/stack/portal/src` | staging compose | source tree the staging image is built from |
| `PORTAL_IMAGE_TAG` | — | portal compose (reference) | tag of the production portal image (`portal:<date>`) |

Application secrets live only on the server: production in `/opt/stack/.env` (the `env_file` of the `portal` service), staging in `/opt/stack/staging/.env`. Both hold the app variables from [Environment Variables](#environment-variables) (`DATABASE_URL` — must use the absolute in-container path `file:/app/data/dev.db` — plus `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, optional `PUPPETEER_EXECUTABLE_PATH`); the staging file additionally carries `PORTAL_NETWORK`. Secrets never enter the repo — the reference compose file uses `${VAR}` placeholders.

### Operational notes

- **Real-time messages only:** messages that arrive while the session is `ready` are saved and displayed. After the client connects, the app also backfills at most the 20 most recent chats × 50 messages each (`BACKFILL_CHAT_LIMIT`/`BACKFILL_MESSAGE_LIMIT` in `lib/whatsapp.ts`); anything older is not captured.
- **Phone must be online:** the mobile device does not need to be open, but it must have an internet connection for the WhatsApp Web session to receive messages.
- Use the dashboard **New message** button to send messages to unsaved phone numbers.
- The WhatsApp session in `portal/auth/` (and `staging/auth/`) is a live credential — protect these directories.

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
