$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-FamilyAiEnvironment -ProjectRoot $projectRoot
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
if (-not (Test-Path -LiteralPath $pwsh -PathType Leaf)) { throw "PowerShell 7 was not found: $pwsh" }

$port = 8760
if ($env:APP_PORT -match '^\d+$') { $port = [int]$env:APP_PORT }
$runtimeDir = Join-Path $projectRoot 'runtime'
$null = New-Item -ItemType Directory -Force -Path $runtimeDir
$logPath = Join-Path $runtimeDir 'background.log'
$stdoutPath = Join-Path $runtimeDir 'service.stdout.log'
$stderrPath = Join-Path $runtimeDir 'service.stderr.log'
$child = $null
$recoveryTunnels = @()
$nextTunnelRecovery = [datetime]::MinValue
$requiredTunnelPorts = @(8791)
if ($env:TTS_MODE -eq 'remote_preferred') { $requiredTunnelPorts += 8792 }

function Write-BackgroundLog([string]$Message) {
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Test-FamilyAiHealth {
    try {
        $health = Invoke-RestMethod -UseBasicParsing -Uri ("http://127.0.0.1:{0}/health" -f $port) -TimeoutSec 3
        return $health.status -eq 'ok' -and $health.app -eq 'family-ai-teacher'
    } catch {
        return $false
    }
}

function Get-FamilyAiLoopbackListener([int]$LocalPort) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
        Select-Object -First 1
    if (-not $listener) { return $null }
    $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if (-not $owner -or $owner.ProcessName -ne 'ssh') { return $null }
    return $listener
}

try {
    Write-BackgroundLog 'background supervisor started'
    while ($true) {
        if ($child -and $child.HasExited) {
            Write-BackgroundLog ("service child exited with code {0}" -f $child.ExitCode)
            $child = $null
        }
        if (-not (Test-FamilyAiHealth) -and -not $child) {
            $arguments = @(
                '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-tailscale.ps1')
            )
            Write-BackgroundLog 'starting service child'
            $child = Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $projectRoot `
                -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
        }
        $recoveryTunnels = @($recoveryTunnels | Where-Object { $_ -and -not $_.HasExited })
        $missingTunnelPorts = @($requiredTunnelPorts | Where-Object {
            -not (Get-FamilyAiLoopbackListener -LocalPort $_)
        })
        if ($missingTunnelPorts.Count -gt 0 -and (Get-Date) -ge $nextTunnelRecovery) {
            $nextTunnelRecovery = (Get-Date).AddSeconds(30)
            Write-BackgroundLog ("inference tunnel missing on {0}; attempting loopback-only recovery" -f ($missingTunnelPorts -join ', '))
            $recovered = @(Start-FamilyAiInferenceTunnel -ProjectRoot $projectRoot)
            $recoveryTunnels += $recovered
            $missingTunnelPorts = @($requiredTunnelPorts | Where-Object {
                -not (Get-FamilyAiLoopbackListener -LocalPort $_)
            })
            if ($missingTunnelPorts.Count -eq 0) {
                Write-BackgroundLog ("inference tunnels ready on {0}" -f ($requiredTunnelPorts -join ', '))
                $nextTunnelRecovery = [datetime]::MinValue
            } else {
                Write-BackgroundLog ("inference tunnel recovery deferred for {0}; retrying in 30 seconds" -f ($missingTunnelPorts -join ', '))
            }
        } elseif ($missingTunnelPorts.Count -eq 0) {
            $nextTunnelRecovery = [datetime]::MinValue
        }
        Start-Sleep -Seconds 8
    }
} catch {
    Write-BackgroundLog ("supervisor error: {0}" -f $_.Exception.Message)
    throw
} finally {
    if ($child -and -not $child.HasExited) {
        try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    Stop-FamilyAiInferenceTunnel -Process $recoveryTunnels
    Write-BackgroundLog 'background supervisor stopped'
}
