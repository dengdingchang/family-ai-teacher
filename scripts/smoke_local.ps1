param(
    [string]$AudioPath = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-FamilyAiEnvironment -ProjectRoot $projectRoot
$arguments = @('-S', (Join-Path $PSScriptRoot 'smoke_local.py'))
if ($AudioPath) { $arguments += @('--audio', $AudioPath) }
& $runtime.Python @arguments
exit $LASTEXITCODE
