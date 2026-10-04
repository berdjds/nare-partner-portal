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
├── Caddyfile                   live Caddy config (owner-installed from
│                               deploy/portal/Caddyfile.example, bind-mounted
│                               read-only into the caddy container)
├── .env                        PORTAL_* secrets only (owner-installed, mode 0600;
│                               interpolated into the compose environment: list)
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
- The live production compose pins the app image to a dated tag
  (`portal:2026-09-30`) and the pipeline never edits that file: the deploy
  gate starts the app through a deploy-managed override
  (`portal-production.overrides.yml` next to the compose file) that pins the
  image to `portal:latest` — the candidate it just tagged — so cutover always
  runs the candidate whatever the live compose pins. After cutover the gate
  verifies the running container's image ID equals the candidate's and rolls
  back automatically otherwise.
- Caddy (container `caddy`, in the production project) terminates TLS for both
  sites and proxies to the app containers over the production project's
  compose-managed network (`portal_net`; its real name is project-prefixed,
  e.g. `stack_portal_net`, and is discovered from the running `portal-app`
  container — never hard-coded). No app port is published on the host. The
  single site config is `/opt/stack/Caddyfile`, bind-mounted read-only into
  the caddy container; there is no host-level caddy installation or config
  path. The staging site is a managed marker-delimited block inside that
  file, installed by provisioning (see below) — never edit between the
  markers by hand.
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

Run once from a repo checkout — rehearse first, then run for real:

1. **Dry run** (no root required — prints every action, changes nothing):

   ```bash
   bash deploy/provision-server.sh --pubkey-file <path-to-deploy-key.pub> --dry-run
   ```

2. **Record the before checksum** of the live Caddyfile (when it already
   exists):

   ```bash
   sha256sum /opt/stack/Caddyfile
   ```

3. **Run the real provisioning** as root:

   ```bash
   sudo bash deploy/provision-server.sh --pubkey-file <path-to-deploy-key.pub>
   ```

4. **Verify.** The script prints before/after manifests of the production
   data dirs and dies when they differ (provisioning must never touch
   production data). The Caddyfile checksum now differs from the before
   checksum by exactly the managed staging block, and exactly one marker
   pair exists:

   ```bash
   sha256sum /opt/stack/Caddyfile
   grep -c 'BEGIN staging.portal.nare.am' /opt/stack/Caddyfile   # must print 1
   ```

5. **Re-run safety.** The script is idempotent: a second run regenerates the
   staging block byte-identically (the checksum after run two equals the one
   after run one, still exactly one marker pair) and reports `[unchanged]`
   for everything already in place, so it is safe to re-apply — e.g. once the
   production stack is up, to record the production network and validate and
   activate the staging block.

It installs:

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
- the `/opt/stack` layout and the staging compose project + `.env.staging`,
- the production Docker network, discovered from the running `portal-app`
  container and recorded as `PORTAL_NETWORK` in
  `/opt/stack/staging/.env.staging` (best-effort: when the stack is not up
  yet a `[warn]` is printed and a later re-run records it),
- the managed staging site block in `/opt/stack/Caddyfile` (delimited by
  `# BEGIN/# END staging.portal.nare.am` markers): a timestamped backup
  (`Caddyfile.bak-<UTC>`) is written, the candidate is validated **inside the
  caddy container** before the live path is touched, installed in place (the
  single-file bind mount stays pinned to its inode), and caddy is reloaded
  inside the container. On a validation failure the live file is left
  untouched; on a reload failure the backup is restored and the previous
  config reloaded. Either way the backup remains for inspection. When the
  Caddyfile or the caddy container is not there yet, this step warns and is
  picked up by a later re-run.

Provisioning settings (environment overrides, used by rehearsals and the test
suite; the defaults are the live layout):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORTAL_CADDY_CONTAINER` | `caddy` | live caddy container; validation and reload run inside it via `docker exec` |
| `PORTAL_CADDYFILE` | `/opt/stack/Caddyfile` | live Caddyfile path on the host |
| `PORTAL_APP_CONTAINER` | `portal-app` | container the production network is discovered from |
| `PORTAL_NETWORK` | *(discovered)* | production Docker network the staging project joins; set only to override discovery |

Provisioning deliberately does **not** install
`/opt/stack/docker-compose.yml`, `/opt/stack/.env` or `/opt/stack/Caddyfile` —
on the live server these files already exist and are left exactly as they
are, by provisioning and by every deploy. `deploy/portal/docker-compose.yml`
in the repo is only a **reference copy** of the live layout, including its
pinned dated app image (`portal:2026-09-30` — not what a deploy runs; see
"Release flow" below) and the `environment:` list that interpolates the
`PORTAL_*` names from `/opt/stack/.env`. That `.env` file holds **only**
`PORTAL_NEXTAUTH_SECRET`, `PORTAL_ADMIN_EMAIL`, `PORTAL_ADMIN_PASSWORD` and
the `PORTAL_SMTP_*` names. After provisioning, the owner (the script prints
this checklist):

1. Leave the live files (`/opt/stack/docker-compose.yml`, `/opt/stack/.env`,
   `/opt/stack/Caddyfile`) exactly as they are.
2. Set the staging credentials in `/opt/stack/staging/.env.staging` —
   provisioning leaves them **empty on purpose** and the compose `:?` guards
   refuse to boot staging until real values are set.
3. Re-run provisioning once the production stack is up (or set
   `PORTAL_NETWORK` in `/opt/stack/staging/.env.staging` by hand) so the
   production network is recorded and the staging block is validated and
   activated.
4. Add the CI secrets and variables (below) to the repository settings.
5. Run the staging drills (below) before enabling the production release.

## CI pipeline (`.github/workflows/ci-cd.yml`)

- **Test job** — on every pull request and every push: `npm ci`, `prisma
  generate`, `tsc --noEmit`, `vitest run`, `next build`. Deploy jobs never run
  without a green test job.
- **Release chain** — on a push to `main` only: `deploy-staging` →
  `smoke-staging` → `deploy-production` → `smoke-production`. A single
  concurrency group serializes runs: **one deploy at a time**, never two
  server deploys concurrently.
- **Manual actions** — `workflow_dispatch` with a choice input `action` =
  `drill-rollback` | `drill-restore` | `deploy-staging`. The drills are
  staging only (the dispatcher enforces that again on the server);
  `deploy-staging` deploys the dispatched ref to staging only and
  smoke-tests it (see "Release rehearsal" below). Manual runs skip the test
  job — the branch's tests are the PR's responsibility — and production jobs
  never run for `workflow_dispatch`.

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
   gate asserts that **no other container** mounts the data dirs. On a **first
   deploy** (below) there is no previous image, so nothing is tagged.
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
   Caddy). The app is started through the deploy-managed override that pins
   the image to the candidate (`portal:latest`), so the dated pin in the live
   compose file never decides what runs; the gate then verifies that the
   running container's image ID equals the candidate's and treats a mismatch
   as a cutover failure (automatic rollback).
8. **On any failure after the freeze**: with `ROLLBACK_COMPATIBLE=yes` the
   candidate is stopped and `...:previous` restarted on the **current** data
   (newly accepted data is kept; nothing is restored from backup). With `no`,
   the candidate is stopped, **nothing is restored automatically**, and the
   manual recovery procedure (below) is printed.

**Deploy-tool changes ship only via provisioning.** The gate and its sibling
tools (`portal-restore`, `portal-backup`, ...) are the root-owned
`/usr/local/lib/portal-deploy/*` copies installed by
`deploy/provision-server.sh` from `scripts/*.sh`; the CI pipeline goes
through the forced-command dispatcher and can call but never replace them.
So when a release changes any of those `scripts/*.sh`, the release procedure
includes an explicit extra step in addition to the normal push-to-main
pipeline:

1. **Re-provision the tools.** After updating the checkout the tools are
   installed from (`git pull`), re-run provisioning as root:

   ```bash
   sudo bash deploy/provision-server.sh --pubkey-file <path-to-deploy-key.pub>
   ```

   The cmp-based install rewrites only the changed tools and reports
   `[unchanged]` for the rest (see "One-time provisioning"). Until this step
   runs, the pipeline keeps invoking the *old* root-owned copies, so a
   release whose fix lives in a deploy script has not actually reached the
   server.

**First deploy of a new environment.** When the app container is not running
**and** `...:latest` does not exist yet, the gate logs `FIRST DEPLOY` at the
start and adapts: no `...:previous` tag is created, trial B is skipped with
`ROLLBACK_COMPATIBLE=no`, and the verified backup, trial A and the cutover
run as usual. A stopped container whose `...:latest` exists is **not** a
first deploy — previous is tagged from `...:latest` and everything runs as
for a running app. On any post-freeze failure during a first deploy there is
nothing to roll back to: the gate stops the candidate, prints `first deploy:
nothing to roll back to; data left as the candidate wrote it` and exits 1.
The rollback drill (`portal-drill rollback`) refuses up front with a "run
deploy-staging first" message when no staging app image exists yet.

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
   docker compose -f /opt/stack/docker-compose.yml \
     -f /opt/stack/portal-production.overrides.yml up -d portal
   ```

   The override must always be included when starting production by hand: a
   plain `compose up` on the live file alone would recreate `portal-app`
   from the dated image it pins, not from `portal:latest` (which the restore
   retagged to the pre-deploy image). Note that the resume command the
   restore tool itself prints (`scripts/restore-backup.sh`) is not yet
   aligned with this and still merges only the live file.

Not covered by a restore: media added to `uploads/` after the backup (neither
exported nor restored), rows in untimestamped tables, and the WhatsApp
session, which returns to its backup-time state and may need re-pairing from
the admin panel.

## Staging

Staging is a second, fully isolated compose project (`/opt/stack/staging`,
container `portal-staging`, own data dirs and `portal-staging:*` images) at
https://staging.portal.nare.am. It joins the production project's
compose-managed network as an external network named by `PORTAL_NETWORK`
(discovered from the `portal-app` container by provisioning and recorded in
`/opt/stack/staging/.env.staging`; the staging compose `:?` guard refuses to
boot without it), so production must exist before staging starts and
`docker compose down` in staging can never tear down the shared network. The
live caddy container reverse-proxies `staging.portal.nare.am` to
`portal-staging:3000` over that network, via the managed Caddyfile block.

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

## Release rehearsal (staging deploy from any branch)

The drills need a staging deploy to have run first, but staging otherwise
only deploys on a push to `main` — so the release path cannot be rehearsed
before the merge. The manual `deploy-staging` action closes that gap: it
deploys the chosen branch to staging only and smoke-tests it, running the
exact same tarball build, upload, `deploy staging` and `smoke staging`
steps (and the same `DEPLOY_*` secrets) as the main-push `deploy-staging` /
`smoke-staging` jobs. It never touches production.

Rehearse from the Actions tab, in this order:

1. **Actions → CI/CD → Run workflow** — pick the branch to rehearse, choose
   action `deploy-staging`. A pass looks like: the job *Deploy branch to
   staging (manual)* is green; the deploy-gate output ends in the cutover
   health checks passing; both smoke steps print all checks green with no
   `FAIL` line (the CI smoke validates the public path — DNS, Caddy, TLS —
   against `$STAGING_URL`). On failure the failing step names the cause
   (smoke prints `FAIL` lines with the observed response; the deploy gate
   prints its abort reason and, post-freeze, rolls back automatically) —
   read the job log, fix the branch, re-run; see Troubleshooting below.
2. **Run workflow → `drill-rollback`** (same branch input is irrelevant;
   drills redeploy the currently deployed staging source). A pass ends with
   `DRILL PASS rollback` and exit 0. If it fails with
   `DRILL FAIL rollback: source tarball not found … a staging deploy must
   run first`, step 1 did not complete — run it again.
3. **Run workflow → `drill-restore`**. A pass ends with `DRILL PASS
   restore` and exit 0.

A failing drill prints `DRILL FAIL <name>: <reason>` and exits 1; the job
log shows the reason. Do not merge the rehearsed branch until all three
actions pass in sequence — the rehearsal is the proof that the release
path (deploy gate, automatic rollback, restore) works before it is trusted
with production.

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
- **Deploy refuses: "compose file not found"** — the live
  `/opt/stack/docker-compose.yml` is owner-managed and the gate never
  creates, syncs or modifies it; restore it from the owner's copy (the
  repo mirrors the live layout in `deploy/portal/docker-compose.yml` for
  reference only).
- **Compose fails with "PORTAL_* must be set"** — a required secret is missing
  from `/opt/stack/.env` (production) or `/opt/stack/staging/.env.staging`
  (staging). The `:?` guards are deliberate.
- **Trial A failed** — read the trial container's log on the server
  (`docker logs portal-trial-a` before the gate cleans up, or the gate output
  in the CI log): usually a failed `prisma db push` or seed. The old container
  was restarted on the untouched data; fix forward.
- **Public health check failed after cutover** — the app answers internally
  but not through Caddy: check DNS, `/opt/stack/Caddyfile` and
  `docker logs caddy`. With `ROLLBACK_COMPATIBLE=yes` the gate has already
  rolled back.
- **Staging site 502s** — staging joins the production network named by
  `PORTAL_NETWORK`; if the production project is down (`docker compose down`
  in `/opt/stack`), staging is unreachable. Bring production up first.
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

## Production uptime monitor

`.github/workflows/uptime.yml` runs `scripts/uptime-check.sh` against `PORTAL_URL` every 10 minutes (GitHub may delay scheduled runs by a few minutes). It is read-only: anonymous GET requests only. Checks: the landing page, the sign-in page and its JavaScript assets, the application page with its per-request form token (catches a page prerendered at build time), the legal pages, the anonymous API gate (401) and the TLS certificate (at least 14 days left); each request is retried twice.

Alerts go to the owner's phone through ntfy on a change of state (failing, a reminder about every two hours, recovered); passing runs are silent. The workflow needs the repository secret `NTFY_TOPIC` (the topic name); without it the run still turns red and GitHub's own failure emails still apply. Run it by hand from Actions → Uptime monitor → Run workflow, or locally: `bash scripts/uptime-check.sh https://portal.nare.am`.
