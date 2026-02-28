#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  mqvi — LiveKit Auto-Setup Script (Linux)
#
#  Bu script tek komutla LiveKit ses sunucusunu kurar:
#    1. Docker kurulumu (yoksa)
#    2. Firewall port açma (UFW)
#    3. API Key + Secret üretimi
#    4. livekit.yaml oluşturma
#    5. LiveKit Docker container başlatma
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

# ─── 1/5: Docker Kurulumu ───
echo -e "${YELLOW}[1/5] Checking Docker...${NC}"
if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version 2>/dev/null | head -1)
    echo -e "${GREEN}  Docker already installed: ${DOCKER_VERSION}${NC}"
else
    echo "  Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo -e "${GREEN}  Docker installed successfully.${NC}"
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
    # CentOS / RHEL / Fedora
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
echo -e "${YELLOW}[4/5] Creating livekit.yaml...${NC}"
INSTALL_DIR="/opt/livekit"
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

# ─── 5/5: LiveKit Docker Container Başlat ───
echo -e "${YELLOW}[5/5] Starting LiveKit...${NC}"

# Eski container varsa kaldır
if docker ps -a --format '{{.Names}}' | grep -q '^livekit$'; then
    docker stop livekit  >/dev/null 2>&1 || true
    docker rm livekit    >/dev/null 2>&1 || true
fi

docker run -d \
    --name livekit \
    --restart unless-stopped \
    -p 7880:7880 \
    -p 7881:7881 \
    -p 7882:7882/udp \
    -p 50000-60000:50000-60000/udp \
    -v "${INSTALL_DIR}/livekit.yaml:/etc/livekit.yaml" \
    livekit/livekit-server \
    --config /etc/livekit.yaml

# Container'ın başladığını doğrula
sleep 2
if docker ps --format '{{.Names}}' | grep -q '^livekit$'; then
    echo -e "${GREEN}  LiveKit is running on port 7880.${NC}"
else
    echo -e "${RED}  LiveKit failed to start. Run 'docker logs livekit' to see what went wrong.${NC}"
    exit 1
fi

# ─── Sonuç ───
# Sunucunun public IP'sini bul
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
echo -e "  also open these ports there. The terminal commands above"
echo -e "  only configure the OS-level firewall."
echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
