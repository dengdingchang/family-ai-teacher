#requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$ruleName = 'Family AI Teacher - RustDesk from Mac over Tailscale'
$rustDesk = Join-Path $env:LOCALAPPDATA 'rustdesk\rustdesk.exe'
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not (Test-Path -LiteralPath $rustDesk -PathType Leaf)) {
    throw "RustDesk was not found: $rustDesk"
}
if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) {
    throw "Tailscale was not found: $tailscale"
}

$signature = Get-AuthenticodeSignature -LiteralPath $rustDesk
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'PURSLANE') {
    throw 'RustDesk signature validation failed; firewall was not changed.'
}

$statusText = & $tailscale status --json 2>$null
if ($LASTEXITCODE -ne 0 -or -not $statusText) {
    throw 'Tailscale status is unavailable. Sign in to Tailscale first.'
}
$status = $statusText | ConvertFrom-Json
$peers = @($status.Peer.PSObject.Properties.Value)
$mac = $peers | Where-Object {
    $_.HostName -eq 'macbook-pro' -or $_.DNSName -like 'macbook-pro.*'
} | Select-Object -First 1
$macAddress = @($mac.TailscaleIPs | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' }) | Select-Object -First 1
if (-not $macAddress) {
    throw 'The MacBook Pro Tailscale address is unavailable. Bring the Mac online once, then retry.'
}

# Windows may create user-query Block rules when an unsigned firewall prompt is
# dismissed. A Block rule overrides a narrower Allow rule, so disable only the
# RustDesk rules that are explicitly blocking this executable.
$blocked = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -eq 'rustdesk.exe' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block'
} | Where-Object {
    $program = ($_ | Get-NetFirewallApplicationFilter).Program
    $program -and [IO.Path]::GetFileName($program) -eq 'rustdesk.exe'
}
$blocked | Disable-NetFirewallRule

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    $existing | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any
    $existing | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $rustDesk
    $existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort 21118
    $existing | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress $macAddress
} else {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Enabled True `
        -Profile Any -Program $rustDesk -Protocol TCP -LocalPort 21118 -RemoteAddress $macAddress | Out-Null
}

$verified = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction Stop
$address = $verified | Get-NetFirewallAddressFilter
if ($verified.Action -ne 'Allow' -or $verified.Enabled -ne 'True' -or $address.RemoteAddress -notcontains $macAddress) {
    throw 'The scoped RustDesk firewall rule could not be verified.'
}
Write-Output 'RustDesk is allowed only from the MacBook Pro Tailscale address.'
