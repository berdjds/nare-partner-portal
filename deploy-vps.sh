#!/usr/bin/env bash
# HISTORY NOTE — legacy manual deploy script, retired.
#
# This was the VPS variant of the old manual release path (an identical copy
# of deploy.sh): package the source locally, copy it to the VPS over ssh and
# restart the container by hand. That path was replaced by the CI-driven
# release that goes through the restricted `deploy` user and the
# forced-command dispatcher on the server (see doc/deployment.md). The
# original script body was removed; this stub remains only as a clearly
# marked history note and fails loudly if a stale checkout tries to run it.

echo "ERROR: deploy-vps.sh is retired. The release path is CI-driven; see doc/deployment.md." >&2
exit 1
