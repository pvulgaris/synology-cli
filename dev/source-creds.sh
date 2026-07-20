#!/usr/bin/env bash
# Source this (do not run it) once per dev shell to load DSM creds from 1Password
# into the environment for `syno` and the dev harness:
#
#   source dev/source-creds.sh
#
# Auth uses your existing `op` setup:
#   • Interactive: the 1Password desktop-app integration (biometric; ~10-min
#     rolling session per terminal — standard op behaviour).
#   • Headless / mobile / CI: set OP_SERVICE_ACCOUNT_TOKEN (e.g. from
#     dev/.env.local) and reads become prompt-free. We inject it into op only —
#     never re-export it — so child processes (tsx, docker, the server) don't
#     inherit vault access.
#
# Machine-specific values (real NAS URL, how you source the token) go in
# dev/.env.local (gitignored), sourced first so it wins.

_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
[ -n "$_self_dir" ] && [ -f "${_self_dir}/.env.local" ] && . "${_self_dir}/.env.local"

# Capture the optional service-account token and drop it from the environment
# immediately — before any external command (mkdir, op, …) runs — so no child
# process ever inherits it. It is injected into op only, in _op below.
_optok="${OP_SERVICE_ACCOUNT_TOKEN:-}"
unset OP_SERVICE_ACCOUNT_TOKEN

: "${DSM_OP_VAULT:=Claude}"
: "${DSM_OP_ITEM:=Synology DSM}"
: "${DSM_BASE_URL:=https://nas.local:5001}"
: "${DSM_USER:=claude-mcp}"
# Session file and audit log are left to the CLI's own defaults under
# ~/.local/state/syno. Overriding them here would split state across two
# locations, so a session written by `syno` wouldn't be found by a dev run.
export DSM_OP_VAULT DSM_OP_ITEM DSM_BASE_URL DSM_USER

# Read-only service-account token (captured above) makes `op read` prompt-free;
# injected into op only — never re-exported — so children don't inherit vault
# access. Absent → op falls back to the interactive desktop-app integration.
_op() {
  if [ -n "$_optok" ]; then OP_SERVICE_ACCOUNT_TOKEN="$_optok" op read "$1"
  else op read "$1"; fi
}

_base="op://${DSM_OP_VAULT}/${DSM_OP_ITEM}"
DSM_PASSWORD=$(_op "${_base}/password") || { echo "op read password failed" >&2; _optok=""; return 1; }
DSM_TOTP_SECRET=$(_op "${_base}/totp")  || { echo "op read totp failed" >&2; _optok=""; return 1; }
export DSM_PASSWORD DSM_TOTP_SECRET
echo "[dev] DSM creds loaded from 1Password"

# Router (SRM) creds — gated on SRM_BASE_URL, the same switch config.ts uses.
if [ -n "${SRM_BASE_URL:-}" ]; then
  : "${SRM_OP_ITEM:=Synology SRM}"
  export SRM_OP_ITEM
  _rbase="op://${DSM_OP_VAULT}/${SRM_OP_ITEM}"
  if SRM_PASSWORD=$(_op "${_rbase}/password") && SRM_TOTP_SECRET=$(_op "${_rbase}/totp"); then
    export SRM_PASSWORD SRM_TOTP_SECRET
    echo "[dev] router (SRM) creds loaded from 1Password"
  else
    echo "[dev] SRM_BASE_URL set but op read failed; router creds not loaded" >&2
  fi
  unset _rbase
fi

unset _self_dir _optok _base
unset -f _op
