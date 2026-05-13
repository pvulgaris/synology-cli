#!/usr/bin/env bash
# Source this (don't run it) once per dev shell. Caches DSM creds to a file
# under $HOME/.cache/synology-nas-mcp/ — NOT into the repo directory, because
# the repo lives in Dropbox and we don't want secrets server-side-synced.
#
#   source dev/source-creds.sh
#
# Override the source vault/item with DSM_OP_VAULT / DSM_OP_ITEM before sourcing.
# To force a fresh op read, delete the cache file or `export REFRESH_CREDS=1`.

: "${DSM_OP_VAULT:=Claude}"
: "${DSM_OP_ITEM:=Synology DSM}"
: "${DSM_BASE_URL:=https://nas.local:5001}"
: "${DSM_USER:=claude-mcp}"

export DSM_OP_VAULT DSM_OP_ITEM DSM_BASE_URL DSM_USER

# Local AUDIT_LOG_DIR fallback — only used if MCP_AUDIT_URL is unset. The
# canonical audit log lives on the NAS via the daemon's POST /audit endpoint;
# this fallback is for unconfigured dev shells (or daemon offline) so writes
# don't crash trying to mkdir /volume1.
: "${AUDIT_LOG_DIR:=$HOME/.cache/synology-nas-mcp/audit}"
export AUDIT_LOG_DIR

# Route every audit record written from dev tsx through the deployed daemon so
# the NAS-side log stays the single source of truth. The daemon validates the
# bearer (already in $MCP_BEARER_TOKEN from the creds cache) and appends to
# /audit (bind-mounted to /volume1/docker/synology-nas-mcp/audit/).
: "${MCP_AUDIT_URL:=http://nas.local:8765/audit}"
export MCP_AUDIT_URL

# Persist DSM SID across npx tsx invocations so we don't burn a TOTP code on
# every run (DSM 7.3 rejects TOTP reuse within the 30s window with code 404).
: "${DSM_SID_CACHE_FILE:=$HOME/.cache/synology-nas-mcp/sid.json}"
export DSM_SID_CACHE_FILE

_creds_cache_dir="${HOME}/.cache/synology-nas-mcp"
_creds_cache="${_creds_cache_dir}/creds"
mkdir -p "$_creds_cache_dir" 2>/dev/null
chmod 700 "$_creds_cache_dir" 2>/dev/null
_cache_max_age_seconds=$((4 * 60 * 60))

_creds_cache_fresh() {
  [ -f "$1" ] || return 1
  local age now mtime
  now=$(date +%s)
  # macOS stat vs GNU stat; try both.
  mtime=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null)
  [ -n "$mtime" ] || return 1
  age=$((now - mtime))
  [ "$age" -lt "$_cache_max_age_seconds" ]
}

if [ "${REFRESH_CREDS:-}" != "1" ] && _creds_cache_fresh "$_creds_cache"; then
  # shellcheck disable=SC1090
  . "$_creds_cache"
  echo "[dev] DSM creds loaded from cache (${_creds_cache#$HOME/~})"
else
  base="op://${DSM_OP_VAULT}/${DSM_OP_ITEM}"
  _dsm_pw=$(op read "${base}/password") || { echo "op read password failed"; return 1; }
  _dsm_totp=$(op read "${base}/totp") || { echo "op read totp failed"; return 1; }
  _dsm_bearer=$(op read "${base}/mcp_bearer_token") || { echo "op read mcp_bearer_token failed"; return 1; }
  umask 077
  {
    printf "export DSM_PASSWORD=%q\n" "$_dsm_pw"
    printf "export DSM_TOTP_SECRET=%q\n" "$_dsm_totp"
    printf "export MCP_BEARER_TOKEN=%q\n" "$_dsm_bearer"
  } > "$_creds_cache"
  chmod 600 "$_creds_cache"
  # shellcheck disable=SC1090
  . "$_creds_cache"
  unset _dsm_pw _dsm_totp _dsm_bearer
  echo "[dev] DSM creds refreshed from 1Password (cached 4h at $_creds_cache)"
fi

unset _creds_cache_dir _creds_cache _cache_max_age_seconds
