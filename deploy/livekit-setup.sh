#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  mqvi — LiveKit Auto-Setup Script (Linux)
#
#  Bu script tek komutla LiveKit ses sunucusunu kurar:
#    1. LiveKit binary indirme (resmi install script)
#    2. Firewall port açma (UFW / firewalld)
#    3. API Key + Secret üretimi
#    4. livekit.yaml oluşturma
#    5. LiveKit'i systemd service olarak başlatma
#
#  Kullanım:
#    curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.sh | sudo bash
#
# ═══════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

INSTALL_DIR="/opt/livekit"

echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo -e "${CYAN}  mqvi LiveKit Setup Script (Linux)${NC}"
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo ""

# ─── Root kontrolü ───
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: This script must be run as root.${NC}"
    echo "Usage: sudo bash livekit-setup.sh"
    echo "  or:  curl -fsSL <url> | sudo bash"
    exit 1
fi

# ─── 1/5: LiveKit Binary İndirme ───
echo -e "${YELLOW}[1/5] Installing LiveKit...${NC}"
if command -v livekit-server &> /dev/null; then
    LK_VERSION=$(livekit-server --version 2>/dev/null || echo "installed")
    echo -e "${GREEN}  LiveKit already installed: ${LK_VERSION}${NC}"
else
    echo "  Downloading LiveKit binary..."
    curl -sSL https://get.livekit.io | bash
    echo -e "${GREEN}  LiveKit installed successfully.${NC}"
fi

# ─── 2/5: Firewall Port Açma ───
echo -e "${YELLOW}[2/5] Opening firewall ports...${NC}"
if command -v ufw &> /dev/null; then
    ufw allow 7880/tcp   >/dev/null 2>&1
    ufw allow 7881/tcp   >/dev/null 2>&1
    ufw allow 7882/udp   >/dev/null 2>&1
    ufw allow 50000:60000/udp >/dev/null 2>&1
    ufw --force enable    >/dev/null 2>&1
    echo -e "${GREEN}  Ports opened: 7880/tcp, 7881/tcp, 7882/udp, 50000-60000/udp${NC}"
elif command -v firewall-cmd &> /dev/null; then
    firewall-cmd --permanent --add-port=7880/tcp  >/dev/null 2>&1
    firewall-cmd --permanent --add-port=7881/tcp  >/dev/null 2>&1
    firewall-cmd --permanent --add-port=7882/udp  >/dev/null 2>&1
    firewall-cmd --permanent --add-port=50000-60000/udp >/dev/null 2>&1
    firewall-cmd --reload >/dev/null 2>&1
    echo -e "${GREEN}  Ports opened (firewalld): 7880/tcp, 7881/tcp, 7882/udp, 50000-60000/udp${NC}"
else
    echo -e "${YELLOW}  No firewall manager found (ufw/firewalld). Make sure ports 7880, 7881, 7882, 50000-60000 are open.${NC}"
fi

# ─── 3/5: Credential Üretimi ───
echo -e "${YELLOW}[3/5] Generating credentials...${NC}"
API_KEY="LiveKitKey$(openssl rand -hex 4)"
API_SECRET=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
echo -e "${GREEN}  API Key:    ${API_KEY}${NC}"
echo -e "${GREEN}  API Secret: ${API_SECRET}${NC}"

# ─── 4/5: livekit.yaml Oluştur ───
echo -e "${YELLOW}[4/5] Creating config...${NC}"
mkdir -p "$INSTALL_DIR"

cat > "${INSTALL_DIR}/livekit.yaml" << EOF
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  ${API_KEY}: ${API_SECRET}
EOF

echo -e "${GREEN}  Config saved to ${INSTALL_DIR}/livekit.yaml${NC}"

# ─── 5/5: Systemd Service Oluştur ve Başlat ───
echo -e "${YELLOW}[5/5] Setting up LiveKit service...${NC}"

# livekit-server binary path bul
LK_BIN=$(command -v livekit-server 2>/dev/null || echo "/usr/local/bin/livekit-server")

cat > /etc/systemd/system/livekit.service << EOF
[Unit]
Description=LiveKit SFU Server
After=network.target

[Service]
Type=simple
ExecStart=${LK_BIN} --config ${INSTALL_DIR}/livekit.yaml
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable livekit  >/dev/null 2>&1
systemctl restart livekit

# Başladığını doğrula
sleep 2
if systemctl is-active --quiet livekit; then
    echo -e "${GREEN}  LiveKit service is running on port 7880.${NC}"
else
    echo -e "${RED}  LiveKit failed to start. Run 'journalctl -u livekit -n 20' to see what went wrong.${NC}"
    exit 1
fi

# ─── Sonuç ───
PUBLIC_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || curl -s --max-time 5 https://ifconfig.me 2>/dev/null || echo "YOUR_SERVER_IP")

echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  LiveKit is running!${NC}"
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo ""
echo -e "  Use these values in mqvi when creating a self-hosted server:"
echo ""
echo -e "  ${CYAN}URL:        ${NC}ws://${PUBLIC_IP}:7880"
echo -e "  ${CYAN}API Key:    ${NC}${API_KEY}"
echo -e "  ${CYAN}API Secret: ${NC}${API_SECRET}"
echo ""
echo -e "  ${YELLOW}Important:${NC} If your cloud provider has a web-based firewall"
echo -e "  (like Hetzner, DigitalOcean, AWS Security Groups), you must"
echo -e "  also open these ports there."
echo ""
echo -e "  Manage: systemctl {start|stop|restart|status} livekit"
echo -e "  Logs:   journalctl -u livekit -f"
echo -e "  Config: ${INSTALL_DIR}/livekit.yaml"
echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
