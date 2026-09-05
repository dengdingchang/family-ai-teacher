$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sessionName = 'family-gpu-voice-run7'
$stem = Join-Path $projectRoot 'output/playwright/synthetic-voice-journey-7'
foreach ($extension in @('.json','.log','.png')) {
    if (Test-Path -LiteralPath ($stem + $extension)) { throw 'Run 7 already has artifacts; preserve this one-shot receipt.' }
}
function Read-JourneyIntegrity {
    return [ordered]@{
        at = (Get-Date).ToString('o')
        files = @(Get-Item -LiteralPath (Join-Path $projectRoot 'data/session_history.jsonl'),(Join-Path $projectRoot 'data/learning_events.jsonl') | ForEach-Object {
            [ordered]@{ name=$_.Name; bytes=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
        })
    }
}
$before = Read-JourneyIntegrity
$healthBefore = Invoke-RestMethod 'http://127.0.0.1:8760/health'
if ($healthBefore.stt_runtime.device -ne 'cuda' -or $healthBefore.tts_warmup -ne 'ready') { throw 'Expected ready CUDA STT and TTS before QA.' }
$before | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $projectRoot 'runtime/gpu-voice-journey-7-before.json') -Encoding utf8
$probe = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'qa_synthetic_microphone.js') -Raw
$probe = $probe.Replace('output/playwright/synthetic-voice-journey.png','output/playwright/synthetic-voice-journey-7.png')
$wrapper = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'qa_gpu_voice_journey.js') -Raw
$generated = $wrapper.Replace('/* SYNTHETIC_PROBE */ null',$probe)
$scriptPath = Join-Path $projectRoot 'runtime/qa-synthetic-voice-journey-7.js'
[IO.File]::WriteAllText($scriptPath,$generated,[Text.UTF8Encoding]::new($false))
$result = $null
$opened = $false
try {
    & npx --no-install --package '@playwright/cli' playwright-cli "-s=$sessionName" open about:blank --headed
    if ($LASTEXITCODE -ne 0) { throw 'Could not open the dedicated QA session' }
    $opened = $true
    & npx --no-install --package '@playwright/cli' playwright-cli "-s=$sessionName" run-code --filename $scriptPath | Set-Content -LiteralPath ($stem + '.log') -Encoding utf8
    $resultLine = Get-Content -LiteralPath ($stem + '.log') | Where-Object { $_.StartsWith('{"status":') } | Select-Object -First 1
    if (-not $resultLine) { throw 'Missing structured result; preserve the log and stop this run.' }
    $result = $resultLine | ConvertFrom-Json
} finally {
    if ($opened) {
        & npx --no-install --package '@playwright/cli' playwright-cli "-s=$sessionName" close
    }
    $after = Read-JourneyIntegrity
    $integrityPass = ($before.files | ConvertTo-Json -Compress) -ceq ($after.files | ConvertTo-Json -Compress)
    $integrity = [ordered]@{ before=$before; after=$after; pass=$integrityPass; healthBefore=$healthBefore; healthAfter=(Invoke-RestMethod 'http://127.0.0.1:8760/health') }
    $integrity | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $projectRoot 'runtime/gpu-voice-journey-7-integrity.json') -Encoding utf8
    if ($null -ne $result) {
        $result | Add-Member -NotePropertyName familyFileIntegrity -NotePropertyValue $integrity
        $gpuRuntimePass = $integrity.healthAfter.stt_runtime.device -eq 'cuda' -and $integrity.healthAfter.stt_runtime.status -eq 'ready' -and -not $integrity.healthAfter.stt_runtime.fallback_reason
        $result | Add-Member -NotePropertyName gpuRuntimePass -NotePropertyValue $gpuRuntimePass
        if (-not $integrityPass -or -not $gpuRuntimePass) { $result.status = 'FAIL' }
        $result | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath ($stem + '.json') -Encoding utf8
        [ordered]@{ status=$result.status; mechanics=$result.mechanicalFlowPass; visual=$result.visualPass; recognized=$result.checks.recognizedThreeInputs;
            latencyPass=$result.latencyPass; turnTiming=$result.turnTiming; intervals=$result.browserTimingGuard; familyFilesUnchanged=$integrityPass; finalUrl=$result.finalUrl } | ConvertTo-Json -Depth 8
    }
}
