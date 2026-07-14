# mqvi Redeploy Script (Windows PowerShell)
#
# Usage:
#   1. Copy this file: Copy-Item redeploy.example.ps1 redeploy.ps1
#   2. Update -Server with your server IP and -SshKey with your key path
#   3. Run: powershell -ExecutionPolicy Bypass -File deploy\redeploy.ps1

param(
    [string]$Server = "root@YOUR_SERVER_IP",
    [string]$RemotePath = "~/mqvi",
    [string]$SshKey = "$env:USERPROFILE\.ssh\YOUR_SSH_KEY",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  mqvi Redeploy" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# --- SSH Agent: ask passphrase once ---
Write-Host "[1/7] Setting up SSH agent..." -ForegroundColor Yellow
$agentService = Get-Service ssh-agent -ErrorAction SilentlyContinue
if ($agentService) {
    if ($agentService.StartType -eq 'Disabled' -or $agentService.Status -ne 'Running') {
        Write-Host "  SSH agent needs admin to start (one-time)..." -ForegroundColor DarkYellow
        $proc = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList `
            '-NoProfile -Command "Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent"'
        if ($proc.ExitCode -ne 0) {
            Write-Host "  ERROR: Could not start ssh-agent. Run as admin once or enable the service manually." -ForegroundColor Red
            exit 1
        }
    }
}
$ErrorActionPreference = "Continue"
ssh-add $SshKey 2>$null
$ErrorActionPreference = "Stop"
Write-Host "  OK - SSH key loaded" -ForegroundColor Green

# --- Build ---
if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "[2/7] Building..." -ForegroundColor Yellow
    $buildScript = Join-Path $ScriptDir "build.ps1"
    & powershell -ExecutionPolicy Bypass -File $buildScript
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: Build failed!" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK - Build complete" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[2/7] Build skipped (-SkipBuild)" -ForegroundColor DarkGray
}

# --- Preflight: nothing is touched yet, so a failure here costs nothing ---
# ssh is EXPECTED to exit non-zero here, so stop ErrorActionPreference from turning that into a throw.
$ErrorActionPreference = "Continue"
Write-Host ""
Write-Host "[3/7] Preflight..." -ForegroundColor Yellow
ssh $Server "cd $RemotePath && test -f data/mqvi.db"
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: no database at $RemotePath/data/mqvi.db - cannot back up, refusing to deploy." -ForegroundColor Red
    Write-Host "  (If DATABASE_PATH in .env points elsewhere, update the path in this script.)" -ForegroundColor Red
    exit 1
}
$port = (ssh $Server "cd $RemotePath && grep -E '^SERVER_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -dc '0-9'")
if (-not $port) { $port = "9090" }
ssh $Server "command -v curl > /dev/null"
$canHealthCheck = ($LASTEXITCODE -eq 0)
Write-Host "  OK - database found, port $port, health check $(if ($canHealthCheck) { 'available' } else { 'SKIPPED (no curl on server)' })" -ForegroundColor Green

# --- Stop server ---
# SIGTERM first: the server handles it (signal.Notify + srv.Shutdown) and closes SQLite cleanly.
# SIGKILL on a database writer is how a WAL ends up needing recovery. Escalate only if it hangs.
Write-Host ""
Write-Host "[4/7] Stopping server..." -ForegroundColor Yellow
ssh $Server "pkill -TERM -f mqvi-server || true; for i in `$(seq 1 15); do pgrep -f mqvi-server > /dev/null || break; sleep 1; done; pkill -9 -f mqvi-server 2>/dev/null && echo '  WARNING: had to SIGKILL the server' || true; pkill -9 -f livekit-server || true; sleep 1"
Write-Host "  OK - Server stopped" -ForegroundColor Green

# --- Back up the database ---
# After the stop, so a plain copy is consistent and no sqlite3 CLI is needed. Before the swap,
# because migrations run at boot and rewrite rows the moment the new binary starts.
Write-Host ""
Write-Host "[5/7] Backing up the database..." -ForegroundColor Yellow
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
ssh $Server "cd $RemotePath && mkdir -p backups && cp -a data/mqvi.db backups/mqvi-$stamp.db && for f in data/mqvi.db-wal data/mqvi.db-shm; do test -f `$f && cp -a `$f backups/mqvi-$stamp.db`${f##*mqvi.db} || true; done; ls -lh backups/mqvi-$stamp.db"
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: backup failed. The old binary and database are untouched." -ForegroundColor Red
    Write-Host "  Bring the server back up: ssh $Server `"cd $RemotePath && nohup ./start.sh > output.log 2>&1 &`"" -ForegroundColor Yellow
    exit 1
}
Write-Host "  OK - backups/mqvi-$stamp.db" -ForegroundColor Green

# --- Upload binary + start script ---
Write-Host ""
Write-Host "[6/7] Uploading binary and start script..." -ForegroundColor Yellow
$binaryPath = Join-Path $ScriptDir "package\mqvi-server"
$startScriptPath = Join-Path $ScriptDir "start.sh"
scp $binaryPath $startScriptPath "${Server}:${RemotePath}/"
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: SCP failed!" -ForegroundColor Red
    exit 1
}
Write-Host "  OK - Files uploaded" -ForegroundColor Green

# --- Start server ---
# Migrations run at boot. 083 backfills a read watermark for every DM conversation (~0.1s per
# 100k messages), so the gate below waits for readiness rather than assuming three seconds is it.
Write-Host ""
Write-Host "[7/7] Starting server..." -ForegroundColor Yellow
ssh $Server "cd $RemotePath && chmod +x mqvi-server start.sh && nohup ./start.sh > output.log 2>&1 &"
Start-Sleep -Seconds 3

if ($canHealthCheck) {
    Write-Host "  Waiting for readiness..." -ForegroundColor Yellow
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        # /api/health/ready does a real database round trip. /api/health only says the process
        # is alive, which it would keep saying while every write timed out.
        ssh $Server "curl -fs -m 5 http://127.0.0.1:$port/api/health/ready > /dev/null"
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) {
        Write-Host ""
        Write-Host "  DEPLOY FAILED - the server never became ready." -ForegroundColor Red
        ssh $Server "tail -40 $RemotePath/output.log"
        Write-Host ""
        Write-Host "  Roll back the database:" -ForegroundColor Yellow
        Write-Host "    ssh $Server `"cd $RemotePath && pkill -TERM -f mqvi-server; sleep 3; cp -a backups/mqvi-$stamp.db data/mqvi.db`"" -ForegroundColor Yellow
        Write-Host "  then redeploy the previous binary." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  OK - Server is ready" -ForegroundColor Green
} else {
    Write-Host "  OK - Server started (readiness not verified: no curl on the server)" -ForegroundColor DarkYellow
}
$ErrorActionPreference = "Stop"

# --- Show logs ---
Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Recent logs:" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
ssh $Server "tail -15 $RemotePath/output.log"

Write-Host ""
Write-Host "  Redeploy complete!" -ForegroundColor Green
Write-Host ""
