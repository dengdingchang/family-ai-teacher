$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$shellPath = 'C:\Program Files\PowerShell\7\pwsh.exe'
$registryPath = 'HKLM:\SOFTWARE\OpenSSH'
if (-not (Test-Path -LiteralPath $shellPath -PathType Leaf)) { throw "PowerShell 7 was not found: $shellPath" }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell 7 window.'
}

$null = New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'runtime')
$backupPath = Join-Path $projectRoot ('runtime\ssh-default-shell-{0}.json' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$current = Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue
$hadDefaultShell = $null -ne $current -and $null -ne $current.DefaultShell
[pscustomobject]@{
    registry_path = $registryPath
    had_default_shell = $hadDefaultShell
    default_shell = if ($hadDefaultShell) { [string]$current.DefaultShell } else { '' }
} | ConvertTo-Json | Set-Content -LiteralPath $backupPath -Encoding UTF8

if (-not (Test-Path -LiteralPath $registryPath)) { $null = New-Item -Path $registryPath -Force }
Set-ItemProperty -LiteralPath $registryPath -Name DefaultShell -Value $shellPath -Type String
Write-Output ("DefaultShell is now PowerShell 7: {0}" -f $shellPath)
Write-Output ("Rollback backup: {0}" -f $backupPath)
Write-Output 'DefaultShellCommandOption was left unchanged; new SSH sessions will use the existing OpenSSH command option.'
