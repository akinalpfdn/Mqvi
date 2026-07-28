#!/usr/bin/env bash
# mqvi — per-start preparation, run by systemd as ExecStartPre of mqvi-server.service.
#
# Does ONLY the fast, idempotent, per-boot work: make sure clamav is running and sync Caddy's
# request-body limit with the .env. It must NEVER install anything (that is bootstrap.sh's job, run
# once) and must ALWAYS exit 0 — a failure here would block the server from starting, and none of
# this is fatal to the server (uploads fall back to the antivirus-unavailable policy, and Caddy
# keeps whatever limit it had).
#
# Extracted verbatim from the old start.sh so its behaviour does not drift.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

env_value() {
    # $1 = key, $2 = default
    local key="$1"
    local default="$2"
    local line value
    line="$(grep -E "^${key}=" .env 2>/dev/null | tail -n 1 || true)"
    if [ -z "$line" ]; then
        printf '%s' "$default"
        return
    fi
    value="${line#*=}"
    value="${value%\"}"
    value="${value#\"}"
    printf '%s' "$value"
}

ensure_clamav_running() {
    local enabled
    enabled="$(env_value MQVI_ANTIVIRUS_ENABLED true)"
    case "$(printf '%s' "$enabled" | tr '[:upper:]' '[:lower:]')" in
        false|0|no|off) return ;;
    esac
    # Start only — installation is bootstrap.sh's job. The server waits for and tolerates an
    # unreachable clamav on its own, so this is best-effort.
    if command -v systemctl >/dev/null 2>&1; then
        systemctl start clamav-daemon >/dev/null 2>&1 || true
    fi
}

sync_caddy_upload_size() {
    # Keep Caddy's request_body max_size in step with UPLOAD_MAX_SIZE. Only touches Caddyfiles
    # marked "# managed by mqvi"; user-owned configs are left alone.
    local caddyfile="/etc/caddy/Caddyfile"
    [ -f "$caddyfile" ] || return 0
    grep -q "managed by mqvi" "$caddyfile" || return 0
    [ "$(id -u)" -eq 0 ] || return 0

    local size_bytes current
    size_bytes="$(env_value UPLOAD_MAX_SIZE 104857600)"
    current="$(grep -oE 'max_size[[:space:]]+[^[:space:]}]+' "$caddyfile" | awk '{print $2}' | head -n 1)"
    [ "$current" = "$size_bytes" ] && return 0
    sed -i -E "s/(max_size[[:space:]]+)[^[:space:]}]+/\1${size_bytes}/" "$caddyfile"
    systemctl reload caddy >/dev/null 2>&1 || true
    echo "[prestart] Caddy max_size synced to ${size_bytes} bytes."
}

ensure_clamav_running
sync_caddy_upload_size

exit 0
