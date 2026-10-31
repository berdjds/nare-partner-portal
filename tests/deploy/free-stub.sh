#!/usr/bin/env bash
# Test double for `free`, used by the dev deploy resource-guard tests.
printf '               total        used        free      shared  buff/cache   available\n'
printf 'Mem: %s 0 0 0 0 %s\n' "${STUB_MEM_TOTAL:-1000}" "${STUB_MEM_AVAILABLE:-500}"
