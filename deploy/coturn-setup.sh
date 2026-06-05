#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  mqvi — coturn (TURN relay) setup for P2P calls
#
#  Installs and configures a single coturn on a mqvi BACKEND host so 1-on-1 P2P
#  calls can fall back to a relay when direct connectivity fails. One-time setup;
#  coturn then runs independently of mqvi binary redeploys.
#
#  - Shares an HMAC secret with the backend: writes static-auth-secret into
#    turnserver.conf AND TURN_SECRET + TURN_URLS into the mqvi .env.
#  - Relay ports kept BELOW LiveKit's range (49152-49999 vs 50000+).
#  - Abuse quotas + private/metadata peer denylist (the backend can't revoke a
#    stateless credential, so coturn is the only place usage is bounded).
#
#  Usage (on the server):
#    sudo bash coturn-setup.sh                  # auto-detect mqvi .env
#    sudo MQVI_ENV=/path/to/.env bash coturn-setup.sh
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# Relay port range — deliberately below every LiveKit rtc.port_range (50000-50200
# deploy, up to 50000-60000 self-host) so the two never collide on a shared host.
MIN_PORT=49152
MAX_PORT=49999
LISTENING_PORT=3478

echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo -e "${CYAN}  mqvi coturn Setup (TURN relay)${NC}"
echo -e "${CYAN}═══════════════════════════════════════${NC}"

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}Error: must run as root. Try: sudo bash coturn-setup.sh${NC}"
    exit 1
fi

# ─── Locate the mqvi .env (secret must be shared with the backend) ───
if [ -z "${MQVI_ENV:-}" ]; then
    for candidate in /opt/mqvi/.env "$HOME/mqvi/.env" /root/mqvi/.env ./.env; do
        if [ -f "$candidate" ]; then MQVI_ENV="$candidate"; break; fi
    done
fi
if [ -z "${MQVI_ENV:-}" ] || [ ! -f "$MQVI_ENV" ]; then
    echo -e "${RED}Error: could not find the mqvi .env. Pass it explicitly:${NC}"
    echo "  sudo MQVI_ENV=/path/to/mqvi/.env bash coturn-setup.sh"
    exit 1
fi
echo -e "${GREEN}  Using mqvi env: ${MQVI_ENV}${NC}"

# ─── .env helpers (preserve file ownership via in-place edits) ───
get_env() { grep -E "^$1=" "$MQVI_ENV" 2>/dev/null | tail -n1 | cut -d= -f2-; }
set_env() {
    # $1=key $2=value — replace in place, or append if absent.
    local key="$1" value="$2"
    if grep -Eq "^${key}=" "$MQVI_ENV"; then
        sed -i -E "s|^${key}=.*|${key}=${value}|" "$MQVI_ENV"
    else
        printf '%s=%s\n' "$key" "$value" >> "$MQVI_ENV"
    fi
}

# ─── 1/6: Install coturn ───
echo -e "${YELLOW}[1/6] Installing coturn...${NC}"
if command -v turnserver >/dev/null 2>&1; then
    echo -e "${GREEN}  coturn already installed.${NC}"
elif command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y coturn >/dev/null
elif command -v dnf >/dev/null 2>&1; then
    dnf install -y coturn >/dev/null
elif command -v yum >/dev/null 2>&1; then
    yum install -y coturn >/dev/null
else
    echo -e "${RED}  No supported package manager (apt/dnf/yum). Install coturn manually.${NC}"
    exit 1
fi

# ─── 2/6: Read the shared secret from .env (single source of truth) ───
echo -e "${YELLOW}[2/6] Reading shared secret...${NC}"
TURN_SECRET="$(get_env TURN_SECRET)"
if [ -z "$TURN_SECRET" ]; then
    echo -e "${RED}  TURN_SECRET is not set in ${MQVI_ENV}.${NC}"
    echo "  Set it there first (the backend uses the same value), e.g.:"
    echo "    echo \"TURN_SECRET=\$(openssl rand -hex 32)\" >> ${MQVI_ENV}"
    echo "  then re-run this script."
    exit 1
fi
echo -e "${GREEN}  Using TURN_SECRET from .env.${NC}"

# Force IPv4 — a TURN URL with a bare IPv6 address is invalid (would need
# brackets), and relay is IPv4 here.
PUBLIC_IP="$(curl -4 -fsSL --max-time 5 https://api.ipify.org 2>/dev/null \
    || curl -4 -fsSL --max-time 5 https://ifconfig.me 2>/dev/null \
    || hostname -I | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -n1)"
if ! printf '%s' "$PUBLIC_IP" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    echo -e "${RED}  Could not determine a public IPv4 address (got: '${PUBLIC_IP:-none}').${NC}"
    exit 1
fi
echo -e "${GREEN}  Public IPv4: ${PUBLIC_IP}${NC}"

# ─── 3/6: Write turnserver.conf ───
echo -e "${YELLOW}[3/6] Writing /etc/turnserver.conf...${NC}"
mkdir -p /var/log/turnserver
cat > /etc/turnserver.conf <<EOF
# /etc/turnserver.conf — managed by mqvi coturn-setup.sh (P2P call TURN relay)
listening-port=${LISTENING_PORT}
fingerprint

# TURN REST API: time-limited HMAC credentials minted by the mqvi backend.
# static-auth-secret MUST equal TURN_SECRET in the mqvi .env (kept in sync here).
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=${PUBLIC_IP}

# Public IP advertised in relay candidates.
external-ip=${PUBLIC_IP}

# Relay port range — kept below LiveKit's (50000+) so they never collide.
min-port=${MIN_PORT}
max-port=${MAX_PORT}

# Abuse limits — the backend cannot revoke a stateless credential, so coturn is
# the only place usage is bounded. Tune for your capacity. (Values must be on
# their own line — coturn does NOT strip trailing inline comments.)
# max concurrent allocations per user:
user-quota=12
# max concurrent allocations server-wide:
total-quota=1200
# per-session bandwidth cap, bytes/sec (~4 Mbit/s, comfortably above HD video):
max-bps=500000

# SSRF / internal-pivot defense — never relay to private, metadata, or loopback
# addresses this host can reach.
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.0.2.0-192.0.2.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

# No admin CLI console.
no-cli
log-file=/var/log/turnserver/turnserver.log
simple-log
EOF

# The config holds static-auth-secret — must not be world-readable. Grant read to
# the coturn service group (turnserver on Debian, coturn on RHEL) so the daemon
# can still read it after dropping privileges.
chmod 640 /etc/turnserver.conf
if getent group turnserver >/dev/null 2>&1; then
    chown root:turnserver /etc/turnserver.conf
elif getent group coturn >/dev/null 2>&1; then
    chown root:coturn /etc/turnserver.conf
else
    chown root:root /etc/turnserver.conf
fi
echo -e "${GREEN}  Config written (mode 640).${NC}"

# Debian/Ubuntu ship coturn disabled until /etc/default/coturn enables it.
if [ -f /etc/default/coturn ]; then
    if grep -Eq '^[#[:space:]]*TURNSERVER_ENABLED' /etc/default/coturn; then
        sed -i -E 's|^[#[:space:]]*TURNSERVER_ENABLED.*|TURNSERVER_ENABLED=1|' /etc/default/coturn
    else
        echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
    fi
fi

# ─── 4/6: Write TURN_URLS into the mqvi .env (TURN_SECRET already read from it) ───
echo -e "${YELLOW}[4/6] Updating mqvi .env (TURN_URLS)...${NC}"
set_env TURN_URLS "turn:${PUBLIC_IP}:${LISTENING_PORT}?transport=udp,turn:${PUBLIC_IP}:${LISTENING_PORT}?transport=tcp"
echo -e "${GREEN}  TURN_URLS set (restart mqvi-server to apply).${NC}"

# ─── 5/6: Firewall ───
echo -e "${YELLOW}[5/6] Opening firewall ports...${NC}"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow ${LISTENING_PORT}/udp >/dev/null
    ufw allow ${LISTENING_PORT}/tcp >/dev/null
    ufw allow ${MIN_PORT}:${MAX_PORT}/udp >/dev/null
    echo -e "${GREEN}  UFW: ${LISTENING_PORT}/udp, ${LISTENING_PORT}/tcp, ${MIN_PORT}-${MAX_PORT}/udp${NC}"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port=${LISTENING_PORT}/udp >/dev/null
    firewall-cmd --permanent --add-port=${LISTENING_PORT}/tcp >/dev/null
    firewall-cmd --permanent --add-port=${MIN_PORT}-${MAX_PORT}/udp >/dev/null
    firewall-cmd --reload >/dev/null
    echo -e "${GREEN}  firewalld: ${LISTENING_PORT}/udp+tcp, ${MIN_PORT}-${MAX_PORT}/udp${NC}"
else
    echo -e "${YELLOW}  No firewall manager found. Open manually: ${LISTENING_PORT}/udp, ${LISTENING_PORT}/tcp, ${MIN_PORT}-${MAX_PORT}/udp${NC}"
fi

# ─── 6/6: Start coturn ───
echo -e "${YELLOW}[6/6] Starting coturn service...${NC}"
# Auto-restart on crash (the packaged unit may not set one) via a drop-in so the
# package's own unit file isn't touched / overwritten on upgrade. With enable
# (boot) + this (crash), coturn self-heals like mqvi-server does.
mkdir -p /etc/systemd/system/coturn.service.d
cat > /etc/systemd/system/coturn.service.d/restart.conf <<EOF
[Service]
Restart=on-failure
RestartSec=5
EOF
systemctl daemon-reload
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn

sleep 2
if systemctl is-active --quiet coturn; then
    echo -e "${GREEN}  coturn is running on port ${LISTENING_PORT}.${NC}"
else
    echo -e "${RED}  coturn failed to start. Check: journalctl -u coturn -n 30${NC}"
    exit 1
fi

echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  coturn is set up.${NC}"
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo ""
echo -e "  TURN URL:  turn:${PUBLIC_IP}:${LISTENING_PORT}"
echo -e "  ${YELLOW}Restart the backend to pick up TURN_SECRET/TURN_URLS:${NC}"
echo -e "    systemctl restart mqvi-server   ${CYAN}# (or your start.sh)${NC}"
echo ""
echo -e "  ${YELLOW}If your VPS has a cloud firewall (Hetzner, etc.), also open there:${NC}"
echo -e "    ${LISTENING_PORT}/udp, ${LISTENING_PORT}/tcp, ${MIN_PORT}-${MAX_PORT}/udp"
echo ""
echo -e "  Manage: systemctl {restart|status} coturn   |   Logs: journalctl -u coturn -f"
echo -e "${CYAN}═══════════════════════════════════════${NC}"
