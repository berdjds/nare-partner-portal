#!/usr/bin/env bash
# Test double for the docker CLI, used by tests/deploy/vps-deploy.test.ts.
# Every invocation is appended to $STUB_LOG (one line, space-joined args);
# behavior is driven by STUB_* environment variables:
#   STUB_FAIL_BUILD=1          `docker build` exits 1
#   STUB_CONTAINER_MISSING=1   `docker inspect <name>` / `docker image inspect
#                              <ref>` (no -f) exits 1
#   STUB_INSPECT_RUNNING=false the app container is not running
#   STUB_INSPECT_IMAGE=<ref>   image ref of the app container
#   STUB_APP_ID=<id>           id of the app container
#   STUB_PS_IDS="<ids...>"     output of `docker ps -q`
#   STUB_APP_SHORT_ID=<id>    abbreviated app id from default `docker ps -q`
#   STUB_APP_MOUNTS=<paths>   mounts returned when inspecting that short id
#   STUB_OTHER_ID=<id>         id of another running container
#   STUB_OTHER_MOUNTS=<paths>  mount sources of that container (one per line)
#   STUB_FAIL_EXEC_ON="<c>:<substr> ..."
#                              `docker exec` fails when the container name
#                              contains <c> and the args contain <substr>
#   STUB_FAIL_FIRST="<c>:<substr>:<n> ..."
#                              same, but only the first n invocations fail
# No `set -e` here on purpose: `&&`/`||` chains drive the scripted failures.

printf '%s\n' "$*" >> "${STUB_LOG:?STUB_LOG is required}"

cmd="${1:-}"
if [ -n "$cmd" ]; then
  shift
fi

# `docker image inspect <ref>` is the image-only form of `docker inspect`;
# both feed the inspect handling below.
if [ "$cmd" = "image" ] && [ "${1:-}" = "inspect" ]; then
  cmd="inspect"
  shift
fi

case "$cmd" in
  build)
    if [ -n "${STUB_FAIL_BUILD:-}" ]; then
      exit 1
    fi
    exit 0
    ;;
  ps)
    if [ "${1:-}" = "-q" ]; then
      # Intentional word splitting: STUB_PS_IDS holds one id per word.
      if [ "${2:-}" = "--no-trunc" ]; then
        printf '%s\n' ${STUB_PS_FULL_IDS:-${STUB_PS_IDS:-${STUB_APP_ID:-aaa111}}}
      else
        printf '%s\n' ${STUB_PS_IDS:-${STUB_APP_SHORT_ID:-${STUB_APP_ID:-aaa111}}}
      fi
    fi
    exit 0
    ;;
  inspect)
    if [ "${1:-}" = "-f" ]; then
      fmt="$2"
      target="$3"
      case "$fmt" in
        *State.Running*)
          printf '%s\n' "${STUB_INSPECT_RUNNING:-true}"
          ;;
        *Config.Image*)
          printf '%s\n' "${STUB_INSPECT_IMAGE:-wacontrol:latest}"
          ;;
        *'.Id'*)
          printf '%s\n' "${STUB_APP_ID:-aaa111}"
          ;;
        *Mounts*)
          if [ "$target" = "${STUB_OTHER_ID:-}" ]; then
            printf '%s\n' "${STUB_OTHER_MOUNTS:-}"
          elif [ -n "${STUB_APP_SHORT_ID:-}" ] && [ "$target" = "$STUB_APP_SHORT_ID" ]; then
            printf '%s\n' "${STUB_APP_MOUNTS:-}"
          fi
          ;;
      esac
      exit 0
    fi
    if [ -n "${STUB_CONTAINER_MISSING:-}" ]; then
      exit 1
    fi
    exit 0
    ;;
  exec)
    target="${1:-}"
    if [ "$#" -gt 0 ]; then
      shift
    fi
    joined="$*"
    for spec in ${STUB_FAIL_EXEC_ON:-}; do
      c="${spec%%:*}"
      pat="${spec#*:}"
      case "$target" in
        *"$c"*) ;;
        *)
          continue
          ;;
      esac
      case "$joined" in
        *"$pat"*)
          exit 1
          ;;
      esac
    done
    for spec in ${STUB_FAIL_FIRST:-}; do
      c="${spec%%:*}"
      rest="${spec#*:}"
      pat="${rest%:*}"
      n="${rest##*:}"
      case "$target" in
        *"$c"*) ;;
        *)
          continue
          ;;
      esac
      case "$joined" in
        *"$pat"*)
          key="$(printf '%s_%s' "$target" "$pat" | tr -c 'A-Za-z0-9' '_')"
          mkdir -p "${STUB_STATE_DIR:?STUB_STATE_DIR is required}"
          count_file="$STUB_STATE_DIR/$key"
          count=0
          if [ -f "$count_file" ]; then
            count="$(cat "$count_file")"
          fi
          count=$((count + 1))
          printf '%s' "$count" > "$count_file"
          if [ "$count" -le "$n" ]; then
            exit 1
          fi
          ;;
      esac
    done
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
