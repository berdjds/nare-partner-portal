# HISTORY NOTE — legacy VPS compose service block, retired

This document described the old manual deployment: a compose service block to
paste by hand into the VPS compose file, fronted by a reverse proxy with
host-based routing. That release path was retired.

The current deployment is documented in [deployment.md](./deployment.md):

- the production compose project (`caddy` + `portal`) lives at
  `/opt/stack/docker-compose.yml` on the server, installed once by the owner
  from `deploy/portal/docker-compose.yml` and never modified by a deploy,
- releases are driven by CI through the restricted `deploy` user and the
  forced-command dispatcher (`deploy/portal-deploy-entry.sh`),
- TLS is terminated by Caddy (`deploy/portal/Caddyfile.example`), and staging
  is a second, isolated compose project under `/opt/stack/staging`.

The original service block was removed; this page remains only as a clearly
marked history note.
