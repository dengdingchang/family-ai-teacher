$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'Family AI Teacher Background'
$interfaceTaskName = 'Family AI Teacher Interface'
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
if (-not (Test-Path -LiteralPath $pwsh -PathType Leaf)) { throw "PowerShell 7 was not found: $pwsh" }

$actionArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $PSScriptRoot 'start-background.ps1')
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $actionArguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal = New-ScheduledTaskPrincipal -UserId $userSid -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
Get-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
$interfaceArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $PSScriptRoot 'open-interface.ps1')
$interfaceAction = New-ScheduledTaskAction -Execute $pwsh -Argument $interfaceArguments -WorkingDirectory $projectRoot
Register-ScheduledTask -TaskName $interfaceTaskName -Action $interfaceAction -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
Get-ScheduledTask -TaskName $interfaceTaskName -ErrorAction Stop | Out-Null
Write-Output ("Installed and started scheduled task: {0}" -f $taskName)
Write-Output ("Installed login interface task: {0}" -f $interfaceTaskName)
Write-Output 'It runs silently after this Windows user logs in; it does not expose a public port.'
