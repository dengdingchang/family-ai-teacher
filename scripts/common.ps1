function Initialize-FamilyAiEnvironment {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $envPath = Join-Path $ProjectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) {
        $null = Copy-Item -LiteralPath (Join-Path $ProjectRoot '.env.example') -Destination $envPath
    }

    foreach ($rawLine in Get-Content -LiteralPath $envPath -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).TrimStart() }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { continue }
        $key = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        Set-Item -Path ("Env:{0}" -f $key) -Value $value
    }

    $python = $env:FAMILY_AI_PYTHON
    if ([string]::IsNullOrWhiteSpace($python)) {
        $python = 'X:\AI\local\qwen3-tts-runtime311\.venv\Scripts\python.exe'
    }
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw "Backend Python was not found: $python"
    }

    $qwenSite = 'X:\AI\local\qwen3-tts-runtime311\.venv\Lib\site-packages'
    $omniSite = 'X:\AI\OmniVoice-Studio\.venv\Lib\site-packages'
    $env:PYTHONPATH = "$ProjectRoot;$qwenSite;$omniSite"
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONHOME = ''
    return @{ Python = $python; EnvFile = $envPath }
}

function Start-FamilyAiInferenceTunnel {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $sshCommand = Get-Command ssh -ErrorAction SilentlyContinue
    if (-not $sshCommand) {
        Write-Warning 'OpenSSH was not found; optional remote avatar/TTS will use fallback mode.'
        return $null
    }
    $hostAlias = if ($env:AI_STATION_SSH_HOST) { $env:AI_STATION_SSH_HOST } else { 'ai' }
    $runtimeDir = Join-Path $ProjectRoot 'runtime'
    $null = New-Item -ItemType Directory -Force -Path $runtimeDir
    $started = @()
    $routes = @(@{ Name = 'avatar'; Port = 8791; TargetPort = 8791 })
    $publicForwardEnabled = $env:FAMILY_AI_PUBLIC_FORWARD_ENABLED -in @('1', 'true', 'yes', 'on')
    $publicForwardPort = 8876
    if ($env:FAMILY_AI_PUBLIC_FORWARD_PORT -match '^\d+$') {
        $publicForwardPort = [int]$env:FAMILY_AI_PUBLIC_FORWARD_PORT
    }
    if ($publicForwardPort -lt 1024 -or $publicForwardPort -gt 65535) {
        throw "FAMILY_AI_PUBLIC_FORWARD_PORT is outside 1024..65535: $publicForwardPort"
    }
    $publicMonitorPort = 8877
    if ($env:FAMILY_AI_PUBLIC_MONITOR_PORT -match '^\d+$') {
        $publicMonitorPort = [int]$env:FAMILY_AI_PUBLIC_MONITOR_PORT
    }
    if ($publicMonitorPort -lt 1024 -or $publicMonitorPort -gt 65535) {
        throw "FAMILY_AI_PUBLIC_MONITOR_PORT is outside 1024..65535: $publicMonitorPort"
    }
    if ($publicForwardEnabled) {
        $routes += @{
            Name = 'public'
            Port = $publicMonitorPort
            TargetPort = $publicForwardPort
            RemotePort = $publicForwardPort
        }
    }
    if ($env:TTS_MODE -eq 'remote_preferred') {
        $routes += @{ Name = 'tts'; Port = 8792; TargetPort = 8792 }
    }
    foreach ($route in $routes) {
        $port = [int]$route.Port
        $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
            Select-Object -First 1
        if ($listener) {
            $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
            if (-not $owner -or $owner.ProcessName -ne 'ssh') {
                Write-Warning "Loopback port $port is occupied by another program; $($route.Name) will use fallback mode."
            } else {
                Write-Host "Reusing the private $($route.Name) tunnel on loopback port $port."
            }
            continue
        }

        $stdoutPath = Join-Path $runtimeDir ("{0}-tunnel.stdout.log" -f $route.Name)
        $stderrPath = Join-Path $runtimeDir ("{0}-tunnel.stderr.log" -f $route.Name)
        $arguments = @(
            '-N', '-T',
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=8',
            '-o', 'ExitOnForwardFailure=yes',
            '-o', 'ServerAliveInterval=20',
            '-o', 'ServerAliveCountMax=3',
            '-o', 'ControlMaster=no',
            '-L', ("127.0.0.1:{0}:127.0.0.1:{1}" -f $port, [int]$route.TargetPort)
        )
        if ($route.RemotePort) {
            # Keep the child app loopback-only. The remote end also binds only to
            # AI Station loopback, where the authenticated public gateway runs.
            $arguments += @('-R', ("127.0.0.1:{0}:127.0.0.1:{1}" -f [int]$route.RemotePort, $env:APP_PORT))
        }
        $arguments += $hostAlias
        $process = Start-Process -FilePath $sshCommand.Source -ArgumentList $arguments `
            -WorkingDirectory $ProjectRoot -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
        Start-Sleep -Milliseconds 900
        if ($process.HasExited) {
            Write-Warning "Private $($route.Name) tunnel did not start; fallback mode remains available. See $stderrPath"
            continue
        }
        $started += $process
        Write-Host "Private AI Station $($route.Name) tunnel is ready on loopback port $port."
    }
    return $started
}

function Stop-FamilyAiInferenceTunnel {
    param([System.Diagnostics.Process[]]$Process)

    foreach ($tunnelProcess in @($Process)) {
        if (-not $tunnelProcess -or $tunnelProcess.HasExited) { continue }
        try {
            Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction Stop
        } catch {
            Write-Warning "Could not stop inference tunnel PID $($tunnelProcess.Id): $($_.Exception.Message)"
        }
    }
}
