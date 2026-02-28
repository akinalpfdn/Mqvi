# ═══════════════════════════════════════════════════════════════
#  mqvi — LiveKit Auto-Setup Script (Windows)
#
#  Bu script tek komutla LiveKit ses sunucusunu kurar:
#    1. Docker Desktop kurulumu (yoksa)
#    2. Windows Firewall port açma
#    3. API Key + Secret üretimi
#    4. livekit.yaml oluşturma
#    5. LiveKit Docker container başlatma
#
#  Kullanım (PowerShell'i Yönetici olarak aç):
#    irm https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.ps1 | iex
#
# ═══════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  mqvi LiveKit Setup Script (Windows)" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# --- Admin kontrolu ---
$isAdmin = ([Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Error: This script must be run as Administrator." -ForegroundColor Red
    Write-Host "Right-click PowerShell and select 'Run as Administrator', then try again." -ForegroundColor Yellow
    exit 1
}

# --- 1/5: Docker Desktop Kontrolu ---
Write-Host "[1/5] Checking Docker..." -ForegroundColor Yellow

$dockerExists = $false
try {
    $null = Get-Command docker -ErrorAction Stop
    $dockerExists = $true
} catch {
    $dockerExists = $false
}

if ($dockerExists) {
    $dockerVersion = docker --version 2>&1 | Select-Object -First 1
    Write-Host "  Docker already installed: $dockerVersion" -ForegroundColor Green

    # Docker Desktop calisiyormu kontrol et
    try {
        $null = docker info 2>&1
    } catch {
        Write-Host "  Docker Desktop is installed but not running. Please start Docker Desktop and try again." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "  Docker not found. Installing Docker Desktop..." -ForegroundColor Yellow

    $wingetExists = $false
    try {
        $null = Get-Command winget -ErrorAction Stop
        $wingetExists = $true
    } catch {
        $wingetExists = $false
    }

    if ($wingetExists) {
        Write-Host "  Installing via winget..." -ForegroundColor Yellow
        winget install Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
        Write-Host ""
        Write-Host "  Docker Desktop installed!" -ForegroundColor Green
        Write-Host "  Please RESTART your computer, then run this script again." -ForegroundColor Yellow
        Write-Host "  Docker Desktop needs a restart to complete setup." -ForegroundColor Yellow
        exit 0
    } else {
        Write-Host "  winget not available. Please install Docker Desktop manually:" -ForegroundColor Red
        Write-Host "  https://www.docker.com/products/docker-desktop/" -ForegroundColor Cyan
        Write-Host "  After installing, restart your computer and run this script again." -ForegroundColor Yellow
        exit 1
    }
}

# --- 2/5: Firewall Port Acma ---
Write-Host "[2/5] Opening firewall ports..." -ForegroundColor Yellow

$rules = @(
    @{ Name = "LiveKit API (TCP 7880)";        Protocol = "TCP"; Port = "7880" },
    @{ Name = "LiveKit WebRTC TCP (7881)";     Protocol = "TCP"; Port = "7881" },
    @{ Name = "LiveKit WebRTC UDP (7882)";     Protocol = "UDP"; Port = "7882" },
    @{ Name = "LiveKit Media UDP (50000-60000)"; Protocol = "UDP"; Port = "50000-60000" }
)

foreach ($rule in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    if (-not $existing) {
        New-NetFirewallRule `
            -DisplayName $rule.Name `
            -Direction Inbound `
            -Protocol $rule.Protocol `
            -LocalPort $rule.Port `
            -Action Allow | Out-Null
    }
}
Write-Host "  Ports opened: 7880/tcp, 7881/tcp, 7882/udp, 50000-60000/udp" -ForegroundColor Green

# --- 3/5: Credential Uretimi ---
Write-Host "[3/5] Generating credentials..." -ForegroundColor Yellow

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()

# API Key: "LiveKitKey" + 8 random hex chars
$keyBytes = [byte[]]::new(4)
$rng.GetBytes($keyBytes)
$API_KEY = "LiveKitKey" + [BitConverter]::ToString($keyBytes).Replace("-", "").ToLower()

# API Secret: 32 random base64-safe chars
$secretBytes = [byte[]]::new(32)
$rng.GetBytes($secretBytes)
$API_SECRET = [Convert]::ToBase64String($secretBytes) -replace '[/+=]', ''
$API_SECRET = $API_SECRET.Substring(0, [Math]::Min(32, $API_SECRET.Length))

Write-Host "  API Key:    $API_KEY" -ForegroundColor Green
Write-Host "  API Secret: $API_SECRET" -ForegroundColor Green

# --- 4/5: livekit.yaml Olustur ---
Write-Host "[4/5] Creating livekit.yaml..." -ForegroundColor Yellow

$installDir = "$env:USERPROFILE\livekit"
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

$yamlContent = @"
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  ${API_KEY}: ${API_SECRET}
"@

$yamlPath = Join-Path $installDir "livekit.yaml"
$yamlContent | Set-Content -Path $yamlPath -Encoding UTF8
Write-Host "  Config saved to $yamlPath" -ForegroundColor Green

# --- 5/5: LiveKit Docker Container Baslat ---
Write-Host "[5/5] Starting LiveKit..." -ForegroundColor Yellow

# Eski container varsa kaldir
$existing = docker ps -a --format "{{.Names}}" 2>&1 | Where-Object { $_ -eq "livekit" }
if ($existing) {
    docker stop livekit 2>&1 | Out-Null
    docker rm livekit 2>&1 | Out-Null
}

# Docker icin path formatini ayarla (Windows -> Linux path)
$dockerYamlPath = $yamlPath.Replace('\', '/')

docker run -d `
    --name livekit `
    --restart unless-stopped `
    -p 7880:7880 `
    -p 7881:7881 `
    -p 7882:7882/udp `
    -p 50000-60000:50000-60000/udp `
    -v "${dockerYamlPath}:/etc/livekit.yaml" `
    livekit/livekit-server `
    --config /etc/livekit.yaml

# Container'in basladigini dogrula
Start-Sleep -Seconds 3
$running = docker ps --format "{{.Names}}" 2>&1 | Where-Object { $_ -eq "livekit" }

if ($running) {
    Write-Host "  LiveKit is running on port 7880." -ForegroundColor Green
} else {
    Write-Host "  LiveKit failed to start. Run 'docker logs livekit' to see what went wrong." -ForegroundColor Red
    exit 1
}

# --- Sonuc ---
# Public IP bul
$publicIP = "YOUR_SERVER_IP"
try {
    $publicIP = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 5) 2>$null
} catch {
    try {
        $publicIP = (Invoke-RestMethod -Uri "https://ifconfig.me" -TimeoutSec 5) 2>$null
    } catch {
        $publicIP = "YOUR_SERVER_IP"
    }
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  LiveKit is running!" -ForegroundColor Green
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Use these values in mqvi when creating a self-hosted server:"
Write-Host ""
Write-Host "  URL:        " -NoNewline; Write-Host "ws://${publicIP}:7880" -ForegroundColor White
Write-Host "  API Key:    " -NoNewline; Write-Host "$API_KEY" -ForegroundColor White
Write-Host "  API Secret: " -NoNewline; Write-Host "$API_SECRET" -ForegroundColor White
Write-Host ""
Write-Host "  Config file: $yamlPath" -ForegroundColor Yellow
Write-Host ""
Write-Host "  If accessing from outside your local network," -ForegroundColor Yellow
Write-Host "  make sure your router forwards ports 7880, 7881," -ForegroundColor Yellow
Write-Host "  7882, and 50000-60000 to this machine." -ForegroundColor Yellow
Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
