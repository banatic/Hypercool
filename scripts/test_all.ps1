$ErrorActionPreference = "Stop"

Write-Host "Running src-tauri tests..." -ForegroundColor Cyan
Set-Location src-tauri
cargo test
if ($LASTEXITCODE -ne 0) { Write-Error "src-tauri tests failed"; exit 1 }
Set-Location ..

Write-Host "Running src tests..." -ForegroundColor Cyan
# Use npx vitest run to ensure it runs once and exits
npx vitest run
if ($LASTEXITCODE -ne 0) { Write-Error "src tests failed"; exit 1 }

Write-Host "Running src-firebase-app tests..." -ForegroundColor Cyan
Set-Location src-firebase-app
npx vitest run
if ($LASTEXITCODE -ne 0) { Write-Error "src-firebase-app tests failed"; exit 1 }
Set-Location ..

Write-Host "All tests passed!" -ForegroundColor Green
