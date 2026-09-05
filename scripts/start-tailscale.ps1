$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-FamilyAiEnvironment -ProjectRoot $projectRoot

# Keep the application itself on loopback. Tailscale Serve provides the
# tailnet-only HTTPS edge, which also makes browser mic/camera permissions work.
$env:APP_HOST = '127.0.0.1'
$port = 8760
if ($env:APP_PORT -match '^\d+$') { $port = [int]$env:APP_PORT }

$tailscaleCommand = Get-Command tailscale -ErrorAction SilentlyContinue
$tailscale = if ($tailscaleCommand) { $tailscaleCommand.Source } else { 'C:\Program Files\Tailscale\tailscale.exe' }
if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) {
    throw "Tailscale CLI was not found: $tailscale"
}

$status = (& $tailscale status --json | ConvertFrom-Json)
if ($status.BackendState -ne 'Running') {
    throw "Tailscale is not running (state: $($status.BackendState))"
}
$dnsName = ([string]$status.Self.DNSName).TrimEnd('.')
if ([string]::IsNullOrWhiteSpace($dnsName)) {
    throw 'Tailscale MagicDNS name is unavailable.'
}

$httpsPort = 8443
if ($env:TAILSCALE_HTTPS_PORT -match '^\d+$') { $httpsPort = [int]$env:TAILSCALE_HTTPS_PORT }
if ($httpsPort -lt 1 -or $httpsPort -gt 65535) {
    throw "TAILSCALE_HTTPS_PORT is outside 1..65535: $httpsPort"
}

$target = "http://127.0.0.1:$port"
$publicUrl = "https://${dnsName}:$httpsPort"
$serveStatus = (& $tailscale serve status --json | ConvertFrom-Json)
$listenerName = "${dnsName}:$httpsPort"
$listener = $serveStatus.Web.PSObject.Properties | Where-Object Name -eq $listenerName | Select-Object -First 1
$rootHandler = $null
if ($listener) {
    $rootHandler = $listener.Value.Handlers.PSObject.Properties | Where-Object Name -eq '/' | Select-Object -First 1
}
$existingProxy = if ($rootHandler) { [string]$rootHandler.Value.Proxy } else { '' }

if ($existingProxy -and $existingProxy -ne $target) {
    throw "Tailscale HTTPS $httpsPort is already configured for another local target: $existingProxy"
}
if (-not $existingProxy) {
    Write-Host "Configuring Tailscale Serve (tailnet only): $publicUrl -> $target"
    & $tailscale serve --bg --yes "--https=$httpsPort" $target
    if ($LASTEXITCODE -ne 0) {
        throw "Tailscale Serve configuration failed with exit code $LASTEXITCODE"
    }
}

Write-Host "Family AI Teacher: http://127.0.0.1:$port"
Write-Host "Tailnet WebUI: $publicUrl"
Write-Host 'Tailscale Serve is tailnet-only; no public Funnel is enabled.'
Write-Host 'Press Ctrl+C to stop the app. The Serve route remains configured for the next start.'
$tunnel = Start-FamilyAiInferenceTunnel -ProjectRoot $projectRoot
try {
    & $runtime.Python -S -m uvicorn app.main:app --host 127.0.0.1 --port $port
} finally {
    Stop-FamilyAiInferenceTunnel -Process $tunnel
}
