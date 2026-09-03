param([string]$BackupFile = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$registryPath = 'HKLM:\SOFTWARE\OpenSSH'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell 7 window.'
}
if ([string]::IsNullOrWhiteSpace($BackupFile)) {
    $BackupFile = (Get-ChildItem -LiteralPath (Join-Path $projectRoot 'runtime') -Filter 'ssh-default-shell-*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if ([string]::IsNullOrWhiteSpace($BackupFile) -or -not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) {
    throw 'No SSH DefaultShell backup was found.'
}
$backup = Get-Content -LiteralPath $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($backup.had_default_shell) {
    Set-ItemProperty -LiteralPath $registryPath -Name DefaultShell -Value ([string]$backup.default_shell) -Type String
    Write-Output ("Restored OpenSSH DefaultShell: {0}" -f $backup.default_shell)
} else {
    Remove-ItemProperty -LiteralPath $registryPath -Name DefaultShell -ErrorAction SilentlyContinue
    Write-Output 'Removed OpenSSH DefaultShell; Windows OpenSSH default will apply.'
}
