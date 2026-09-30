$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-FamilyAiEnvironment -ProjectRoot $projectRoot

$credential = Get-Credential -UserName 'nathan' -Message '为爸爸老师 Windows 公网入口设置新的 Nathan 密码（10 至 128 位）。密码只发送给本机进程。'
if (-not $credential) { exit 1 }
$password = $credential.GetNetworkCredential().Password
if ($password.Length -lt 10 -or $password.Length -gt 128) { throw '密码必须为 10 至 128 位' }
try {
    $result = $password | & $runtime.Python -S -m app.public_auth reset
    if ($LASTEXITCODE -ne 0 -or ($result -join "`n") -notmatch '(?m)^PASS$') {
        throw 'Windows 未确认密码更新'
    }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show('新密码已在 Windows 生效。请重新登录爸爸老师。', '爸爸老师密码已更新', 'OK', 'Information') | Out-Null
} finally {
    $password = $null
    $credential = $null
}
