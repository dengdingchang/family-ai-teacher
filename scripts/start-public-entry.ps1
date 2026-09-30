$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-FamilyAiEnvironment -ProjectRoot $projectRoot
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$config = Join-Path $env:USERPROFILE '.cloudflared\family-ai-teacher-windows.yml'
$runtimeDir = Join-Path $projectRoot 'runtime'
$null = New-Item -ItemType Directory -Force -Path $runtimeDir
if (-not (Test-Path -LiteralPath $cloudflared -PathType Leaf)) { throw 'cloudflared is missing' }
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Dedicated teacher tunnel config is missing' }

function Start-TeacherGateway {
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8769 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if ($existing.CommandLine -notlike '*app.public_gateway:app*') { throw 'Public gateway port is owned by another program' }
        return Get-Process -Id $listener.OwningProcess
    }
    return Start-Process -FilePath $runtime.Python -ArgumentList @('-S', '-m', 'uvicorn', 'app.public_gateway:app', '--host', '127.0.0.1', '--port', '8769', '--no-access-log') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'public-gateway.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'public-gateway.stderr.log')
}
function Start-TeacherTunnel {
    $existing = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -like '*family-ai-teacher-windows.yml*' } | Select-Object -First 1
    if ($existing) { return Get-Process -Id $existing.ProcessId }
    return Start-Process -FilePath $cloudflared -ArgumentList @('--config', "`"$config`"", 'tunnel', 'run') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'public-tunnel.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'public-tunnel.stderr.log')
}

$gateway = $null
$tunnel = $null
try {
    while ($true) {
        if ($null -eq $gateway -or $gateway.HasExited) {
            Start-Sleep -Seconds 2
            $gateway = Start-TeacherGateway
        }
        if ($null -eq $tunnel -or $tunnel.HasExited) {
            $tunnel = Start-TeacherTunnel
        }
        Start-Sleep -Seconds 8
    }
} finally {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    if ($gateway -and -not $gateway.HasExited) { Stop-Process -Id $gateway.Id -Force -ErrorAction SilentlyContinue }
}
