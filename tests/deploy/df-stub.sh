#!/usr/bin/env bash
# Test double for `df -P`, used by the dev deploy resource-guard tests.
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'portal %s 0 %s 0%% /\n' "${STUB_DISK_TOTAL:-1000}" "${STUB_DISK_AVAILABLE:-500}"
