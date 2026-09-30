param(
    [string]$SourceDataDir = '',
    [string]$BackupRoot = '',
    [int]$MaxCopyAttempts = 3
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($SourceDataDir)) {
    $SourceDataDir = Join-Path $projectRoot 'data'
}
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
    $workspaceRoot = Split-Path -Parent $projectRoot
    $BackupRoot = Join-Path $workspaceRoot 'family-ai-teacher-handoff-backups\family-data'
}
if ($MaxCopyAttempts -lt 1 -or $MaxCopyAttempts -gt 10) {
    throw 'MaxCopyAttempts must be between 1 and 10.'
}

$sourceRoot = [IO.Path]::GetFullPath($SourceDataDir).TrimEnd('\')
$backupRootPath = [IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "Source data directory does not exist: $sourceRoot"
}
if ($backupRootPath.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $backupRootPath.Equals($sourceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'BackupRoot must be outside the live data directory.'
}

$allowedFiles = @(
    'child_profile.json',
    'session_history.jsonl',
    'learning_events.jsonl',
    'memories.json',
    'skill_graph.json',
    'parent_messages.json',
    'activity_state.json'
)

New-Item -ItemType Directory -Path $backupRootPath -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$incompletePath = Join-Path $backupRootPath ($stamp + '.incomplete')
$finalPath = Join-Path $backupRootPath $stamp
if ((Test-Path -LiteralPath $incompletePath) -or (Test-Path -LiteralPath $finalPath)) {
    throw "Backup target already exists for timestamp $stamp."
}
New-Item -ItemType Directory -Path $incompletePath | Out-Null

$receipts = [Collections.Generic.List[object]]::new()
foreach ($name in $allowedFiles) {
    $source = Join-Path $sourceRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        continue
    }
    $destination = Join-Path $incompletePath $name
    $verified = $false
    for ($attempt = 1; $attempt -le $MaxCopyAttempts; $attempt++) {
        $before = Get-FileHash -Algorithm SHA256 -LiteralPath $source
        Copy-Item -LiteralPath $source -Destination $destination -Force
        $after = Get-FileHash -Algorithm SHA256 -LiteralPath $source
        $copied = Get-FileHash -Algorithm SHA256 -LiteralPath $destination
        if ($before.Hash -eq $after.Hash -and $after.Hash -eq $copied.Hash) {
            $item = Get-Item -LiteralPath $destination
            $receipts.Add([pscustomobject]@{
                name = $name
                bytes = $item.Length
                sha256 = $copied.Hash
            })
            $verified = $true
            break
        }
    }
    if (-not $verified) {
        throw "Could not capture a stable copy of $name after $MaxCopyAttempts attempts. Incomplete backup retained at $incompletePath."
    }
}

if ($receipts.Count -eq 0) {
    throw "No allowlisted family data files were found. Incomplete backup retained at $incompletePath."
}

$manifest = [ordered]@{
    format = 'family-ai-teacher-local-backup-v1'
    created_at = (Get-Date).ToString('o')
    source = 'family-ai-teacher/data'
    raw_media_included = $false
    secrets_included = $false
    files = $receipts
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $incompletePath 'manifest.json') -Encoding UTF8
Rename-Item -LiteralPath $incompletePath -NewName $stamp

[pscustomobject]@{
    status = 'PASS'
    backup = $finalPath
    file_count = $receipts.Count
    raw_media_included = $false
    secrets_included = $false
}
