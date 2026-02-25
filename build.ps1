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

# Package with electron-builder
Write-Host "Packaging with electron-builder..." -ForegroundColor Cyan
if ($Nsis) {
    & "C:\Program Files\nodejs\npx.cmd" electron-builder --win nsis
} else {
    & "C:\Program Files\nodejs\npx.cmd" electron-builder --win --dir
}
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }

# Generate app-update.yml for electron-updater
# electron-builder creates this only for installer builds, but electron-updater
# always looks for it on startup. Without it → ENOENT error.
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

# Embed custom icon into EXE using rcedit (post-build step)
# signAndEditExecutable: false is set in package.json to avoid winCodeSign symlink error
# on Windows. We use rcedit directly to patch the icon into the built EXE.
$exePath = "release\win-unpacked\mqvi.exe"
$icoPath = "icons\mqvi-icon.ico"
$rceditCacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"

if (Test-Path $exePath) {
    # Find rcedit in electron-builder cache
    $rcedit = Get-ChildItem -Path $rceditCacheDir -Recurse -Filter "rcedit-x64.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($rcedit -and (Test-Path $icoPath)) {
        Write-Host "Embedding icon into EXE..." -ForegroundColor Cyan
        & $rcedit.FullName $exePath --set-icon $icoPath
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Icon embedded successfully" -ForegroundColor Green
        } else {
            Write-Host "Warning: Icon embedding failed (non-critical)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "Warning: rcedit not found in cache, skipping icon embedding" -ForegroundColor Yellow
    }
}

Write-Host "Build complete! Output: release/" -ForegroundColor Green
