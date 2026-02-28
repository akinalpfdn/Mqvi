# ═══════════════════════════════════════════════════════════════
#  mqvi — LiveKit Auto-Setup Script (Windows)
#
#  Bu script tek komutla LiveKit ses sunucusunu kurar:
#    1. LiveKit binary indirme (GitHub Releases)
#    2. Windows Firewall port acma
#    3. API Key + Secret uretimi
#    4. livekit.yaml olusturma
#    5. LiveKit'i baslatma (+ opsiyonel otomatik baslangic)
#
#  Kullanim (PowerShell'i Yonetici olarak ac):
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

$installDir = "$env:ProgramFiles\LiveKit"
$binaryPath = Join-Path $installDir "livekit-server.exe"
$configPath = Join-Path $installDir "livekit.yaml"

# --- 1/5: LiveKit Binary Indir ---
Write-Host "[1/5] Installing LiveKit..." -ForegroundColor Yellow

if (Test-Path $binaryPath) {
    Write-Host "  LiveKit already installed at $binaryPath" -ForegroundColor Green
} else {
    Write-Host "  Downloading LiveKit binary from GitHub..." -ForegroundColor Yellow

    # En son release'in indirme URL'sini bul
    $releaseInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/livekit/livekit/releases/latest" -TimeoutSec 15
    $version = $releaseInfo.tag_name
    $asset = $releaseInfo.assets | Where-Object { $_.name -match "windows_amd64\.zip$" } | Select-Object -First 1

    if (-not $asset) {
        Write-Host "  Could not find Windows binary in latest release ($version)." -ForegroundColor Red
        Write-Host "  Download manually from: https://github.com/livekit/livekit/releases" -ForegroundColor Yellow
        exit 1
    }

    $zipUrl = $asset.browser_download_url
    $zipPath = Join-Path $env:TEMP "livekit-server.zip"
    $extractPath = Join-Path $env:TEMP "livekit-extract"

    Write-Host "  Downloading $version..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

    # Zip'i ac ve binary'yi tasi
    if (Test-Path $extractPath) { Remove-Item -Recurse -Force $extractPath }
    Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }

    # Binary'yi bul (zip icinde alt klasorde olabilir)
    $exe = Get-ChildItem -Path $extractPath -Recurse -Filter "livekit-server.exe" | Select-Object -First 1
    if (-not $exe) {
        Write-Host "  livekit-server.exe not found in downloaded archive." -ForegroundColor Red
        exit 1
    }

    Copy-Item -Path $exe.FullName -Destination $binaryPath -Force

    # Temizlik
    Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $extractPath -ErrorAction SilentlyContinue

    Write-Host "  LiveKit $version installed to $binaryPath" -ForegroundColor Green
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
Write-Host "[4/5] Creating config..." -ForegroundColor Yellow

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

$yamlContent | Set-Content -Path $configPath -Encoding UTF8
Write-Host "  Config saved to $configPath" -ForegroundColor Green

# --- 5/5: LiveKit Baslat + Task Scheduler (otomatik baslangic) ---
Write-Host "[5/5] Starting LiveKit..." -ForegroundColor Yellow

# Eski process varsa durdur
$existing = Get-Process -Name "livekit-server" -ErrorAction SilentlyContinue
if ($existing) {
    Stop-Process -Name "livekit-server" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# Arka planda baslat
Start-Process -FilePath $binaryPath `
    -ArgumentList "--config", $configPath `
    -WindowStyle Hidden

# Task Scheduler ile otomatik baslangic ayarla
$taskName = "LiveKit Server"
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existingTask) {
    $action = New-ScheduledTaskAction -Execute $binaryPath -Argument "--config `"$configPath`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
    Write-Host "  Auto-start configured (Task Scheduler)." -ForegroundColor Green
}

# Dogrula
Start-Sleep -Seconds 2
$running = Get-Process -Name "livekit-server" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "  LiveKit is running on port 7880." -ForegroundColor Green
} else {
    Write-Host "  LiveKit may have failed to start. Try running manually:" -ForegroundColor Red
    Write-Host "  & `"$binaryPath`" --config `"$configPath`"" -ForegroundColor Yellow
    exit 1
}

# --- Sonuc ---
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
Write-Host "  Config: $configPath" -ForegroundColor Yellow
Write-Host "  Binary: $binaryPath" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Manage:" -ForegroundColor Yellow
Write-Host "    Stop:    Stop-Process -Name livekit-server" -ForegroundColor Yellow
Write-Host "    Start:   Start-Process `"$binaryPath`" -ArgumentList '--config','`"$configPath`"'" -ForegroundColor Yellow
Write-Host ""
Write-Host "  If accessing from outside your local network," -ForegroundColor Yellow
Write-Host "  make sure your router forwards ports 7880, 7881," -ForegroundColor Yellow
Write-Host "  7882, and 50000-60000 to this machine." -ForegroundColor Yellow
Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
