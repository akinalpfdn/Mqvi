# mqvi Deploy Build Script
#
# Windows'tan Linux deploy paketi oluşturur.
# Kullanım: powershell -ExecutionPolicy Bypass -File deploy\build.ps1
#
# Adımlar:
#   1. Frontend build (React + TypeScript + Vite)
#   2. Frontend'i server/static/dist/ dizinine kopyala (embed için)
#   3. Go cross-compile (GOOS=linux GOARCH=amd64)
#   4. Deploy paketi oluştur

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ClientDir   = Join-Path $ProjectRoot "client"
$ServerDir   = Join-Path $ProjectRoot "server"
$StaticDist  = Join-Path (Join-Path $ServerDir "static") "dist"
$DeployDir   = Join-Path $PSScriptRoot "package"

Write-Host "=== mqvi Deploy Build ===" -ForegroundColor Cyan
Write-Host ""

# ─── 1. Frontend Build ───
Write-Host "[1/4] Frontend derleniyor..." -ForegroundColor Yellow
Push-Location $ClientDir

# npm install (node_modules yoksa veya güncel değilse)
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

# ─── 2. Frontend'i Static Dizinine Kopyala ───
Write-Host "[2/4] Frontend server/static/dist/ dizinine kopyalanıyor..." -ForegroundColor Yellow

# Önceki build'i temizle (.gitkeep hariç)
if (Test-Path $StaticDist) {
    Get-ChildItem -Path $StaticDist -Exclude ".gitkeep" | Remove-Item -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $StaticDist | Out-Null

# client/dist/ → server/static/dist/
$ClientDist = Join-Path (Join-Path $ClientDir "dist") "*"
Copy-Item -Path $ClientDist -Destination $StaticDist -Recurse -Force

Write-Host "  Kopyalama OK" -ForegroundColor Green

# ─── 3. Go Cross-Compile ───
Write-Host "[3/4] Go Linux binary derleniyor..." -ForegroundColor Yellow
Push-Location $ServerDir

$env:GOOS   = "linux"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"

$OutputBinary = Join-Path $PSScriptRoot "mqvi-server"
& 'C:\Program Files\Go\bin\go.exe' build -o $OutputBinary .
if ($LASTEXITCODE -ne 0) { throw "Go build failed" }

# Env temizle
Remove-Item Env:\GOOS
Remove-Item Env:\GOARCH
Remove-Item Env:\CGO_ENABLED
Pop-Location

$Size = [math]::Round((Get-Item $OutputBinary).Length / 1MB, 1)
Write-Host "  Binary OK ($Size MB)" -ForegroundColor Green

# ─── 4. Deploy Paketi Oluştur ───
Write-Host "[4/4] Deploy paketi hazırlanıyor..." -ForegroundColor Yellow

if (Test-Path $DeployDir) {
    Remove-Item -Path $DeployDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null

# Dosyaları kopyala
Copy-Item $OutputBinary                           (Join-Path $DeployDir "mqvi-server")
Copy-Item (Join-Path $PSScriptRoot "start.sh")    (Join-Path $DeployDir "start.sh")
Copy-Item (Join-Path $PSScriptRoot ".env.example") (Join-Path $DeployDir ".env")
Copy-Item (Join-Path $PSScriptRoot "livekit.yaml") (Join-Path $DeployDir "livekit.yaml")

# Ana dizindeki geçici binary'yi sil
Remove-Item $OutputBinary -Force

Write-Host "  Paket OK" -ForegroundColor Green

Write-Host ""
Write-Host "=== Build Tamamlandi ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Deploy paketi: $DeployDir" -ForegroundColor White
Write-Host ""
Write-Host "Sunucuya yukleme:" -ForegroundColor White
Write-Host "  scp -r $DeployDir/* user@sunucu:~/mqvi/" -ForegroundColor Gray
Write-Host ""
Write-Host "Sunucuda calistirma:" -ForegroundColor White
Write-Host "  cd ~/mqvi" -ForegroundColor Gray
Write-Host "  nano .env              # JWT_SECRET'i degistir!" -ForegroundColor Gray
Write-Host "  chmod +x mqvi-server start.sh" -ForegroundColor Gray
Write-Host "  ./start.sh" -ForegroundColor Gray
