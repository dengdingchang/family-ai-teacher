function Initialize-FamilyAiEnvironment {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $envPath = Join-Path $ProjectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) {
        $null = Copy-Item -LiteralPath (Join-Path $ProjectRoot '.env.example') -Destination $envPath
    }

    foreach ($rawLine in Get-Content -LiteralPath $envPath -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).TrimStart() }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { continue }
        $key = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        Set-Item -Path ("Env:{0}" -f $key) -Value $value
    }

    $python = $env:FAMILY_AI_PYTHON
    if ([string]::IsNullOrWhiteSpace($python)) {
        $python = 'X:\AI\local\qwen3-tts-runtime311\.venv\Scripts\python.exe'
    }
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw "Backend Python was not found: $python"
    }

    $qwenSite = 'X:\AI\local\qwen3-tts-runtime311\.venv\Lib\site-packages'
    $omniSite = 'X:\AI\OmniVoice-Studio\.venv\Lib\site-packages'
    $env:PYTHONPATH = "$ProjectRoot;$qwenSite;$omniSite"
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONHOME = ''
    return @{ Python = $python; EnvFile = $envPath }
}
