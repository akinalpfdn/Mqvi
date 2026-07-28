#!/usr/bin/env bash
# mqvi — one-time: put an existing ~/mqvi box onto systemd, taking over from nohup ./start.sh.
#
# Run this ON THE SERVER, once, from the directory that holds these files (e.g. after scp'ing
# deploy/systemd/ up). Rehearse on the staging box before production — this is low risk (no data
# moves, the old binary and .env stay exactly where they are), but "seen working on staging" beats
# "should work".
#
# Rollback to nohup, if ever needed:
#   systemctl disable --now mqvi-server.service mqvi-livekit.service
#   cd /root/mqvi && nohup ./start.sh > output.log 2>&1 &

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/root/mqvi}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[install-units] Install dir: $INSTALL_DIR"

if [ "$(id -u)" -ne 0 ]; then
    echo "[install-units] Must run as root (writes /etc/systemd/system and manages services)." >&2
    exit 1
fi
if [ ! -x "$INSTALL_DIR/mqvi-server" ]; then
    echo "[install-units] No mqvi-server at $INSTALL_DIR — deploy the binary first." >&2
    exit 1
fi

# 1. Put the per-start and bootstrap helpers next to the binary.
install -m 0755 "$SCRIPT_DIR/prestart.sh" "$INSTALL_DIR/prestart.sh"
install -m 0755 "$SCRIPT_DIR/bootstrap.sh" "$INSTALL_DIR/bootstrap.sh"
echo "[install-units] prestart.sh + bootstrap.sh installed."

# 2. One-time bootstrap (livekit download if local, clamav install). Idempotent.
( cd "$INSTALL_DIR" && ./bootstrap.sh )

# 3. Install the units. They hardcode /root/mqvi; rewrite if INSTALL_DIR differs.
for unit in mqvi-server.service mqvi-livekit.service; do
    sed "s#/root/mqvi#${INSTALL_DIR}#g" "$SCRIPT_DIR/$unit" > "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable mqvi-server.service mqvi-livekit.service >/dev/null
echo "[install-units] Units installed and enabled (start on boot)."

# 4. Cut over from the nohup instance, if one is running, so the two never overlap.
if pgrep -x mqvi-server >/dev/null; then
    echo "[install-units] Stopping the nohup-launched server before systemd takes over..."
    pkill -TERM -x mqvi-server || true
    for _ in $(seq 1 15); do pgrep -x mqvi-server >/dev/null || break; sleep 1; done
    pkill -9 -x mqvi-server 2>/dev/null || true
    pkill -9 -x livekit-server 2>/dev/null || true
    sleep 1
fi

# 5. Hand control to systemd.
systemctl start mqvi-server.service
echo "[install-units] systemd started mqvi-server. Verify:"
echo "    systemctl status mqvi-server.service --no-pager"
echo "    curl -fs http://127.0.0.1:9091/health/ready && echo READY"
