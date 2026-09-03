$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-FamilyAiEnvironment -ProjectRoot $projectRoot
& $runtime.Python -S (Join-Path $PSScriptRoot 'smoke_llm.py')
exit $LASTEXITCODE
