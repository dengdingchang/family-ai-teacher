$ErrorActionPreference = 'Stop'
$port = 8760
if ($env:APP_PORT -match '^\d+$') { $port = [int]$env:APP_PORT }
$url = "http://127.0.0.1:$port/"

# The background service can need several minutes to recover its local GPU
# runtimes after sign-in. Never open an error page first; wait for the exact
# local application identity. The previous three-minute window was observed to
# expire during a real recovery even though the service later became healthy.
$deadline = (Get-Date).AddMinutes(15)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $health = Invoke-RestMethod -UseBasicParsing -Uri ("http://127.0.0.1:{0}/health" -f $port) -TimeoutSec 3
        if ($health.status -eq 'ok' -and $health.app -eq 'family-ai-teacher') {
            $ready = $true
            break
        }
    } catch { }
    Start-Sleep -Seconds 3
}
if (-not $ready) { exit 1 }

$browserCandidates = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
)
$browser = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $browser) { exit 2 }

Start-Process -FilePath $browser -ArgumentList @("--app=$url", '--start-maximized', '--no-first-run')
