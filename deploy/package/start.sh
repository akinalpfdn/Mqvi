#!/bin/bash
# mqvi — Tek script ile sunucuyu başlat
#
# Kullanım: chmod +x start.sh mqvi-server livekit-server && ./start.sh
#
# Bu script LiveKit SFU ve mqvi backend'i birlikte başlatır.
# Ctrl+C ile her ikisini de temiz şekilde durdurur.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ─── .env kontrolü ───
if [ ! -f .env ]; then
    echo "HATA: .env dosyası bulunamadı!"
    echo "Kopyala: cp .env.example .env"
    echo "Sonra JWT_SECRET'ı değiştir."
    exit 1
fi

# ─── LiveKit binary kontrolü ───
if [ ! -f ./livekit-server ]; then
    echo "LiveKit server bulunamadı. İndiriliyor..."
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64|amd64) LK_ARCH="amd64" ;;
        aarch64|arm64) LK_ARCH="arm64" ;;
        *) echo "Desteklenmeyen mimari: $ARCH"; exit 1 ;;
    esac

    LK_VERSION="v1.8.3"
    LK_URL="https://github.com/livekit/livekit/releases/download/${LK_VERSION}/livekit_${LK_VERSION#v}_linux_${LK_ARCH}.tar.gz"
    echo "İndiriliyor: $LK_URL"
    curl -fsSL "$LK_URL" | tar xz livekit-server
    chmod +x livekit-server
    echo "LiveKit server indirildi."
fi

# ─── Data dizinlerini oluştur ───
mkdir -p data/uploads

echo "========================================="
echo "  mqvi server başlatılıyor..."
echo "========================================="
echo ""

# ─── LiveKit'i arka planda başlat ───
echo "[start] LiveKit SFU başlatılıyor (port 7880)..."
./livekit-server --config livekit.yaml &
LIVEKIT_PID=$!

# ─── Cleanup trap — Ctrl+C veya SIGTERM'de her ikisini durdur ───
cleanup() {
    echo ""
    echo "[start] Sunucular durduruluyor..."
    kill $LIVEKIT_PID 2>/dev/null || true
    kill $MQVI_PID 2>/dev/null || true
    wait $LIVEKIT_PID 2>/dev/null || true
    wait $MQVI_PID 2>/dev/null || true
    echo "[start] Temiz kapanış tamamlandı."
    exit 0
}
trap cleanup SIGINT SIGTERM

# Kısa bekleme — LiveKit'in ayağa kalkması için
sleep 1

# ─── mqvi backend'i başlat ───
echo "[start] mqvi backend başlatılıyor (port 9090)..."
./mqvi-server &
MQVI_PID=$!

echo ""
echo "========================================="
echo "  mqvi çalışıyor!"
echo "  Web UI:  http://$(hostname -I | awk '{print $1}'):9090"
echo "  LiveKit: ws://localhost:7880"
echo "  Durdurmak için: Ctrl+C"
echo "========================================="
echo ""

# Her iki process'i bekle — biri ölürse diğerini de durdur
wait -n $LIVEKIT_PID $MQVI_PID 2>/dev/null || true
cleanup
