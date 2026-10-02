# Deployment

Release path for the portal at **https://portal.nare.am** (staging:
**https://staging.portal.nare.am**).

## Important disclaimer

WhatsApp Web automation through `whatsapp-web.js` is not an official WhatsApp
API. Using it may violate WhatsApp's Terms of Service and can result in
account restrictions or bans. For production workloads, consider the official
[WhatsApp Business Platform / Cloud API](https://business.whatsapp.com/products/business-platform).

## Overview

The owner provisions the server **once** (`deploy/provision-server.sh`). After
that, a push to `main` runs the whole release from CI with no manual server
steps:

```
test job → deploy staging → smoke staging → deploy production → smoke production
```

CI never gets a shell on the server. Every server-side action goes through a
forced-command dispatcher (`/usr/local/sbin/portal-deploy-entry`) installed by
provisioning, so the pipeline can only call the operations below — it cannot
change the tools, the compose files, or anything else on the server.

## Server architecture (fixed layout)

```
/opt/stack/
├── docker-compose.yml          production project: caddy + portal (owner-installed,
│                               NEVER created or modified by a deploy)
├── .env                        PORTAL_* secrets (owner-installed, mode 0600)
├── portal/
│   ├── src/                    build context (source tarball extracted by the deploy gate)
│   ├── data/                   SQLite database (dev.db)
│   ├── uploads/                message media (container /app/public/uploads)
│   └── auth/                   WhatsApp session (container /app/.wwebjs_auth)
├── backups/                    deploy-gate + scheduled backup archives
└── staging/                    SECOND compose project (fully isolated)
    ├── docker-compose.yml      staging project (installed by provisioning)
    ├── .env.staging            staging secrets (-> .env symlink; owner fills in)
    ├── portal/{src,data,uploads,auth}/
    └── backups/
```

- App service `portal`, container `portal-app` (production) and
  `portal-staging` (staging).
- Images: `portal:candidate` / `portal:previous` / `portal:latest`
  (production) and `portal-staging:*` (staging). The tags are per-environment
  so a staging deploy can never move a production tag.
- Caddy (`portal-caddy`, in the production project) terminates TLS for both
  sites and proxies to the app containers over the shared `portal-web` docker
  network. No app port is published on the host. Site configs live in
  `/etc/caddy/` (`Caddyfile` + `staging.portal.nare.am.caddy`, both
  provisioning artifacts — see `deploy/portal/Caddyfile.example`).
- The compose files belong to provisioning: the deploy gate **refuses** to run
  when the compose file is missing and never creates, syncs or modifies it.

The repo-root `docker-compose.yml` is **development only** (local all-in-one,
app published on `127.0.0.1:3000`). The production and staging projects are
documented in `deploy/portal/docker-compose.yml`,
`deploy/portal/Caddyfile.example` and `deploy/staging/docker-compose.yml`.

## One-time provisioning (owner)

Prerequisites on the server: Docker with the compose plugin, DNS for
`portal.nare.am` and `staging.portal.nare.am` pointing at the host, and a
dedicated SSH keypair for CI (the public key is the provisioning input).

Run once from a repo checkout, as root:

```bash
sudo deploy/provision-server.sh --pubkey-file <path-to-deploy-key.pub>
# rehearse first with: deploy/provision-server.sh --pubkey-file <path> --dry-run
```

The script is idempotent (re-running converges the server) and proves it never
touched production data with before/after manifests of the data dirs. It
installs:

- `sqlite3` (apt) — needed for consistent live-database backups,
- the `deploy` user: **no password, not in the docker group**, login shell
  `/bin/sh` (so sshd can run the forced command; interactive access is still
  impossible). Its `authorized_keys` pins the CI key to
  `command="/usr/local/sbin/portal-deploy-entry",no-port-forwarding,no-agent-forwarding,no-pty,no-X11-forwarding`,
- the dispatcher's tool library under `/usr/local/lib/portal-deploy/`
  (`portal-deploy`, `portal-restore`, `portal-export`, `portal-backup`,
  `portal-smoke`, `portal-drill`) from the `scripts/*.sh` sources —
  root-owned, so the pipeline can call but never modify them (`portal-drill`
  is skipped with a `[warn]` only when `scripts/portal-drill.sh` is missing
  from the provisioned source),
- `/usr/local/sbin/portal-deploy-entry` (the dispatcher) and the sudoers
  drop-in `/etc/sudoers.d/portal-deploy` granting the deploy user **only**
  that dispatcher as root (validated with `visudo` before install),
- the daily backup units (`deploy/systemd/portal-backup.{service,timer}`) and
  `/etc/portal-backup.env`,
- the `/opt/stack` layout, the staging compose project + `.env.staging`, and
  the staging Caddy site with its import wiring.

Provisioning deliberately does **not** install
`/opt/stack/docker-compose.yml`, `/opt/stack/.env` or `/etc/caddy/Caddyfile`.
After provisioning, the owner (the script prints this checklist):

1. `install -m 0644 deploy/portal/docker-compose.yml /opt/stack/docker-compose.yml`
2. Create `/opt/stack/.env` (mode 0600) with the real `PORTAL_*` secrets
   (`PORTAL_NEXTAUTH_SECRET`, `PORTAL_ADMIN_EMAIL`, `PORTAL_ADMIN_PASSWORD`,
   optional `PORTAL_SMTP_HOST/PORT/USER/PASS/FROM` for travel-module e-mail).
   Required values use `${VAR:?}` interpolation, so a missing secret fails
   loudly instead of booting the app with an empty one.
3. Set the staging credentials in `/opt/stack/staging/.env.staging` —
   provisioning leaves them **empty on purpose** and the compose `:?` guards
   refuse to boot staging until real values are set.
4. Install `/etc/caddy/Caddyfile` from `deploy/portal/Caddyfile.example`,
   re-run provisioning (or append the import line) to wire the staging site,
   and reload Caddy.
5. Add the CI secrets and variables (below) to the repository settings.
6. Run the staging drills (below) before enabling the production release.

## CI pipeline (`.github/workflows/ci-cd.yml`)

- **Test job** — on every pull request and every push: `npm ci`, `prisma
  generate`, `tsc --noEmit`, `vitest run`, `next build`. Deploy jobs never run
  without a green test job.
- **Release chain** — on a push to `main` only: `deploy-staging` →
  `smoke-staging` → `deploy-production` → `smoke-production`. A single
  concurrency group serializes runs: **one deploy at a time**, never two
  server deploys concurrently.
- **Drills** — `workflow_dispatch` with a choice input `action` =
  `drill-rollback` | `drill-restore` (staging only; the dispatcher enforces
  that again on the server).

Repository configuration:

| Kind | Name | Purpose |
|------|------|---------|
| secret | `DEPLOY_HOST` | server hostname |
| secret | `DEPLOY_USER` | the restricted deploy user (`deploy`) |
| secret | `DEPLOY_SSH_KEY` | private key of the dedicated CI keypair |
| secret | `DEPLOY_KNOWN_HOSTS` | the server's **pinned** host key (provisioned out of band; no `ssh-keyscan` at deploy time) |
| variable | `PORTAL_URL` | `https://portal.nare.am` |
| variable | `STAGING_URL` | `https://staging.portal.nare.am` |

## Forced-command interface

The dispatcher (`deploy/portal-deploy-entry.sh`, installed as
`/usr/local/sbin/portal-deploy-entry`) is the only thing the deploy key can
run. It validates the client-supplied `SSH_ORIGINAL_COMMAND` twice (once as
the deploy user, once again as root after the pinned sudo re-invocation) and
charset-whitelists every argument. Accepted commands — everything else is
rejected:

| Command | Effect |
|---------|--------|
| `upload <name.tar.gz>` | writes the tarball streamed over ssh stdin to the deploy user's upload dir (the pipeline's file-transfer path; scp/sftp cannot pass a forced command) |
| `deploy <env> <tarball>` | runs the deploy gate; `<env>` = `staging` or `production` |
| `smoke <env>` | runs the smoke test against the env's pinned public URL |
| `backup` | runs the scheduled-backup tool on demand |
| `restore <archive>` | restore on **staging** |
| `restore --production <archive>` | restore on production |
| `drill-rollback` / `drill-restore` | staging drills only |

## Release flow (what `deploy <env>` does)

`scripts/vps-deploy.sh`, installed as `portal-deploy`, runs on the server,
identically for staging and production:

1. **Extract + build**: the source tarball is extracted to the build context
   (`portal/src/`) and `portal:<env-prefix>:candidate` is built **while the
   app keeps serving**.
2. The running image is tagged `...:previous` (the rollback target), and the
   gate asserts that **no other container** mounts the data dirs.
3. **WRITE FREEZE**: the app container is stopped — HTTP writes, the
   in-process WhatsApp client, the notification outbox worker and all
   background jobs stop with it. Freeze start/end are logged with UTC
   timestamps.
4. **Verified backup** of the three data dirs to
   `backups/portal-<env>-<UTC>.tar.gz` + `.sha256` sidecar, verified with
   `tar -tzf`, pruned to `PORTAL_BACKUP_KEEP_DAYS` (default 14). A backup
   failure aborts the deploy and restarts the old container on the untouched
   data.
5. **Trial A**: the candidate runs in trial mode (`WACONTROL_MODE=trial`: no
   WhatsApp client, no background jobs, no auth dir, localhost-only) on a
   **copy** of the data. Its entrypoint applies `prisma db push` (never
   `--accept-data-loss`), bootstrap seeds run, and `/login` must answer 200
   inside the container. Failure → trial removed, old container restarted on
   the untouched data, exit 1.
6. **Trial B**: the *previous* image runs in trial mode on the **migrated**
   copy. Its health check decides `ROLLBACK_COMPATIBLE=yes|no` (`yes` also
   when the schema did not change) — it proves whether the previous image can
   still serve the new schema, nothing else.
7. **Cutover**: the candidate is tagged `...:latest` and started on the real
   data. Internal health check (`/login` 200 inside the container), bootstrap
   seeds, then the **public** health check (`$PUBLIC_URL/login` 200 through
   Caddy).
8. **On any failure after the freeze**: with `ROLLBACK_COMPATIBLE=yes` the
   candidate is stopped and `...:previous` restarted on the **current** data
   (newly accepted data is kept; nothing is restored from backup). With `no`,
   the candidate is stopped, **nothing is restored automatically**, and the
   manual recovery procedure (below) is printed.

**Seeds are bootstrap-only.** The gate runs `npm run db:seed` and
`scripts/seed-travel-catalog.ts` in trial A and after cutover; both self-skip
when data exists, so operator edits survive deployments. To reseed the catalog
deliberately: `SEED_FORCE=true npx tsx scripts/seed-travel-catalog.ts` inside
the container.

**Inbound WhatsApp during the freeze.** While the container is stopped the
WhatsApp Web session is offline: incoming messages are not received and are
not queued. After reconnect the app captures live events plus a bounded
backfill (at most 20 chats × 50 messages, `lib/whatsapp.ts`); anything older
or received while offline is only visible if WhatsApp Web surfaces it inside
that window. Budget customer communication around deploys.

## Rollback

- **Automatic** (post-cutover failure, `ROLLBACK_COMPATIBLE=yes`): the
  previous image restarts on the current data. No operator action.
- **Manual** (`ROLLBACK_COMPATIBLE=no`): the candidate migrated the database,
  so the previous image must NOT be restarted against it (its entrypoint
  `db push` against a newer schema can destroy data). Use the restore runbook
  below — or fix forward: land the fix and push; the gate freezes, backs up
  the *current* data and re-gates the deploy.

## Restore (manual recovery)

Tools: `portal-export` (`scripts/export-since.sh`) and `portal-restore`
(`scripts/restore-backup.sh`), both installed under
`/usr/local/lib/portal-deploy/`. A restore overwrites the live data dirs, so
the post-backup rows must be preserved first:

1. **export-since** — the owner runs the export tool on the server against the
   backup archive (the app is stopped, so the snapshot is consistent):

   ```bash
   /usr/local/lib/portal-deploy/portal-export \
     /opt/stack/backups/portal-production-<stamp>.tar.gz
   ```

   It reads the database **read-only** (snapshot copy including WAL sidecars)
   and writes `<archive>.export.json` next to the archive: every row with
   `createdAt`/`updatedAt` at or after the backup timestamp, from every
   timestamped table (discovered dynamically). Tables without those columns
   are listed under `skippedTables` and must be re-created manually.

2. **restore-backup** — through the dispatcher:

   ```
   restore /opt/stack/backups/portal-production-<stamp>.tar.gz            # staging
   restore --production /opt/stack/backups/portal-<stamp>.tar.gz          # production
   ```

   The dispatcher's invocation **is** the operator's `--yes` acknowledgement.
   The restore tool verifies the sha256 sidecar, **refuses unless the
   export-since output exists** for this archive (the dispatcher never passes
   `--no-export-ack`), validates the archive members (only the three data dir
   trees), checks the restore image exists (`portal:previous` /
   `portal-staging:previous` — the pre-deploy image matching the backup's
   schema, **never** the failed candidate), stops the app, replaces exactly
   the three data dirs, and restarts the app with
   `WACONTROL_NOTIFICATIONS_PAUSED=1` (override file
   `portal-restore-paused.compose.yml` next to the compose file) so outbox
   entries reverted by the restore are not re-sent. It health-checks `/login`
   inside the container and prints the review/resume instructions.

3. **Resume notifications** after reviewing the export and the paused outbox
   (re-applying rows is manual — no automatic merge exists):

   ```bash
   rm /opt/stack/portal-restore-paused.compose.yml
   docker compose -f /opt/stack/docker-compose.yml up -d portal
   ```

Not covered by a restore: media added to `uploads/` after the backup (neither
exported nor restored), rows in untimestamped tables, and the WhatsApp
session, which returns to its backup-time state and may need re-pairing from
the admin panel.

## Staging

Staging is a second, fully isolated compose project (`/opt/stack/staging`,
container `portal-staging`, own data dirs and `portal-staging:*` images) at
https://staging.portal.nare.am. It joins the production project's `portal-web`
network as an external network, so production must exist before staging
starts and `docker compose down` in staging can never tear down the shared
network.

- **WhatsApp is always disabled**: `WHATSAPP_DISABLED=1` defaults in the
  staging compose file *and* the deploy gate merges its own override file
  (`portal-staging.overrides.yml`) into every staging start — including
  rollbacks and restores. A staging instance must never attach to the live
  WhatsApp session (WhatsApp Web allows only one active web session).
- **E-mail goes to a sink** via the `PORTAL_SMTP_*` values in
  `/opt/stack/staging/.env.staging`, never to real customers.
- Staging accepts production backup archives through `restore <archive>`, which
  is why its credentials are provisioned empty and must be set deliberately.

## Drills

The drill tool (`scripts/portal-drill.sh`, installed as
`/usr/local/lib/portal-deploy/portal-drill`) proves the staging rollback and
restore paths end to end. Run the drills before the production release is
enabled, and periodically afterwards (Actions → CI/CD → Run workflow → pick
the action):

- `drill-rollback` — deploys staging through the deploy gate with the drill
  hook (`PORTAL_DRILL_FAIL_HEALTH=1`, honoured only when the target env is
  staging) so the post-cutover health check fails on purpose, then verifies
  the automatic rollback: the container runs the previous image, `/login`
  answers HTTP 200 inside it, and the staging data dirs are byte-for-byte
  unchanged. The drill redeploys the currently deployed staging source: the
  drill job uploads no tarball (the pipeline's tarball is deleted by the
  deploy gate after extraction), so the drill rebuilds
  `portal-source.tar.gz` from the staging build context
  (`/opt/stack/staging/portal/src`) left by the last staging deploy. At least
  one staging deploy must have run first; with neither a pending tarball nor
  a build context the drill fails with `DRILL FAIL rollback: source tarball
  not found … a staging deploy must run first`.
- `drill-restore` — takes a verified staging backup, plants a marker file,
  restores the backup with the restore tool, then verifies the marker is
  gone, the data matches the backup byte for byte, and the staging app is
  healthy.

A passing run ends with `DRILL PASS rollback` (or `DRILL PASS restore`) and
exits 0; a failing run prints `DRILL FAIL <name>: <reason>` and exits 1.
Both are staging-only: the dispatcher takes no environment argument for them
and always runs the drill with `PORTAL_ENV_NAME=staging`, and the drill
itself refuses to run unless `PORTAL_ENV_NAME` is exactly `staging` and
every data path resolves inside the staging root (symlinks pointing outside
are rejected). The drills are covered by `tests/deploy/drill.test.ts`.

## Backups and retention

Two independent mechanisms, never interfering (each archives and prunes only
its own file prefix):

- **Deploy-gate backups** — `backups/portal-<env>-<UTC>.tar.gz`, taken after
  the write freeze on every deploy (see above).
- **Scheduled backups** — `scripts/portal-backup.sh`, installed as
  `portal-backup`, run daily at 03:30 local by
  `deploy/systemd/portal-backup.timer` (`Persistent=true`, so a missed run
  catches up) and on demand via the dispatcher's `backup` command. It takes a
  **consistent** database snapshot with `sqlite3 <db> ".backup ..."` for every
  `*.db` in the data dir (safe while the app keeps writing — a raw file copy
  of a live SQLite db is not), tars the data / uploads / auth trees (auth
  excludes the regenerable Chromium profile caches), verifies the archive
  (readable listing containing all three trees plus at least one `.db`, and
  `sha256sum -c` on the sidecar) as
  `backups/portal-backup-<UTC>.tar.gz`, and only then prunes
  `portal-backup-*` archives older than `PORTAL_BACKUP_KEEP_DAYS` — so a
  failed run can never cost the last verified backup. On any failure the
  partial archive is removed, nothing is pruned, exit 1.

Settings live in `/etc/portal-backup.env` (root-owned, 0600):

```bash
PORTAL_BACKUP_KEEP_DAYS=14                       # retention, days
#PORTAL_OFFSITE_HOOK=/usr/local/bin/portal-offsite  # optional; run as `<hook> <archive>`
```

`PORTAL_OFFSITE_HOOK` receives the verified archive path for an off-server
copy; a hook failure is a warning, never an error.

## Smoke tests

`scripts/smoke-test.sh <base-url>` (installed as `portal-smoke`, dependency:
curl) runs after every deploy — on the server via `smoke <env>` and again from
the CI runner against the public URL (validating DNS, Caddy and TLS, not only
the server's own vantage). Checks:

1. `GET /login` returns 200.
2. `GET /api/whatsapp/status`, `/api/chats`, `/api/permissions`, `/api/users`
   and `/uploads/x.jpg` each return **401** anonymously.
3. A Socket.io handshake with a foreign `Origin` is refused with **403**.
4. A handshake with the site's own `Origin` but no session cookie opens at the
   engine.io level, then the namespace connect is refused with `unauthorized`.

Every failure prints a `FAIL` line with the observed response, a summary is
printed at the end, and any failure exits non-zero — failing the pipeline
stage. `SMOKE_CURL_MAX_TIME` overrides the per-request timeout (default 15s).

## Troubleshooting

- **`deploy` rejected by the dispatcher** — the command line failed validation:
  only the exact commands above, `<env>` must be `staging`/`production`, paths
  must match `[A-Za-z0-9._/-]`, end in `.tar.gz`, contain no `..`, and an
  upload name must be a bare file name. The rejection reason is printed on
  stderr.
- **Deploy refuses: "compose file not found"** — provisioning step 1 was
  skipped; install `/opt/stack/docker-compose.yml` from
  `deploy/portal/docker-compose.yml`. The gate never creates it.
- **Compose fails with "PORTAL_* must be set"** — a required secret is missing
  from `/opt/stack/.env` (production) or `/opt/stack/staging/.env.staging`
  (staging). The `:?` guards are deliberate.
- **Trial A failed** — read the trial container's log on the server
  (`docker logs portal-trial-a` before the gate cleans up, or the gate output
  in the CI log): usually a failed `prisma db push` or seed. The old container
  was restarted on the untouched data; fix forward.
- **Public health check failed after cutover** — the app answers internally
  but not through Caddy: check DNS, the Caddyfile and `docker logs
  portal-caddy`. With `ROLLBACK_COMPATIBLE=yes` the gate has already rolled
  back.
- **Staging site 502s** — staging joins the production `portal-web` network;
  if the production project is down (`docker compose down` in `/opt/stack`),
  staging is unreachable. Bring production up first.
- **Backup timer did not run** — `systemctl list-timers portal-backup.timer`
  and `journalctl -u portal-backup.service`; `Persistent=true` catches up
  after downtime.
- **WhatsApp session logged out after a restore** — expected when WhatsApp
  invalidated the backup-time session; re-pair from the admin panel.
- **Provisioning rehearsal** — `--dry-run` prints every action without changing
  anything; `PORTAL_PROVISION_ROOT` prefixes every absolute target path for
  tests.

## Scaling notes

The WhatsApp client is an in-memory singleton (`lib/whatsapp.ts`): the app is
designed for a single server instance. Horizontal scaling would require
externalizing the WhatsApp session state and message queue.

## WhatsApp business accounts (W3)

WAControl runs two WhatsApp business accounts, each with its own
`whatsapp-web.js` client and LocalAuth session:

| Key | Display name | Purpose | Shipped state | Session directory |
|-----|--------------|---------|---------------|-------------------|
| `marhaba` | Marhaba Armenia | `INBOX` (the chat inbox) | Enabled | `.wwebjs_auth/session/` (legacy, no LocalAuth clientId) |
| `nare` | Nare Travel and Tours | `TRAVEL` (travel-module sends) | **Disabled** | `.wwebjs_auth/session-nare/` (LocalAuth clientId `nare`) |

The rows are created idempotently by `ensureDefaultAccounts()`
(`lib/whatsapp-accounts.ts`, called from `prisma/seed.ts`); it never modifies an
existing row, so owner configuration survives every deploy. On an existing
deployment the two rows are simply inserted, and pre-existing chats, messages
and notification deliveries are backfilled to `accountId = 'marhaba'` by the
schema column defaults. **Releasing W3 changes nothing for the live Marhaba
account**: Nare ships disabled and no client is created for it until the owner
enables it.

Both session directories live under `.wwebjs_auth/`, which the `portal/auth` folder
mounts in full (`./portal/auth:/app/.wwebjs_auth`, i.e. /opt/stack/portal/auth), so both sessions
persist across container restarts and are covered by the deploy backup and the daily backup of the auth dir. The Marhaba session is never disconnected,
re-linked or reused by the Nare pairing flow.

### Runbook: enabling and pairing Nare after the release

1. Open the admin panel → **Accounts** tab → the **Nare Travel and Tours** card.
2. Tick **Enabled**, then click **Connect**. The pairing QR appears on the card
   (the full WhatsApp state with the QR is admin-only).
3. On the Nare business phone: WhatsApp → Linked devices → Link a device, and
   scan the QR.
4. On `ready` the connected number is read from the linked session itself and
   shown on the card as the account's verified number
   (`WhatsAppAccount.verifiedNumber`).
5. Publish the public number via the accounts **Configure** action (the
   `displayName` / `publicNumber` / `enabled` fields of
   `POST /api/whatsapp/accounts`). `publicNumber` is the contact number frozen
   onto client quotation PDFs at submit time.

The on-disk session is preserved when the account is disabled, so re-enabling
and clicking Connect resumes without a new pairing; a fresh QR is only needed
after an actual logout.

### Resource note

Each enabled account runs its own headless Chromium (Puppeteer) instance, so
enabling Nare roughly doubles the WhatsApp browser memory footprint of the
container. The production server has ample RAM (47 GiB, checked 2026-09-30); check it again before adding more accounts.

### Startup and permissions

At startup `server.ts` calls `initializeWhatsAppAccounts()`, which boots every
**enabled** account via `Promise.allSettled` — one account failing to start
never affects the other. The `scripts/patch-wwebjs.js` runtime patches still
apply at container start (`docker-entrypoint.sh`).

Nare's permission keys `whatsapp.nare.view` / `whatsapp.nare.send` /
`whatsapp.nare.admin` are ADMIN-only by default; grant them to other users via
per-user permission overrides in the admin users panel. Marhaba's keys are
unchanged (`whatsapp.inbox.view` / `whatsapp.inbox.send`, `whatsapp.admin`).

### Travel send routing

All travel-module WhatsApp sends (client documents, notifications) go through
the account named by `TravelSettings.whatsappAccountKey` (default `nare`). If
that account is disabled or its client is not ready, the send fails with a
coded, actionable error naming the account and is retried later on the **same**
account — there is never a silent fallback to Marhaba. The account is part of
the notification dedup key, so retries cannot duplicate a delivery.
