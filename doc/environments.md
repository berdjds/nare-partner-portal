# Portal environments

The portal has three separate server environments. Dev and staging are
isolated Compose projects with their own data directories, secrets and image
tags; they do not share application data with production.

| Environment | Public URL | Server directory | Containers | Application memory limit |
|-------------|------------|------------------|------------|--------------------------|
| Development | https://dev.portal.nare.am | `/opt/stack/dev` | `portal-dev` | 1 GiB (`mem_limit: 1g`) |
| Staging | https://staging.portal.nare.am | `/opt/stack/staging` | `portal-staging` | Not configured |
| Production | https://portal.nare.am | `/opt/stack` | `portal-app`, `caddy` (reverse proxy) | Not configured |

## Data and integrations

**Dev and staging hold test data only.** Do not use either environment for
live customer data or as a source of truth. Production holds the live portal
data.

WhatsApp is disabled outside production. Dev and staging set
`WHATSAPP_DISABLED=1`, and their deploy overrides keep the WhatsApp client
disabled on every start. Their outbound mail is directed to a mail sink rather
than real customers.

A password gate for dev or staging is a later, separate step; it is not part
of the current environment setup.

## Deploy a branch to dev

Dev deployment is manual and does not run automatically on a push:

1. Open **Actions → CI/CD → Run workflow** in the repository.
2. In **Use workflow from**, select the branch to deploy.
3. Select the **`deploy-dev`** action and run the workflow.

The action packages the dispatched ref, deploys it to dev through the existing
forced-command interface, then runs both the server smoke test and the public
smoke test against https://dev.portal.nare.am. It does not deploy to staging or
production.

## Configure dev secrets on the server

Provisioning creates `/opt/stack/dev/.env.dev` with empty required credentials
and a guarded Compose configuration that refuses to start until they are
filled. It also links `/opt/stack/dev/.env` to that file so Compose reads the
same settings.

The owner edits `/opt/stack/dev/.env.dev` directly on the server and:

- fills `PORTAL_NEXTAUTH_SECRET`, `PORTAL_ADMIN_EMAIL` and
  `PORTAL_ADMIN_PASSWORD` with dev-only values;
- configures the `PORTAL_SMTP_*` settings for the dev mail sink;
- preserves the provisioned `PORTAL_NETWORK` setting and leaves
  `WHATSAPP_DISABLED=1` enabled.

Keep the file restricted to the owner, never commit it, and do not copy its
values into documentation, tickets or workflow logs. Once it is configured,
use the `deploy-dev` action above to start or update dev.
