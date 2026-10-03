#!/usr/bin/env bash
# Test double for the docker CLI, used by tests/deploy/vps-deploy.test.ts.
# Every invocation is appended to $STUB_LOG (one line, space-joined args);
# behavior is driven by STUB_* environment variables:
#   STUB_FAIL_BUILD=1          `docker build` exits 1
#   STUB_CONTAINER_MISSING=1   `docker inspect <name>` / `docker image inspect
#                              <ref>` (no -f) exits 1
#   STUB_IMAGE_MISSING="<refs...>"
#                              `docker image inspect <ref>` (no -f) exits 1 for
#                              each listed ref only — a brand-new environment
#                              where e.g. portal:latest does not exist yet
#   STUB_INSPECT_RUNNING=false the app container is not running
#   STUB_INSPECT_IMAGE=<ref>   image ref of the app container
#   STUB_APP_ID=<id>           id of the app container
#   STUB_CONTAINER_IMAGE_ID=<id>
#                              image id of the PRE-EXISTING app container
#                              (`docker inspect -f '{{.Image}}'` before any
#                              compose up this run recreated it); default
#                              sha256:pre-existing — deliberately NOT the
#                              candidate id, so a missing --force-recreate is
#                              caught by the post-cutover image check
#   STUB_CANDIDATE_IMAGE_ID=<id>
#                              id of the candidate image (`docker image inspect
#                              -f '{{.Id}}' <ref>`; also the id `docker build
#                              -t <ref>` records); default sha256:candidate
#   STUB_COMPOSE_IGNORE_RECREATE=1
#                              `compose up` ignores --force-recreate and keeps
#                              an existing container whose image reference is
#                              unchanged — simulates a compose that does not
#                              recreate, so the post-cutover image-id safety
#                              net can be tested
#
# `docker compose up -d <svc>` is recreate-aware (W3i): the stub tracks a
# ref -> image id map (written by `build -t` and `tag`) and per-container
# <ref, image id> state under $STUB_STATE_DIR. `up` recreates the container —
# its image id becomes the id the target ref points at NOW — only when
# --force-recreate is passed or the merged config's image reference changed;
# without it an existing container created from the same reference keeps its
# old image id even when the tag moved (the bug W3i fixes: the second staging
# deploy retagged $LATEST_IMAGE but compose left the old container running).
# The target ref is the last `image:` line across the `-f` files, in order
# (later files override, as in compose merge).
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
#   STUB_WRITE_ON="<substr>:<path> ..."
#                              append a line to <path> when the full joined
#                              args contain <substr> — simulates the started
#                              container writing into a mounted data dir
#                              (used by the staging drill tests); unset = no-op
# No `set -e` here on purpose: `&&`/`||` chains drive the scripted failures.

printf '%s\n' "$*" >> "${STUB_LOG:?STUB_LOG is required}"

# Intentional word splitting: STUB_WRITE_ON holds one spec per word.
for spec in ${STUB_WRITE_ON:-}; do
  write_pat="${spec%%:*}"
  write_path="${spec#*:}"
  case "$*" in
    *"$write_pat"*)
      printf 'stub write: %s\n' "$*" >> "$write_path"
      ;;
  esac
done

# --- recreate-aware state helpers (W3i) --------------------------------------
# ref -> image id map and per-container <ref, image id> state live under
# $STUB_STATE_DIR so the compose model below can behave like real docker.

stub_key() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9' '_'
}

image_id_for() {
  # The image id a ref points at NOW; unknown refs get a deterministic id.
  local ref_file="${STUB_STATE_DIR:?STUB_STATE_DIR is required}/image-$(stub_key "$1")"
  if [ -f "$ref_file" ]; then
    cat "$ref_file"
  else
    printf 'sha256:img-%s\n' "$(stub_key "$1")"
  fi
}

record_image_id() { # $1 = ref, $2 = image id
  mkdir -p "${STUB_STATE_DIR:?STUB_STATE_DIR is required}"
  printf '%s\n' "$2" > "$STUB_STATE_DIR/image-$(stub_key "$1")"
}

cmd="${1:-}"
if [ -n "$cmd" ]; then
  shift
fi

# `docker image inspect <ref>` is the image-only form of `docker inspect`;
# both feed the inspect handling below, with image_inspect marking the form so
# `-f '{{.Id}}'` can answer with an image id instead of the container id.
image_inspect=""
if [ "$cmd" = "image" ] && [ "${1:-}" = "inspect" ]; then
  cmd="inspect"
  image_inspect="1"
  shift
fi

case "$cmd" in
  build)
    if [ -n "${STUB_FAIL_BUILD:-}" ]; then
      exit 1
    fi
    # Record the built ref -> candidate image id so a container recreated from
    # that ref reports the candidate's id. Args: build -t <ref> <context>.
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-t" ] && [ "$#" -ge 2 ]; then
        record_image_id "$2" "${STUB_CANDIDATE_IMAGE_ID:-sha256:candidate}"
        break
      fi
      shift
    done
    exit 0
    ;;
  tag)
    # The tag moves which image id the DESTINATION ref points at; the
    # reference string itself is unchanged — exactly why compose does not
    # recreate on its own afterwards (W3i).
    if [ "$#" -ge 2 ]; then
      record_image_id "$2" "$(image_id_for "$1")"
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
          printf '%s\n' "${STUB_INSPECT_IMAGE:-portal:latest}"
          ;;
        *'.Image'*)
          # Container image id (`docker inspect -f '{{.Image}}' <container>`),
          # checked against the candidate image id after cutover. State written
          # by the recreate-aware compose model wins; a container no compose up
          # has touched yet reports the pre-existing image id.
          container_state="${STUB_STATE_DIR:-}/container-$(stub_key "$target").state"
          if [ -n "${STUB_STATE_DIR:-}" ] && [ -f "$container_state" ]; then
            sed -n '2p' "$container_state"
          else
            printf '%s\n' "${STUB_CONTAINER_IMAGE_ID:-sha256:pre-existing}"
          fi
          ;;
        *'.Id'*)
          if [ -n "$image_inspect" ]; then
            image_state="${STUB_STATE_DIR:-}/image-$(stub_key "$target")"
            if [ -n "${STUB_STATE_DIR:-}" ] && [ -f "$image_state" ]; then
              cat "$image_state"
            else
              printf '%s\n' "${STUB_CANDIDATE_IMAGE_ID:-sha256:candidate}"
            fi
          else
            printf '%s\n' "${STUB_APP_ID:-aaa111}"
          fi
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
    if [ -n "$image_inspect" ]; then
      # Intentional word splitting: STUB_IMAGE_MISSING holds one ref per word.
      for missing_ref in ${STUB_IMAGE_MISSING:-}; do
        if [ "${1:-}" = "$missing_ref" ]; then
          exit 1
        fi
      done
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
  compose)
    # Recreate-aware compose model (W3i): parses `<global flags> up <flags>
    # <service>`; only `up` has behavior, everything else is a no-op.
    mode=""
    force=""
    files=()
    positionals=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -f | --file)
          if [ "$#" -ge 2 ]; then
            files+=("$2")
            shift 2
          else
            shift
          fi
          ;;
        -p | --project-name | --env-file)
          if [ "$#" -ge 2 ]; then
            shift 2
          else
            shift
          fi
          ;;
        up | down)
          mode="$1"
          shift
          ;;
        --force-recreate)
          force="1"
          shift
          ;;
        -*)
          shift
          ;;
        *)
          if [ -n "$mode" ]; then
            positionals+=("$1")
          fi
          shift
          ;;
      esac
    done
    if [ "$mode" = "up" ] && [ "${#positionals[@]}" -gt 0 ]; then
      # The image reference the merged config resolves to: the last `image:`
      # line across the -f files, in order (later files override, as in
      # compose merge). An unexpanded ${VAR} (the generated trial compose
      # file) means there is nothing to track.
      target_ref=""
      for f in "${files[@]}"; do
        [ -f "$f" ] || continue
        ref="$(sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]#][^[:space:]#]*\).*$/\1/p' "$f" | tail -n 1)"
        if [ -n "$ref" ]; then
          target_ref="$ref"
        fi
      done
      case "$target_ref" in
        *'$'*)
          target_ref=""
          ;;
      esac
      if [ -n "$target_ref" ]; then
        # Compose service -> container name (the fixtures set no
        # container_name for the app service; production uses portal-app).
        case "${positionals[-1]}" in
          portal)
            container="portal-app"
            ;;
          *)
            container="${positionals[-1]}"
            ;;
        esac
        mkdir -p "${STUB_STATE_DIR:?STUB_STATE_DIR is required}"
        container_state="$STUB_STATE_DIR/container-$(stub_key "$container").state"
        cur_ref=""
        cur_id=""
        if [ -f "$container_state" ]; then
          cur_ref="$(sed -n '1p' "$container_state")"
          cur_id="$(sed -n '2p' "$container_state")"
        elif [ -z "${STUB_CONTAINER_MISSING:-}" ]; then
          # The app container already exists (created before this run): it
          # runs whatever ref/image id the environment says it does.
          cur_ref="${STUB_INSPECT_IMAGE:-portal:latest}"
          cur_id="${STUB_CONTAINER_IMAGE_ID:-sha256:pre-existing}"
        fi
        # Real compose recreates the container when the merged config changed
        # (here: the image reference) or when forced. With an unchanged
        # reference and no --force-recreate the existing container is KEPT —
        # even when the tag now points at a different image id (the W3i bug).
        if [ -n "$cur_ref" ] && [ "$cur_ref" = "$target_ref" ] && { [ -z "$force" ] || [ -n "${STUB_COMPOSE_IGNORE_RECREATE:-}" ]; }; then
          printf '%s\n%s\n' "$cur_ref" "$cur_id" > "$container_state"
        else
          printf '%s\n%s\n' "$target_ref" "$(image_id_for "$target_ref")" > "$container_state"
        fi
      fi
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
