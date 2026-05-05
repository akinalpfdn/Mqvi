#!/usr/bin/env bash
# mqvi — One-command installer for Linux servers.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/install.sh | sudo bash
#
# Optional flags (any combination):
#   --domain <host>       Public hostname (e.g. demo.mqvi.net). If omitted, sslip.io
#                         is used automatically based on the public IP.
#   --port <number>       Internal port mqvi-server binds to. Default: 9090.
#   --no-tls              Skip Caddy entirely; expose mqvi-server directly on --port.
#                         Voice/video will not work in browsers without HTTPS.
#   --existing-caddy      Force "existing Caddy" mode even if detection fails.
#                         Script installs mqvi-server only and prints a Caddyfile
#                         snippet for you to wire up manually.
#   -y, --yes             Non-interactive: accept all defaults, skip prompts.
#
# What this does:
#   1. Creates /opt/mqvi and a dedicated 'mqvi' system user
#   2. Downloads the latest mqvi-server binary from GitHub releases
#   3. Downloads the LiveKit SFU binary
#   4. Generates .env with random JWT_SECRET and ENCRYPTION_KEY
#   5. Writes livekit.yaml with random API credentials
#   6. Installs systemd units for both services
#   7. (TLS modes) Installs/configures Caddy for automatic Let's Encrypt
#   8. Opens firewall ports (UFW / firewalld if present)
#   9. Starts everything
#
# Re-running is safe: existing .env and livekit.yaml are preserved.

set -euo pipefail

REPO="akinalpfdn/Mqvi"
INSTALL_DIR="/opt/mqvi"
DATA_DIR="${INSTALL_DIR}/data"
SERVICE_USER="mqvi"
LIVEKIT_VERSION="v1.9.12"
DEFAULT_PORT="9090"

# ─── Flag defaults ───────────────────────────────────────────────────────────
DOMAIN=""
MQVI_PORT=""
NO_TLS=0
EXISTING_CADDY_FLAG=0
NON_INTERACTIVE=0

log()  { printf '\033[1;34m[mqvi]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[mqvi]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[mqvi]\033[0m %s\n' "$*" >&2; exit 1; }

# ─── Parse flags ─────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
    case "$1" in
        --domain)         DOMAIN="${2:-}"; shift 2 ;;
        --domain=*)       DOMAIN="${1#*=}"; shift ;;
        --port)           MQVI_PORT="${2:-}"; shift 2 ;;
        --port=*)         MQVI_PORT="${1#*=}"; shift ;;
        --no-tls)         NO_TLS=1; shift ;;
        --existing-caddy) EXISTING_CADDY_FLAG=1; shift ;;
        -y|--yes)         NON_INTERACTIVE=1; shift ;;
        -h|--help)
            sed -n '2,20p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) die "Unknown flag: $1 (use --help)" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "This script must be run as root. Try: sudo bash install.sh"

# ─── Detect architecture ─────────────────────────────────────────────────────
case "$(uname -m)" in
    x86_64|amd64)  ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "Unsupported architecture: $(uname -m). mqvi supports x86_64 and arm64." ;;
esac
log "Detected architecture: ${ARCH}"

# ─── Required tools ──────────────────────────────────────────────────────────
for tool in curl tar openssl systemctl; do
    command -v "$tool" >/dev/null 2>&1 || die "Missing required tool: $tool"
done

# ─── Detect package manager (for Caddy install) ──────────────────────────────
PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v dnf >/dev/null 2>&1;     then PKG="dnf"
elif command -v yum >/dev/null 2>&1;     then PKG="yum"
fi

# ─── Detect existing Caddy ───────────────────────────────────────────────────
CADDY_PRESENT=0
if [ "$EXISTING_CADDY_FLAG" -eq 1 ]; then
    CADDY_PRESENT=1
elif command -v caddy >/dev/null 2>&1; then
    CADDY_PRESENT=1
fi

# ─── Determine public IP (for sslip.io fallback) ─────────────────────────────
PUBLIC_IP="$(curl -fsSL --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
[ -n "$PUBLIC_IP" ] || warn "Could not determine public IP."

# ─── Interactive prompts (only if TTY + not -y) ──────────────────────────────
prompt() {
    # $1 = question, $2 = default, $3 = var to set
    local answer
    if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ]; then
        eval "$3=\"\${$3:-$2}\""
        return
    fi
    if [ -n "${!3:-}" ]; then return; fi
    read -r -p "$1 [$2]: " answer </dev/tty || answer=""
    eval "$3=\"\${answer:-$2}\""
}

# Mode resolution:
#   1) --no-tls           → MODE=plain (HTTP only on chosen port)
#   2) Caddy present OR --existing-caddy → MODE=existing
#   3) --domain given     → MODE=new-caddy-domain
#   4) Otherwise          → MODE=new-caddy-sslip
MODE=""
if [ "$NO_TLS" -eq 1 ]; then
    MODE="plain"
elif [ "$CADDY_PRESENT" -eq 1 ]; then
    MODE="existing"
elif [ -n "$DOMAIN" ]; then
    MODE="new-caddy-domain"
else
    if [ "$NON_INTERACTIVE" -eq 0 ] && [ -t 0 ]; then
        echo
        echo "How should mqvi be exposed?"
        echo "  1) HTTPS via Let's Encrypt with my domain (recommended)"
        echo "  2) HTTPS via sslip.io (no domain needed, uses public IP)"
        echo "  3) HTTP only (voice/video will not work — testing only)"
        read -r -p "Choose [1-3, default 2]: " choice </dev/tty || choice=""
        case "${choice:-2}" in
            1)
                read -r -p "Domain (e.g. demo.mqvi.net): " DOMAIN </dev/tty
                [ -n "$DOMAIN" ] || die "Domain required for option 1."
                MODE="new-caddy-domain"
                ;;
            2)  MODE="new-caddy-sslip" ;;
            3)  MODE="plain"; NO_TLS=1 ;;
            *)  die "Invalid choice: $choice" ;;
        esac
    else
        MODE="new-caddy-sslip"
    fi
fi

# Resolve sslip.io domain if needed
if [ "$MODE" = "new-caddy-sslip" ]; then
    [ -n "$PUBLIC_IP" ] || die "Cannot use sslip.io: public IP not detected. Pass --domain or --no-tls."
    DOMAIN="$(printf '%s' "$PUBLIC_IP" | tr . -).sslip.io"
    log "Using sslip.io hostname: ${DOMAIN}"
fi

# Resolve internal port
if [ -z "$MQVI_PORT" ]; then
    prompt "Internal port for mqvi-server" "$DEFAULT_PORT" MQVI_PORT
fi
[[ "$MQVI_PORT" =~ ^[0-9]+$ ]] || die "Invalid port: $MQVI_PORT"

log "Install plan:"
log "  Mode:     ${MODE}"
log "  Domain:   ${DOMAIN:-<none — HTTP only>}"
log "  Port:     ${MQVI_PORT} (internal)"

# In TLS modes mqvi binds to localhost — Caddy proxies to it.
# In plain mode mqvi binds to 0.0.0.0 so it's reachable directly.
if [ "$MODE" = "plain" ]; then
    BIND_HOST="0.0.0.0"
else
    BIND_HOST="127.0.0.1"
fi

# ─── Create service user ─────────────────────────────────────────────────────
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Creating system user '${SERVICE_USER}'..."
    useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
mkdir -p "$INSTALL_DIR" "$DATA_DIR/uploads"

# ─── Download mqvi-server binary ─────────────────────────────────────────────
MQVI_URL="https://github.com/${REPO}/releases/latest/download/mqvi-server-linux-${ARCH}"
log "Downloading mqvi-server (linux-${ARCH})..."
curl -fsSL --retry 3 -o "${INSTALL_DIR}/mqvi-server" "$MQVI_URL" \
    || die "Failed to download mqvi-server from ${MQVI_URL}"
chmod +x "${INSTALL_DIR}/mqvi-server"

# ─── Download LiveKit binary ─────────────────────────────────────────────────
if [ ! -x "${INSTALL_DIR}/livekit-server" ]; then
    LK_URL="https://github.com/livekit/livekit/releases/download/${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION#v}_linux_${ARCH}.tar.gz"
    log "Downloading LiveKit ${LIVEKIT_VERSION}..."
    curl -fsSL --retry 3 "$LK_URL" | tar xz -C "$INSTALL_DIR" livekit-server \
        || die "Failed to download LiveKit from ${LK_URL}"
    chmod +x "${INSTALL_DIR}/livekit-server"
fi

# ─── Generate livekit.yaml (if absent) ───────────────────────────────────────
LK_API_KEY=""
LK_API_SECRET=""
if [ ! -f "${INSTALL_DIR}/livekit.yaml" ]; then
    log "Generating livekit.yaml with random credentials..."
    LK_API_KEY="APIkey$(openssl rand -hex 6)"
    LK_API_SECRET="$(openssl rand -hex 32)"
    cat > "${INSTALL_DIR}/livekit.yaml" <<EOF
port: 7880

rtc:
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: true

keys:
  ${LK_API_KEY}: ${LK_API_SECRET}

logging:
  level: info

audio:
  active_level: 45
  min_percentile: 30
  update_interval: 200
  smooth_intervals: 2
EOF
else
    log "Existing livekit.yaml found — keeping it."
fi

# ─── Generate .env (if absent) ───────────────────────────────────────────────
if [ ! -f "${INSTALL_DIR}/.env" ]; then
    log "Generating .env with random secrets..."
    JWT_SECRET="$(openssl rand -hex 32)"
    ENCRYPTION_KEY="$(openssl rand -hex 32)"
    SIGNED_URL_SECRET="$(openssl rand -base64 32)"
    PUBLIC_URL=""
    if [ "$MODE" != "plain" ]; then
        PUBLIC_URL="https://${DOMAIN}"
    elif [ -n "$PUBLIC_IP" ]; then
        PUBLIC_URL="http://${PUBLIC_IP}:${MQVI_PORT}"
    fi

    cat > "${INSTALL_DIR}/.env" <<EOF
# mqvi Server Configuration — generated by install.sh

SERVER_HOST=${BIND_HOST}
SERVER_PORT=${MQVI_PORT}

DATABASE_PATH=${DATA_DIR}/mqvi.db

JWT_SECRET=${JWT_SECRET}
JWT_ACCESS_EXPIRY_MINUTES=15
JWT_REFRESH_EXPIRY_DAYS=7

ENCRYPTION_KEY=${ENCRYPTION_KEY}

UPLOAD_DIR=${DATA_DIR}/uploads
UPLOAD_MAX_SIZE=524288000
# MQVI_DEFAULT_QUOTA_BYTES=10737418240

# HMAC secret for signed file URLs (base64-encoded, 32 bytes)
MQVI_SIGNED_URL_SECRET=${SIGNED_URL_SECRET}
EOF

    if [ -n "$PUBLIC_URL" ]; then
        echo "CORS_ORIGINS=${PUBLIC_URL}" >> "${INSTALL_DIR}/.env"
    fi

    if [ -n "$LK_API_KEY" ]; then
        cat >> "${INSTALL_DIR}/.env" <<EOF

# Auto-seed a LiveKit instance on first start so voice works out of the box.
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=${LK_API_KEY}
LIVEKIT_API_SECRET=${LK_API_SECRET}
EOF
    fi
    chmod 600 "${INSTALL_DIR}/.env"
else
    log "Existing .env found — keeping it. (Flags --port/--domain do not modify it.)"
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"

# ─── systemd units ───────────────────────────────────────────────────────────
log "Installing systemd units..."
cat > /etc/systemd/system/mqvi-livekit.service <<EOF
[Unit]
Description=mqvi — LiveKit SFU
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/livekit-server --config ${INSTALL_DIR}/livekit.yaml
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/mqvi-server.service <<EOF
[Unit]
Description=mqvi — Application server
After=network-online.target mqvi-livekit.service
Wants=network-online.target
Requires=mqvi-livekit.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${INSTALL_DIR}/mqvi-server
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mqvi-livekit.service mqvi-server.service >/dev/null

# ─── Caddy install + config (TLS modes only, when not existing) ──────────────
install_caddy() {
    command -v caddy >/dev/null 2>&1 && return 0
    log "Installing Caddy..."
    case "$PKG" in
        apt)
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq
            apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg ca-certificates >/dev/null
            curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
                | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
            curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
                > /etc/apt/sources.list.d/caddy-stable.list
            apt-get update -qq
            apt-get install -y caddy >/dev/null
            ;;
        dnf|yum)
            "$PKG" install -y "dnf-command(copr)" >/dev/null 2>&1 || true
            "$PKG" copr enable -y @caddy/caddy >/dev/null 2>&1 || true
            "$PKG" install -y caddy >/dev/null
            ;;
        *)
            die "Cannot auto-install Caddy on this distro. Install Caddy manually, then re-run with --existing-caddy."
            ;;
    esac
}

write_caddyfile() {
    # Single-site Caddyfile owned by us. If you have other sites, use --existing-caddy instead.
    cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy 127.0.0.1:${MQVI_PORT}
    encode zstd gzip
    request_body {
        max_size 30MB
    }
}
EOF
    systemctl enable caddy >/dev/null 2>&1 || true
}

CADDY_SNIPPET=""
case "$MODE" in
    new-caddy-domain|new-caddy-sslip)
        install_caddy
        write_caddyfile
        ;;
    existing)
        CADDY_SNIPPET=$(cat <<EOF
${DOMAIN:-yourdomain.example} {
    reverse_proxy 127.0.0.1:${MQVI_PORT}
    encode zstd gzip
    request_body {
        max_size 30MB
    }
}
EOF
)
        ;;
esac

# ─── Firewall ────────────────────────────────────────────────────────────────
open_ports() {
    local protos_tcp protos_udp_range
    if [ "$MODE" = "plain" ]; then
        protos_tcp=("${MQVI_PORT}")
    else
        # In TLS modes only 80/443 are public-facing for HTTP. mqvi port is localhost-only.
        protos_tcp=(80 443)
    fi
    # LiveKit — always public (WebRTC needs direct UDP)
    protos_tcp+=(7880 7881)
    protos_udp_range="50000:50200"

    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
        log "Opening UFW ports..."
        for p in "${protos_tcp[@]}"; do ufw allow "${p}"/tcp >/dev/null; done
        ufw allow 7882/udp        >/dev/null
        ufw allow "${protos_udp_range}"/udp >/dev/null
    elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        log "Opening firewalld ports..."
        for p in "${protos_tcp[@]}"; do firewall-cmd --permanent --add-port="${p}"/tcp >/dev/null; done
        firewall-cmd --permanent --add-port=7882/udp                              >/dev/null
        firewall-cmd --permanent --add-port="${protos_udp_range//:/-}"/udp        >/dev/null
        firewall-cmd --reload >/dev/null
    else
        warn "No supported firewall detected. Open these ports manually:"
        warn "  TCP: ${protos_tcp[*]}, 7882"
        warn "  UDP: 7882, ${protos_udp_range}"
    fi
}
open_ports

# ─── Start services ──────────────────────────────────────────────────────────
log "Starting services..."
systemctl restart mqvi-livekit.service
sleep 1
systemctl restart mqvi-server.service
sleep 2

if [ "$MODE" = "new-caddy-domain" ] || [ "$MODE" = "new-caddy-sslip" ]; then
    systemctl restart caddy
    sleep 2
fi

if ! systemctl is-active --quiet mqvi-server.service; then
    warn "mqvi-server did not start. Check logs: journalctl -u mqvi-server -n 50"
    exit 1
fi

# ─── Final output ────────────────────────────────────────────────────────────
PUBLIC_URL=""
case "$MODE" in
    new-caddy-domain|new-caddy-sslip|existing) PUBLIC_URL="https://${DOMAIN}" ;;
    plain) PUBLIC_URL="http://${PUBLIC_IP:-<your-ip>}:${MQVI_PORT}" ;;
esac

echo
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  mqvi is installed and running.                            ║"
echo "╠════════════════════════════════════════════════════════════╣"
printf "║  Web UI:    %-47s║\n" "${PUBLIC_URL}"
printf "║  Install:   %-47s║\n" "${INSTALL_DIR}"
printf "║  Data:      %-47s║\n" "${DATA_DIR}"
echo "║"
echo "║  Logs:      journalctl -u mqvi-server -f"
echo "║  Restart:   systemctl restart mqvi-server"
echo "║  Stop:      systemctl stop mqvi-server mqvi-livekit"
echo "║"
echo "║  The first user to register becomes the server owner."
echo "╚════════════════════════════════════════════════════════════╝"

if [ "$MODE" = "existing" ]; then
    echo
    echo "Caddy was detected on this system. mqvi-server is bound to 127.0.0.1:${MQVI_PORT}."
    echo "Add this block to your Caddyfile and reload Caddy:"
    echo
    echo "    ${CADDY_SNIPPET//$'\n'/$'\n    '}"
    echo
    echo "Then: sudo systemctl reload caddy"
fi

if [ "$MODE" = "plain" ]; then
    echo
    warn "Running over HTTP. Browsers will block microphone/camera/screen-share."
    warn "Re-run with --domain <host> for automatic HTTPS via Let's Encrypt."
fi
