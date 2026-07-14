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

# --- Back up the database ---
# Before the binary swap, not after. Migrations run at boot and some of them rewrite existing
# rows (083 backfills every DM's read watermark), so the moment the new binary starts, the old
# schema is gone. This is the only thing standing between a bad migration and the data.
# .backup is used rather than cp: it is safe against a live writer, cp is not.
echo ""
echo "[3/6] Backing up the database..."
BACKUP="db-backup-$(date +%Y%m%d-%H%M%S).sqlite"
ssh "$SERVER" "cd $REMOTE_PATH && sqlite3 mqvi.db \".backup '$BACKUP'\" && ls -lh $BACKUP"
echo "  OK - Backed up to $BACKUP"
echo "  To roll back: stop the server, mv $BACKUP mqvi.db, redeploy the previous binary."

# --- Stop server ---
# SIGTERM first so in-flight requests finish and SQLite closes its WAL cleanly. -9 on a database
# writer is how a WAL ends up needing recovery. Escalate only if it refuses to go.
echo ""
echo "[4/6] Stopping server..."
ssh "$SERVER" "pkill -TERM -f mqvi-server || true
for i in \$(seq 1 15); do pgrep -f mqvi-server >/dev/null || break; sleep 1; done
pkill -9 -f mqvi-server 2>/dev/null && echo '  WARNING: had to SIGKILL the server' || true
pkill -9 -f livekit-server || true
sleep 1" || true
echo "  OK - Server stopped"

# --- Upload binary + start script ---
echo ""
echo "[5/6] Uploading binary and start script..."
scp "$SCRIPT_DIR/package/mqvi-server" "$SCRIPT_DIR/start.sh" "$SERVER:$REMOTE_PATH/"
echo "  OK - Files uploaded"

# --- Start server + health gate ---
# Migrations run at boot. Migration 083 backfills a read watermark for every DM conversation:
# roughly 0.1s per 100k messages, so a normal instance is up in well under a second, but a large
# one may take a few. That is why the gate waits rather than assuming.
echo ""
echo "[6/6] Starting server..."
ssh "$SERVER" "cd $REMOTE_PATH && chmod +x mqvi-server start.sh && nohup ./start.sh > output.log 2>&1 &"

echo "  Waiting for readiness..."
READY=false
for i in $(seq 1 30); do
    sleep 2
    # /api/health/ready does a real database round trip and reports the pool. /api/health only
    # says the process is alive, which it would say while every write timed out.
    if ssh "$SERVER" "curl -fsS -m 5 http://127.0.0.1:8080/api/health/ready" >/dev/null 2>&1; then
        READY=true
        break
    fi
done

if [ "$READY" = false ]; then
    echo ""
    echo "  DEPLOY FAILED - the server never became ready."
    echo "  Logs:"
    ssh "$SERVER" "tail -40 $REMOTE_PATH/output.log"
    echo ""
    echo "  Roll back:  ssh $SERVER 'cd $REMOTE_PATH && pkill -TERM -f mqvi-server; sleep 3; mv $BACKUP mqvi.db'"
    echo "  then redeploy the previous binary."
    exit 1
fi
echo "  OK - Server is ready"

# --- Show logs ---
echo ""
echo "========================================="
echo "  Recent logs:"
echo "========================================="
ssh "$SERVER" "tail -15 $REMOTE_PATH/output.log"

echo ""
echo "  Redeploy complete!"
echo ""
echo "  Kill switches (no redeploy needed — set in .env and restart):"
echo "    MQVI_PUSH_DM_DELAY=0            # push DMs immediately; stop waiting on the read watermark"
echo "    MQVI_PUSH_DM_READ_RETRACTION=false  # stop pulling read notifications back off the tray"
echo "    MQVI_PUSH_MAX_CONCURRENT=16     # lower it if push is starving the database pool"
echo ""

# Cleanup: stop agent if we started it
if [ "$STARTED_AGENT" = true ]; then
    kill "$SSH_AGENT_PID" 2>/dev/null || true
fi
