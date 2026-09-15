#requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$ruleName = 'Family AI Teacher - RustDesk from Mac over Tailscale'
$allow = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($allow) {
    $allow | Disable-NetFirewallRule
}

$blocked = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -eq 'rustdesk.exe' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block'
} | Where-Object {
    $program = ($_ | Get-NetFirewallApplicationFilter).Program
    $program -and [IO.Path]::GetFileName($program) -eq 'rustdesk.exe'
}
$blocked | Enable-NetFirewallRule
Write-Output 'RustDesk Tailscale inbound access is disabled.'
