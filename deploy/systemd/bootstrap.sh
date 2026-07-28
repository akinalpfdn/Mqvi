#!/usr/bin/env bash
# mqvi — one-time bootstrap for the systemd deployment.
#
# Run ONCE when first putting a box onto systemd (or after a fresh OS). Does the slow, one-time
# work the old start.sh used to do on every launch: create data dirs, download the LiveKit binary
# if this box runs an SFU locally, and install ClamAV. None of this belongs in a per-start hook —
# wrapping the apt install in a restarting unit would re-run it on every crash.
#
# Idempotent: safe to run again; each step is a no-op once done.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "[bootstrap] Preparing $SCRIPT_DIR ..."
mkdir -p data/uploads

# ─── LiveKit binary — only if this box runs an SFU locally (livekit.yaml present) ───
if [ -f livekit.yaml ] && [ ! -x ./livekit-server ]; then
    echo "[bootstrap] LiveKit server not found. Downloading..."
    ARCH="$(uname -m)"
    case "$ARCH" in
        x86_64|amd64)  LK_ARCH="amd64" ;;
        aarch64|arm64) LK_ARCH="arm64" ;;
        *) echo "[bootstrap] Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    LK_VERSION="v1.9.12"
    LK_URL="https://github.com/livekit/livekit/releases/download/${LK_VERSION}/livekit_${LK_VERSION#v}_linux_${LK_ARCH}.tar.gz"
    echo "[bootstrap] Downloading: $LK_URL"
    curl -fsSL "$LK_URL" | tar xz livekit-server
    chmod +x livekit-server
    echo "[bootstrap] LiveKit server downloaded."
fi

# ─── ClamAV — install if missing (one-time). The server tolerates its absence at runtime. ───
install_clamav_if_missing() {
    if command -v clamd >/dev/null 2>&1 || command -v clamdscan >/dev/null 2>&1; then
        echo "[bootstrap] ClamAV already installed."
        return 0
    fi
    if [ "$(id -u)" -ne 0 ]; then
        echo "[bootstrap] ClamAV not installed and not running as root; skipping."
        return 0
    fi
    echo "[bootstrap] Installing clamav-daemon + freshclam..."
    export DEBIAN_FRONTEND=noninteractive
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq >/dev/null 2>&1 || true
        apt-get install -y clamav-daemon clamav-freshclam >/dev/null 2>&1 || {
            echo "[bootstrap] WARNING: apt install of clamav failed; uploads will follow the unavailable policy."
            return 0
        }
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y clamav clamd clamav-update >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y clamav clamd clamav-update >/dev/null 2>&1 || true
    else
        echo "[bootstrap] WARNING: no supported package manager; install clamav manually."
        return 0
    fi
    systemctl enable --now clamav-freshclam >/dev/null 2>&1 || true
    systemctl enable --now clamav-daemon >/dev/null 2>&1 || true
    echo "[bootstrap] ClamAV installed. Signature DB may take ~2 minutes to populate on first run."
}
install_clamav_if_missing

echo "[bootstrap] Done."
