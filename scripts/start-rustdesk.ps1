$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $projectRoot 'runtime\rustdesk-supervisor.log'

function Write-RustDeskLog([string]$Message) {
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

try {
$rustDesk = Join-Path $env:LOCALAPPDATA 'rustdesk\rustdesk.exe'
$workingDirectory = Split-Path -Parent $rustDesk

if (-not (Test-Path -LiteralPath $rustDesk -PathType Leaf)) {
    throw "RustDesk was not found: $rustDesk"
}
$signature = Get-AuthenticodeSignature -LiteralPath $rustDesk
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'PURSLANE') {
    throw 'RustDesk signature validation failed.'
}
Write-RustDeskLog 'supervisor started'

function Test-RustDeskListener {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 21118 -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) { return $false }
    $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    return $owner -and $owner.ProcessName -eq 'rustdesk'
}

while ($true) {
    if (-not (Test-RustDeskListener)) {
        Start-Process -FilePath $rustDesk -ArgumentList '--server' `
            -WorkingDirectory $workingDirectory -WindowStyle Hidden
        Start-Sleep -Seconds 5
    }
    Start-Sleep -Seconds 10
}
} catch {
    Write-RustDeskLog ("supervisor error: {0}" -f $_.Exception.Message)
    throw
}
