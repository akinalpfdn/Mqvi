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
echo "[1/7] Setting up SSH agent..."
if [ -z "$SSH_AUTH_SOCK" ]; then
    eval "$(ssh-agent -s)" > /dev/null 2>&1
    STARTED_AGENT=true
fi
ssh-add "$SSH_KEY" 2>/dev/null || true
echo "  OK - SSH key loaded"

# --- Build ---
if [ "$SKIP_BUILD" = false ]; then
    echo ""
    echo "[2/7] Building..."
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
    echo "[2/7] Build skipped (--skip-build)"
fi

# --- Preflight: nothing is touched yet, so a failure here costs nothing ---
echo ""
echo "[3/7] Preflight..."
if ! ssh "$SERVER" "cd $REMOTE_PATH && test -f data/mqvi.db"; then
    echo "  ERROR: no database at $REMOTE_PATH/data/mqvi.db - cannot back up, refusing to deploy."
    echo "  (If DATABASE_PATH in .env points elsewhere, update the path in this script.)"
    exit 1
fi
PORT=$(ssh "$SERVER" "cd $REMOTE_PATH && grep -E '^SERVER_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -dc '0-9'")
PORT=${PORT:-9090}
CAN_HEALTHCHECK=true
ssh "$SERVER" "command -v curl >/dev/null" || CAN_HEALTHCHECK=false
echo "  OK - database found, port $PORT, health check $([ "$CAN_HEALTHCHECK" = true ] && echo available || echo 'SKIPPED (no curl on server)')"

# --- Stop server ---
# SIGTERM first: the server handles it (signal.Notify + srv.Shutdown) and closes SQLite cleanly.
# SIGKILL on a database writer is how a WAL ends up needing recovery. Escalate only if it hangs.
echo ""
echo "[4/7] Stopping server..."
ssh "$SERVER" "pkill -TERM -f mqvi-server || true
for i in \$(seq 1 15); do pgrep -f mqvi-server >/dev/null || break; sleep 1; done
pkill -9 -f mqvi-server 2>/dev/null && echo '  WARNING: had to SIGKILL the server' || true
pkill -9 -f livekit-server || true
sleep 1" || true
echo "  OK - Server stopped"

# --- Back up the database ---
# After the stop, so a plain copy is consistent and no sqlite3 CLI is needed. Before the swap,
# because migrations run at boot and rewrite rows the moment the new binary starts — 083 backfills
# a read watermark for every DM conversation. This is the only thing between a bad migration and
# the data.
echo ""
echo "[5/7] Backing up the database..."
STAMP=$(date +%Y%m%d-%H%M%S)
if ! ssh "$SERVER" "cd $REMOTE_PATH && mkdir -p backups && cp -a data/mqvi.db backups/mqvi-$STAMP.db && for f in data/mqvi.db-wal data/mqvi.db-shm; do test -f \$f && cp -a \$f backups/mqvi-$STAMP.db\${f##*mqvi.db} || true; done; ls -lh backups/mqvi-$STAMP.db"; then
    echo "  ERROR: backup failed. The old binary and database are untouched."
    echo "  Bring the server back up: ssh $SERVER \"cd $REMOTE_PATH && nohup ./start.sh > output.log 2>&1 &\""
    exit 1
fi
echo "  OK - backups/mqvi-$STAMP.db"

# --- Upload binary + start script ---
echo ""
echo "[6/7] Uploading binary and start script..."
scp "$SCRIPT_DIR/package/mqvi-server" "$SCRIPT_DIR/start.sh" "$SERVER:$REMOTE_PATH/"
echo "  OK - Files uploaded"

# --- Start server + readiness gate ---
# 083's backfill is ~0.1s per 100k messages, so a normal instance is up in well under a second and
# a large one may take a few. The gate waits rather than assuming three seconds is enough.
echo ""
echo "[7/7] Starting server..."
ssh "$SERVER" "cd $REMOTE_PATH && chmod +x mqvi-server start.sh && nohup ./start.sh > output.log 2>&1 &"
sleep 3

if [ "$CAN_HEALTHCHECK" = true ]; then
    echo "  Waiting for readiness..."
    READY=false
    for i in $(seq 1 30); do
        # /api/health/ready does a real database round trip. /api/health only says the process is
        # alive, which it would keep saying while every write timed out.
        if ssh "$SERVER" "curl -fsS -m 5 http://127.0.0.1:$PORT/api/health/ready" >/dev/null 2>&1; then
            READY=true
            break
        fi
        sleep 2
    done

    if [ "$READY" = false ]; then
        echo ""
        echo "  DEPLOY FAILED - the server never became ready."
        ssh "$SERVER" "tail -40 $REMOTE_PATH/output.log"
        echo ""
        echo "  Roll back the database:"
        echo "    ssh $SERVER \"cd $REMOTE_PATH && pkill -TERM -f mqvi-server; sleep 3; cp -a backups/mqvi-$STAMP.db data/mqvi.db\""
        echo "  then redeploy the previous binary."
        exit 1
    fi
    echo "  OK - Server is ready"
else
    echo "  OK - Server started (readiness not verified: no curl on the server)"
fi

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
