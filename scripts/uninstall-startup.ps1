$ErrorActionPreference = 'Stop'
$taskNames = @('Family AI Teacher Background', 'Family AI Teacher Interface')
foreach ($taskName in $taskNames) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Output ("Removed scheduled task: {0}" -f $taskName)
    } else {
        Write-Output ("Scheduled task not found: {0}" -f $taskName)
    }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and
    [string]$_.CommandLine -like "*$(Join-Path $projectRoot 'scripts\start-background.ps1')*"
}
foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
