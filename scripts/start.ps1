$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-FamilyAiEnvironment -ProjectRoot $projectRoot

# Always bind locally. This is a child-facing device and the MVP has no LAN auth layer.
$port = 8760
if ($env:APP_PORT -match '^\d+$') { $port = [int]$env:APP_PORT }
Write-Host "Family AI Teacher: http://127.0.0.1:$port"
Write-Host 'Press Ctrl+C to stop. No package or model installation is performed.'
$tunnel = Start-FamilyAiInferenceTunnel -ProjectRoot $projectRoot
try {
    & $runtime.Python -S -m uvicorn app.main:app --host 127.0.0.1 --port $port
} finally {
    Stop-FamilyAiInferenceTunnel -Process $tunnel
}
