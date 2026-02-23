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
Write-Host "[1/5] Setting up SSH agent..." -ForegroundColor Yellow
$agentService = Get-Service ssh-agent -ErrorAction SilentlyContinue
if ($agentService -and $agentService.Status -ne 'Running') {
    Start-Service ssh-agent
}
ssh-add $SshKey 2>$null
Write-Host "  OK - SSH key loaded" -ForegroundColor Green

# --- Build ---
if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "[2/5] Building..." -ForegroundColor Yellow
    $buildScript = Join-Path $ScriptDir "build.ps1"
    & powershell -ExecutionPolicy Bypass -File $buildScript
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: Build failed!" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK - Build complete" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[2/5] Build skipped (-SkipBuild)" -ForegroundColor DarkGray
}

# --- Stop server ---
Write-Host ""
Write-Host "[3/5] Stopping server..." -ForegroundColor Yellow
ssh $Server "pkill -9 -f livekit-server; pkill -9 -f mqvi-server; sleep 1"
Write-Host "  OK - Server stopped" -ForegroundColor Green

# --- Upload binary ---
Write-Host ""
Write-Host "[4/5] Uploading binary..." -ForegroundColor Yellow
$binaryPath = Join-Path $ScriptDir "package\mqvi-server"
scp $binaryPath "${Server}:${RemotePath}/mqvi-server"
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: SCP failed!" -ForegroundColor Red
    exit 1
}
Write-Host "  OK - Binary uploaded" -ForegroundColor Green

# --- Start server ---
Write-Host ""
Write-Host "[5/5] Starting server..." -ForegroundColor Yellow
ssh $Server "cd $RemotePath && chmod +x mqvi-server start.sh && nohup ./start.sh > output.log 2>&1 &"
Start-Sleep -Seconds 3
Write-Host "  OK - Server started" -ForegroundColor Green

# --- Show logs ---
Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Recent logs:" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
ssh $Server "tail -15 $RemotePath/output.log"

Write-Host ""
Write-Host "  Redeploy complete!" -ForegroundColor Green
Write-Host ""
