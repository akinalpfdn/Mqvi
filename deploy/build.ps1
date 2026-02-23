# mqvi Deploy Build Script
#
# Builds a Linux deploy package from Windows.
# Usage: powershell -ExecutionPolicy Bypass -File deploy\build.ps1
#
# Steps:
#   1. Frontend build (React + TypeScript + Vite)
#   2. Copy frontend to server/static/dist/ (for embedding)
#   3. Go cross-compile (GOOS=linux GOARCH=amd64)
#   4. Create deploy package

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ClientDir   = Join-Path $ProjectRoot "client"
$ServerDir   = Join-Path $ProjectRoot "server"
$StaticDist  = Join-Path (Join-Path $ServerDir "static") "dist"
$DeployDir   = Join-Path $PSScriptRoot "package"

Write-Host "=== mqvi Deploy Build ===" -ForegroundColor Cyan
Write-Host ""

# ─── 1. Frontend Build ───
Write-Host "[1/4] Building frontend..." -ForegroundColor Yellow
Push-Location $ClientDir

# npm install (if node_modules missing)
if (-not (Test-Path "node_modules")) {
    Write-Host "  npm install..."
    & 'C:\Program Files\nodejs\npm.cmd' install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

# TypeScript check + Vite build
& 'C:\Program Files\nodejs\npm.cmd' run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }
Pop-Location

Write-Host "  Frontend build OK" -ForegroundColor Green

# ─── 2. Copy Frontend to Static Directory ───
Write-Host "[2/4] Copying frontend to server/static/dist/..." -ForegroundColor Yellow

# Clean previous build (keep .gitkeep)
if (Test-Path $StaticDist) {
    Get-ChildItem -Path $StaticDist -Exclude ".gitkeep" | Remove-Item -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $StaticDist | Out-Null

# client/dist/ → server/static/dist/
$ClientDist = Join-Path (Join-Path $ClientDir "dist") "*"
Copy-Item -Path $ClientDist -Destination $StaticDist -Recurse -Force

Write-Host "  Copy OK" -ForegroundColor Green

# ─── 3. Go Cross-Compile ───
Write-Host "[3/4] Compiling Go binary (linux/amd64)..." -ForegroundColor Yellow
Push-Location $ServerDir

$env:GOOS   = "linux"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"

$OutputBinary = Join-Path $PSScriptRoot "mqvi-server"
& 'C:\Program Files\Go\bin\go.exe' build -o $OutputBinary .
if ($LASTEXITCODE -ne 0) { throw "Go build failed" }

# Clean env vars
Remove-Item Env:\GOOS
Remove-Item Env:\GOARCH
Remove-Item Env:\CGO_ENABLED
Pop-Location

$Size = [math]::Round((Get-Item $OutputBinary).Length / 1MB, 1)
Write-Host "  Binary OK ($Size MB)" -ForegroundColor Green

# ─── 4. Create Deploy Package ───
Write-Host "[4/4] Creating deploy package..." -ForegroundColor Yellow

if (Test-Path $DeployDir) {
    Remove-Item -Path $DeployDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null

# Copy files
Copy-Item $OutputBinary                           (Join-Path $DeployDir "mqvi-server")
Copy-Item (Join-Path $PSScriptRoot "start.sh")    (Join-Path $DeployDir "start.sh")
Copy-Item (Join-Path $PSScriptRoot ".env.example") (Join-Path $DeployDir ".env")
Copy-Item (Join-Path $PSScriptRoot "livekit.yaml") (Join-Path $DeployDir "livekit.yaml")

# Remove temp binary from root
Remove-Item $OutputBinary -Force

Write-Host "  Package OK" -ForegroundColor Green

Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Deploy package: $DeployDir" -ForegroundColor White
Write-Host ""
Write-Host "Upload to server:" -ForegroundColor White
Write-Host "  scp -r $DeployDir/* root@YOUR_SERVER_IP:~/mqvi/" -ForegroundColor Gray
Write-Host ""
Write-Host "Run on server:" -ForegroundColor White
Write-Host "  cd ~/mqvi" -ForegroundColor Gray
Write-Host "  nano .env              # Set JWT_SECRET!" -ForegroundColor Gray
Write-Host "  chmod +x mqvi-server start.sh" -ForegroundColor Gray
Write-Host "  ./start.sh" -ForegroundColor Gray
