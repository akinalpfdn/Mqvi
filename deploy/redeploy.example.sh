#!/usr/bin/env bash
# mqvi Redeploy Script (Linux / macOS)
#
# Usage:
#   1. Copy this file: cp redeploy.example.sh redeploy.sh
#   2. Update SERVER with your server IP
#   3. Run: ./deploy/redeploy.sh
#
# Skip build: ./deploy/redeploy.sh --skip-build

set -e

SERVER="root@YOUR_SERVER_IP"
REMOTE_PATH="~/mqvi"
SSH_KEY="$HOME/.ssh/YOUR_SSH_KEY"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SKIP_BUILD=false

for arg in "$@"; do
    case $arg in
        --skip-build) SKIP_BUILD=true ;;
    esac
done

echo ""
echo "========================================="
echo "  mqvi Redeploy"
echo "========================================="
echo ""

# --- SSH Agent: ask passphrase once ---
echo "[1/5] Setting up SSH agent..."
if [ -z "$SSH_AUTH_SOCK" ]; then
    eval "$(ssh-agent -s)" > /dev/null 2>&1
    STARTED_AGENT=true
fi
ssh-add "$SSH_KEY" 2>/dev/null || true
echo "  OK - SSH key loaded"

# --- Build ---
if [ "$SKIP_BUILD" = false ]; then
    echo ""
    echo "[2/5] Building..."
    cd "$PROJECT_ROOT"

    # Frontend
    echo "  Building frontend..."
    cd client
    npm run build
    cd ..

    # Copy frontend to server/static/dist for embedding
    echo "  Copying frontend assets..."
    rm -rf server/static/dist
    cp -r client/dist server/static/dist

    # Go cross-compile
    echo "  Compiling Go binary (linux/amd64)..."
    cd server
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "$SCRIPT_DIR/package/mqvi-server" .
    cd ..

    echo "  OK - Build complete"
else
    echo ""
    echo "[2/5] Build skipped (--skip-build)"
fi

# --- Stop server ---
echo ""
echo "[3/5] Stopping server..."
ssh "$SERVER" "pkill -9 -f livekit-server; pkill -9 -f mqvi-server; sleep 1" || true
echo "  OK - Server stopped"

# --- Upload binary ---
echo ""
echo "[4/5] Uploading binary..."
scp "$SCRIPT_DIR/package/mqvi-server" "$SERVER:$REMOTE_PATH/mqvi-server"
echo "  OK - Binary uploaded"

# --- Start server ---
echo ""
echo "[5/5] Starting server..."
ssh "$SERVER" "cd $REMOTE_PATH && chmod +x mqvi-server start.sh && nohup ./start.sh > output.log 2>&1 &"
sleep 3
echo "  OK - Server started"

# --- Show logs ---
echo ""
echo "========================================="
echo "  Recent logs:"
echo "========================================="
ssh "$SERVER" "tail -15 $REMOTE_PATH/output.log"

echo ""
echo "  Redeploy complete!"
echo ""

# Cleanup: stop agent if we started it
if [ "$STARTED_AGENT" = true ]; then
    kill "$SSH_AGENT_PID" 2>/dev/null || true
fi
