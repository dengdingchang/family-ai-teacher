param([Parameter(Mandatory = $true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-FamilyAiEnvironment -ProjectRoot $projectRoot
& $runtime.Python -S (Join-Path $PSScriptRoot 'smoke_vision.py') --image $ImagePath
exit $LASTEXITCODE
