# ═══════════════════════════════════════════════════════════════
#  mqvi — LiveKit Auto-Setup Script (Windows)
#
#  Sets up a LiveKit voice server with a single command:
#    1. Download LiveKit binary (GitHub Releases)
#    2. Open Windows Firewall ports
#    3. Router port forwarding (UPnP)
#    4. Generate API Key + Secret
#    5. Create livekit.yaml config
#    6. Start LiveKit (+ auto-start on boot)
#
#  Usage (run PowerShell as Administrator):
#    irm https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.ps1 | iex
#
# ═══════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  mqvi LiveKit Setup Script (Windows)" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# --- Admin check ---
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

# --- 1/6: Download LiveKit Binary ---
Write-Host "[1/6] Installing LiveKit..." -ForegroundColor Yellow

if (Test-Path $binaryPath) {
    Write-Host "  LiveKit already installed at $binaryPath" -ForegroundColor Green
} else {
    Write-Host "  Downloading LiveKit binary from GitHub..." -ForegroundColor Yellow

    # Find download URL from latest release
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

    # Extract zip and move binary
    if (Test-Path $extractPath) { Remove-Item -Recurse -Force $extractPath }
    Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }

    # Locate binary (may be in a subfolder inside the zip)
    $exe = Get-ChildItem -Path $extractPath -Recurse -Filter "livekit-server.exe" | Select-Object -First 1
    if (-not $exe) {
        Write-Host "  livekit-server.exe not found in downloaded archive." -ForegroundColor Red
        exit 1
    }

    Copy-Item -Path $exe.FullName -Destination $binaryPath -Force

    # Cleanup temp files
    Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $extractPath -ErrorAction SilentlyContinue

    Write-Host "  LiveKit $version installed to $binaryPath" -ForegroundColor Green
}

# --- 2/6: Open Windows Firewall Ports ---
Write-Host "[2/6] Opening Windows Firewall ports..." -ForegroundColor Yellow

$rules = @(
    @{ Name = "LiveKit API (TCP 7880)";        Protocol = "TCP"; Port = "7880" },
    @{ Name = "LiveKit WebRTC TCP (7881)";     Protocol = "TCP"; Port = "7881" },
    @{ Name = "LiveKit WebRTC UDP (7882)";     Protocol = "UDP"; Port = "7882" },
    @{ Name = "LiveKit Media UDP (50000-50100)"; Protocol = "UDP"; Port = "50000-50100" }
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
Write-Host "  Windows Firewall ports opened." -ForegroundColor Green

# --- 3/6: Router Port Forwarding (UPnP) ---
Write-Host "[3/6] Attempting router port forwarding (UPnP)..." -ForegroundColor Yellow

$upnpSuccess = $false
$localIP = $null

try {
    # Detect this PC's LAN IP address
    $localIP = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.PrefixOrigin -ne "WellKnown" } |
        Sort-Object -Property InterfaceMetric |
        Select-Object -First 1).IPAddress

    if (-not $localIP) { throw "Could not detect local IP" }
    Write-Host "  Local IP: $localIP" -ForegroundColor Gray

    $upnp = New-Object -ComObject HNetCfg.NATUPnP
    $mappings = $upnp.StaticPortMappingCollection

    if ($mappings) {
        $portsToForward = @(
            @{ ExtPort = 7880; IntPort = 7880; Proto = "TCP"; Desc = "LiveKit Signaling" },
            @{ ExtPort = 7881; IntPort = 7881; Proto = "TCP"; Desc = "LiveKit TURN" },
            @{ ExtPort = 7882; IntPort = 7882; Proto = "UDP"; Desc = "LiveKit Media" }
        )

        # Media port range (50000-50100) — sufficient for ~100 concurrent participants
        for ($p = 50000; $p -le 50100; $p++) {
            $portsToForward += @{ ExtPort = $p; IntPort = $p; Proto = "UDP"; Desc = "LiveKit ICE $p" }
        }

        $mapped = 0
        $failed = 0
        foreach ($port in $portsToForward) {
            try {
                # Remove existing mapping first (may be pointing to a different device)
                try { $mappings.Remove($port.ExtPort, $port.Proto) } catch {}
                $mappings.Add($port.ExtPort, $port.Proto, $port.IntPort, $localIP, $true, $port.Desc)
                $mapped++
            } catch {
                $failed++
            }
        }

        if ($mapped -gt 0 -and $failed -eq 0) {
            Write-Host "  Router port forwarding successful! ($mapped ports mapped)" -ForegroundColor Green
            $upnpSuccess = $true
        } elseif ($mapped -gt 0) {
            Write-Host "  Partially successful: $mapped ports mapped, $failed failed." -ForegroundColor Yellow
            $upnpSuccess = $true
        } else {
            Write-Host "  UPnP mappings were rejected by the router." -ForegroundColor Yellow
        }
    } else {
        Write-Host "  UPnP is not enabled on your router." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  UPnP port forwarding not available." -ForegroundColor Yellow
}

if (-not $upnpSuccess) {
    Write-Host "  >> You will need to forward ports manually on your router." -ForegroundColor Red
    Write-Host "  >> See instructions at the end of this script." -ForegroundColor Red
}

# --- 4/6: Generate Credentials ---
Write-Host "[4/6] Generating credentials..." -ForegroundColor Yellow

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

# --- 5/6: Create livekit.yaml ---
Write-Host "[5/6] Creating config..." -ForegroundColor Yellow

$yamlContent = @"
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  ${API_KEY}: ${API_SECRET}
"@

$yamlContent | Set-Content -Path $configPath -Encoding UTF8
Write-Host "  Config saved to $configPath" -ForegroundColor Green

# --- 6/6: Start LiveKit + Task Scheduler (auto-start on boot) ---
Write-Host "[6/6] Starting LiveKit..." -ForegroundColor Yellow

# Stop existing process if running
$existing = Get-Process -Name "livekit-server" -ErrorAction SilentlyContinue
if ($existing) {
    Stop-Process -Name "livekit-server" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# Start in background
Start-Process -FilePath $binaryPath `
    -ArgumentList "--config", $configPath `
    -WindowStyle Hidden

# Configure auto-start via Task Scheduler
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

# Verify it started
Start-Sleep -Seconds 2
$running = Get-Process -Name "livekit-server" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "  LiveKit is running on port 7880." -ForegroundColor Green
} else {
    Write-Host "  LiveKit may have failed to start. Try running manually:" -ForegroundColor Red
    Write-Host "  & `"$binaryPath`" --config `"$configPath`"" -ForegroundColor Yellow
    exit 1
}

# --- Result ---
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

# --- Verify external port accessibility ---
# LiveKit is running on port 7880. Try to reach it from the public IP
# to confirm that firewall + router forwarding are working correctly.
# Method 1: TCP connection test (works if router supports NAT hairpinning)
# Method 2: HTTP request to LiveKit (returns 200 if reachable)
Write-Host ""
Write-Host "Verifying external port accessibility..." -ForegroundColor Yellow

$portsVerified = $false
if ($publicIP -ne "YOUR_SERVER_IP") {
    # Method 1: Test-NetConnection (fast TCP check)
    try {
        $tcpResult = Test-NetConnection -ComputerName $publicIP -Port 7880 `
            -WarningAction SilentlyContinue -InformationLevel Quiet
        if ($tcpResult) { $portsVerified = $true }
    } catch {}

    # Method 2: HTTP request fallback (LiveKit returns 200 on HTTP GET)
    if (-not $portsVerified) {
        try {
            $httpResult = Invoke-WebRequest -Uri "http://${publicIP}:7880" `
                -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
            if ($httpResult.StatusCode -eq 200) { $portsVerified = $true }
        } catch {}
    }
}

if ($portsVerified) {
    Write-Host "  Port 7880 is externally accessible!" -ForegroundColor Green
} else {
    Write-Host "  Could not verify external access (NAT hairpin may not be supported)." -ForegroundColor Yellow
    Write-Host "  This does NOT necessarily mean ports are closed." -ForegroundColor Yellow
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

# Show port forwarding status based on actual verification
if ($portsVerified) {
    Write-Host ""
    Write-Host "  Ports are externally accessible. You're all set!" -ForegroundColor Green
} elseif (-not $upnpSuccess) {
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════════╗" -ForegroundColor Red
    Write-Host "  ║  ROUTER PORT FORWARDING REQUIRED                       ║" -ForegroundColor Red
    Write-Host "  ║                                                        ║" -ForegroundColor Red
    Write-Host "  ║  Ports are NOT externally accessible.                  ║" -ForegroundColor Red
    Write-Host "  ║  You MUST forward these ports on your router:          ║" -ForegroundColor Red
    Write-Host "  ║                                                        ║" -ForegroundColor Red
    Write-Host "  ║    7880  TCP   (signaling)                             ║" -ForegroundColor Red
    Write-Host "  ║    7881  TCP   (TURN relay)                            ║" -ForegroundColor Red
    Write-Host "  ║    7882  UDP   (media)                                 ║" -ForegroundColor Red
    Write-Host "  ║    50000-50100 UDP (ICE candidates)                    ║" -ForegroundColor Red
    Write-Host "  ║                                                        ║" -ForegroundColor Red
    Write-Host "  ║  Open your router admin (usually 192.168.1.1) and     ║" -ForegroundColor Red
    Write-Host "  ║  forward these ports to: $($localIP ?? 'this PC')                    ║" -ForegroundColor Red
    Write-Host "  ╚══════════════════════════════════════════════════════════╝" -ForegroundColor Red
} else {
    Write-Host ""
    Write-Host "  UPnP forwarded ports, but could not verify from this network." -ForegroundColor Yellow
    Write-Host "  Try connecting from another device to confirm it works." -ForegroundColor Yellow
    Write-Host "  If it doesn't, forward ports manually (7880, 7881, 7882, 50000-50100)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# Keep window open so user can see and copy credentials
Read-Host "Press Enter to close this window"
