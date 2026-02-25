# Electron build script for Windows
# Usage:
#   powershell -ExecutionPolicy Bypass -File build.ps1          # unpacked dir only
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Nsis    # NSIS installer

param(
    [switch]$Nsis
)

$ErrorActionPreference = "Stop"

# Skip code signing for unsigned builds
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

# Clean previous output
if (Test-Path "release") {
    try {
        Remove-Item -Recurse -Force "release" -ErrorAction Stop
    } catch {
        Write-Host "release/ silinemedi - dosya kilitli. Resource Monitor aciliyor..." -ForegroundColor Red
        Start-Process "resmon.exe"
        Write-Host "Resource Monitor > CPU > Associated Handles > 'app.asar' ara > process'i kapat" -ForegroundColor Yellow
        throw "release/ dizini kilitli - kilidi kaldirip tekrar calistir"
    }
}

# Build client
Write-Host "Building client..." -ForegroundColor Cyan
Push-Location client
& "C:\Program Files\nodejs\npx.cmd" vite build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Client build failed" }
Pop-Location

# Compile Electron TypeScript
Write-Host "Compiling Electron TypeScript..." -ForegroundColor Cyan
& "C:\Program Files\nodejs\npx.cmd" tsc -p electron/tsconfig.json
if ($LASTEXITCODE -ne 0) { throw "Electron TS compilation failed" }

# Phase 1: Build unpacked directory
# signAndEditExecutable: false is set in package.json because winCodeSign
# extraction fails on non-admin Windows (macOS symlink error).
# We build unpacked first, then embed icon manually with rcedit.
Write-Host "Phase 1: Building unpacked app..." -ForegroundColor Cyan
& "C:\Program Files\nodejs\npx.cmd" electron-builder --win --dir
if ($LASTEXITCODE -ne 0) { throw "electron-builder (unpacked) failed" }

# Phase 2: Embed custom icon into EXE using rcedit binary
# The rcedit npm package ships with rcedit-x64.exe in its bin/ directory.
# This runs BEFORE the NSIS step so the installer contains the patched exe.
$rceditBin = "node_modules\rcedit\bin\rcedit-x64.exe"
$exePath = "release\win-unpacked\mqvi.exe"
$icoPath = "icons\mqvi-icon.ico"

if ((Test-Path $exePath) -and (Test-Path $rceditBin)) {
    Write-Host "Phase 2: Embedding icon into EXE..." -ForegroundColor Cyan
    & $rceditBin $exePath --set-icon $icoPath
    if ($LASTEXITCODE -ne 0) { throw "rcedit icon embedding failed" }
    Write-Host "Icon embedded successfully" -ForegroundColor Green
}

# Phase 3: Build NSIS installer from the patched unpacked directory
if ($Nsis) {
    Write-Host "Phase 3: Building NSIS installer from patched app..." -ForegroundColor Cyan
    & "C:\Program Files\nodejs\npx.cmd" electron-builder --win nsis --prepackaged release/win-unpacked
    if ($LASTEXITCODE -ne 0) { throw "electron-builder (NSIS) failed" }
}

# Generate app-update.yml for electron-updater
# electron-builder creates this only for installer builds, but electron-updater
# always looks for it on startup. Without it: ENOENT error.
$resourcesDir = "release\win-unpacked\resources"
if (Test-Path $resourcesDir) {
    $updateYml = @"
provider: github
owner: akinalpfdn
repo: Mqvi
updaterCacheDirName: mqvi-desktop-updater
"@
    Set-Content -Path "$resourcesDir\app-update.yml" -Value $updateYml -Encoding UTF8
    Write-Host "Created app-update.yml" -ForegroundColor Green
}

Write-Host "Build complete! Output: release/" -ForegroundColor Green
