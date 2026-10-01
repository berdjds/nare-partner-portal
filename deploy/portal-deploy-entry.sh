#!/usr/bin/env bash
#
# Forced-command dispatcher for the `deploy` SSH user (W3b, task deploy-entry).
# One-time provisioning (deploy/provision-server.sh) installs this repo copy as
# /usr/local/sbin/portal-deploy-entry (0755 root:root); the repo copy is the
# source of truth.
#
# WHY TWO STAGES: the deploy user's authorized_keys forces
# `command="/usr/local/sbin/portal-deploy-entry"` for every SSH login, and
# sudoers grants the deploy user exactly one root command — this dispatcher.
# Stage 1 therefore runs as the UNPRIVILEGED deploy user (via sshd's forced
# command), validates the client-supplied SSH_ORIGINAL_COMMAND, and re-invokes
# itself through sudo as `portal-deploy-entry --exec <words...>`. Stage 2 runs
# as root, applies THE SAME validation again (it must be safe even when called
# directly, since sudoers cannot validate arguments), and only then execs the
# matching installed tool. Because validation happens twice and sudoers pins
# only this dispatcher, the CI pipeline can never widen its authority beyond
# the operations below — it gets no shell, no arbitrary command, no extra
# arguments.
#
# Accepted interface (EXACT — everything else is rejected):
#   deploy <env> <tarball>        env = staging|production; a bare tarball name
#                                 is rewritten to $UPLOAD_DIR/<name>
#   smoke <env>                   env = staging|production
#   backup
#   restore <archive>             staging only
#   restore --production <archive>
#   drill-rollback                staging only
#   drill-restore                 staging only
#
# Dispatch (stage 2):
#   deploy   -> $LIB_DIR/portal-deploy <env> <tarball>
#   smoke    -> $LIB_DIR/portal-smoke <url>  (staging/public URL per env)
#   backup   -> $LIB_DIR/portal-backup
#   restore  -> PORTAL_ENV_NAME=<env> $LIB_DIR/portal-restore <archive> --yes
#               (the dispatcher invocation IS the operator's --yes
#               acknowledgement; --no-export-ack is never passed)
#   drill-*  -> PORTAL_ENV_NAME=staging $LIB_DIR/portal-drill rollback|restore
#
# Input hygiene: no eval, no globbing (set -f), no unquoted expansion of
# client input. The whole command line is charset-whitelisted BEFORE word
# splitting, path arguments are restricted to [A-Za-z0-9._/-], must end in
# .tar.gz, must not start with `-` and must not contain `..`.
#
# Every rejection prints `portal-deploy-entry: rejected: <reason>` on stderr
# and exits 1.
#
# Env overrides (used by the test suite; defaults in parentheses):
#   PORTAL_DEPLOY_LIB_DIR    (/usr/local/lib/portal-deploy)
#   PORTAL_DEPLOY_ENTRY_PATH (/usr/local/sbin/portal-deploy-entry)
#   PORTAL_DEPLOY_SUDO       (sudo)
#   PORTAL_DEPLOY_UPLOAD_DIR (/home/deploy)
#   PORTAL_PUBLIC_URL        (https://portal.nare.am)
#   PORTAL_STAGING_URL       (https://staging.portal.nare.am)

set -euo pipefail
# No pathname expansion anywhere in this script: client words must stay
# literal even if they happen to match files.
set -f

LIB_DIR="${PORTAL_DEPLOY_LIB_DIR:-/usr/local/lib/portal-deploy}"
ENTRY_PATH="${PORTAL_DEPLOY_ENTRY_PATH:-/usr/local/sbin/portal-deploy-entry}"
SUDO="${PORTAL_DEPLOY_SUDO:-sudo}"
UPLOAD_DIR="${PORTAL_DEPLOY_UPLOAD_DIR:-/home/deploy}"
PUBLIC_URL="${PORTAL_PUBLIC_URL:-https://portal.nare.am}"
STAGING_URL="${PORTAL_STAGING_URL:-https://staging.portal.nare.am}"

reject() {
  printf 'portal-deploy-entry: rejected: %s\n' "$*" >&2
  exit 1
}

# validate_path_arg <kind> <value> — shared rules for tarball/archive
# arguments: safe charset, no leading dash (would be parsed as a flag by the
# downstream tool), no `..` (would escape the intended directory), .tar.gz.
validate_path_arg() {
  local kind="$1" value="$2"
  case "$value" in
    *[!A-Za-z0-9._/-]*)
      reject "$kind contains forbidden characters"
      ;;
  esac
  case "$value" in
    -*)
      reject "$kind must not start with '-'"
      ;;
  esac
  case "$value" in
    *..*)
      reject "$kind must not contain '..'"
      ;;
  esac
  case "$value" in
    *.tar.gz) ;;
    *)
      reject "$kind must end in .tar.gz"
      ;;
  esac
}

# validate_command <raw line> — charset-whitelist, split, route and validate
# the full command. On success sets:
#   CMD        the first word (deploy|smoke|backup|restore|drill-*)
#   CMD_WORDS  the normalized argument vector (deploy's tarball rewritten to
#              an absolute path under $UPLOAD_DIR)
# Any violation rejects with exit 1.
validate_command() {
  local line="$1"

  # Charset gate BEFORE splitting: only unambiguous characters ever reach the
  # word splitter — no tabs/newlines (would fake word boundaries), no shell
  # metacharacters (; & | $ ` ( ) < > * ? { } [ ] ! ~ ' " \ ...). '-' is
  # allowed in the line because `restore --production` needs it; WHERE a dash
  # may appear is pinned by the per-word rules below.
  case "$line" in
    *[!A-Za-z0-9._/\ -]*)
      reject "command contains forbidden characters"
      ;;
  esac

  # Intended word splitting: the charset gate above guarantees the line holds
  # only [A-Za-z0-9._/-] and spaces, so expansion cannot glob (set -f is on
  # too) and cannot inject metacharacters.
  # shellcheck disable=SC2086
  set -- $line

  CMD="${1:-}"
  case "$CMD" in
    deploy)
      [ "$#" -eq 3 ] || reject "usage: deploy <env> <tarball>"
      case "$2" in
        staging | production) ;;
        *)
          reject "deploy environment must be 'staging' or 'production'"
          ;;
      esac
      local tarball="$3"
      validate_path_arg "tarball" "$tarball"
      case "$tarball" in
        */*)
          # A path is only accepted under the deploy user's upload dir.
          case "$tarball" in
            "$UPLOAD_DIR"/*) ;;
            *)
              reject "tarball path must be under $UPLOAD_DIR"
              ;;
          esac
          ;;
        *)
          tarball="$UPLOAD_DIR/$tarball"
          ;;
      esac
      CMD_WORDS=("deploy" "$2" "$tarball")
      ;;
    smoke)
      [ "$#" -eq 2 ] || reject "usage: smoke <env>"
      case "$2" in
        staging | production) ;;
        *)
          reject "smoke environment must be 'staging' or 'production'"
          ;;
      esac
      CMD_WORDS=("smoke" "$2")
      ;;
    backup)
      [ "$#" -eq 1 ] || reject "usage: backup"
      CMD_WORDS=("backup")
      ;;
    restore)
      case "$#" in
        2)
          local archive="$2"
          validate_path_arg "archive" "$archive"
          case "$archive" in
            /*) ;;
            *)
              reject "archive must be an absolute path"
              ;;
          esac
          CMD_WORDS=("restore" "$archive")
          ;;
        3)
          [ "$2" = "--production" ] || reject "usage: restore [--production] <archive>"
          local archive="$3"
          validate_path_arg "archive" "$archive"
          case "$archive" in
            /*) ;;
            *)
              reject "archive must be an absolute path"
              ;;
          esac
          CMD_WORDS=("restore" "--production" "$archive")
          ;;
        *)
          reject "usage: restore [--production] <archive>"
          ;;
      esac
      ;;
    drill-rollback | drill-restore)
      [ "$#" -eq 1 ] || reject "usage: $CMD"
      CMD_WORDS=("$CMD")
      ;;
    *)
      # Also catches a client-sent `--exec`: stage 2 is only reachable via
      # stage 1's sudo call, never from SSH_ORIGINAL_COMMAND.
      reject "unknown command: ${CMD:-<empty>}"
      ;;
  esac
}

# --- stage 2: --exec (root, via sudo; re-validates everything) ---------------
if [ "${1:-}" = "--exec" ]; then
  shift
  # Re-join the words and run the full validation again: this stage must be
  # safe even when invoked directly (sudoers pins the program, not its args).
  line="$(IFS=' '; printf '%s' "$*")"
  validate_command "$line"
  case "$CMD" in
    deploy)
      exec "$LIB_DIR/portal-deploy" "${CMD_WORDS[1]}" "${CMD_WORDS[2]}"
      ;;
    smoke)
      if [ "${CMD_WORDS[1]}" = "staging" ]; then
        exec "$LIB_DIR/portal-smoke" "$STAGING_URL"
      else
        exec "$LIB_DIR/portal-smoke" "$PUBLIC_URL"
      fi
      ;;
    backup)
      exec "$LIB_DIR/portal-backup"
      ;;
    restore)
      if [ "${CMD_WORDS[1]:-}" = "--production" ]; then
        export PORTAL_ENV_NAME=production
        exec "$LIB_DIR/portal-restore" "${CMD_WORDS[2]}" --yes
      else
        export PORTAL_ENV_NAME=staging
        exec "$LIB_DIR/portal-restore" "${CMD_WORDS[1]}" --yes
      fi
      ;;
    drill-*)
      export PORTAL_ENV_NAME=staging
      exec "$LIB_DIR/portal-drill" "${CMD#drill-}"
      ;;
  esac
fi

# --- stage 1: forced command (deploy user, via sshd) -------------------------
[ "$#" -eq 0 ] || reject "unexpected arguments (this dispatcher is driven by SSH_ORIGINAL_COMMAND)"
[ -n "${SSH_ORIGINAL_COMMAND:-}" ] || reject "interactive access is not allowed"

validate_command "$SSH_ORIGINAL_COMMAND"
exec "$SUDO" "$ENTRY_PATH" --exec "${CMD_WORDS[@]}"
