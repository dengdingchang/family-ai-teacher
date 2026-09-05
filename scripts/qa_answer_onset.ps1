param(
    [Parameter(Mandatory=$true)][ValidateSet('baseline','candidate')][string]$Variant,
    [ValidateRange(1,3)][int]$Sample = 1
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sessionName = 'family-answer-onset'
$questions = @('月亮为什么会跟着我们走？','恐龙为什么消失了？','鱼为什么在水里不会淹死？')
$questionJson = $questions[$Sample - 1] | ConvertTo-Json -Compress
$baseCode = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'qa_avatar_browser.js') -Raw
$prefix = @'
async (page) => {
  await page.addInitScript(() => {
    window.__answerOnsetGuard = {intervals:[], cancels:0};
    const originalFetch = window.fetch.bind(window);
    const json = value => new Response(JSON.stringify(value), {status:200,headers:{'Content-Type':'application/json'}});
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = String(init.method || input.method || 'GET').toUpperCase();
      if (url.pathname === '/api/conversation/interaction-interval' && method === 'POST') {
        let payload={};
        try { payload=JSON.parse(init.body || await input.clone().text()); } catch (_) {}
        const seconds=(Date.parse(payload.end_at)-Date.parse(payload.start_at))/1000;
        window.__answerOnsetGuard.intervals.push({sequence:payload.sequence,durationSeconds:Number.isFinite(seconds)?seconds:null});
        return json({ok:true,recorded:true,qa_intercepted:true});
      }
      if (/^\/api\/conversation\/turns\/[^/]+\/complete$/.test(url.pathname) && method === 'POST') {
        const result=await originalFetch(url.pathname.replace(/\/complete$/,'/cancel'),{method:'POST',keepalive:true});
        if(!result.ok) throw new Error('QA could not cancel the completed turn');
        window.__answerOnsetGuard.cancels++;
        return json({ok:true,history:null,qa_cancelled:true});
      }
      // Keep family text out of the screenshot; file hashes are the independent
      // integrity evidence, not the mock history count in the reused probe.
      if (url.pathname === '/api/memory/history') return json({history:[],records:[],count:0});
      return originalFetch(input, init);
    };
    addEventListener('pagehide',()=>globalThis.familyInteractionClock?.end());
  });
  await page.setViewportSize({width:1366,height:768});
'@
$suffix = @'
  const response = await probe(page);
  return {...response,avatarReadyBeforeRun:true,historyCountsMocked:true,privacyGuard:'Browser fetch blocks timing and cancels completion; family files verified externally.'};
}
'@
$scriptPath = Join-Path $projectRoot "runtime/answer-onset-$Variant-$Sample.js"
$generated = $prefix + "`n  const question = $questionJson;`n  await page.goto('http://127.0.0.1:8760/?qaText='+encodeURIComponent(question));`n  await page.waitForFunction(()=>document.querySelector('#serviceBadge')?.textContent==='准备好了');`n  await page.waitForFunction(()=>document.querySelector('#avatarStateText')?.textContent==='准备好啦，可以一起说话', null, {timeout:15000});`n  const probe = " + $baseCode + ";`n" + $suffix
[IO.File]::WriteAllText($scriptPath, $generated, [Text.UTF8Encoding]::new($false))
$logPath = Join-Path $projectRoot "output/playwright/answer-onset-$Variant-$Sample.log"
& npx --no-install --package '@playwright/cli' playwright-cli "-s=$sessionName" run-code --filename $scriptPath | Set-Content -LiteralPath $logPath -Encoding utf8
$resultLine = Get-Content -LiteralPath $logPath | Where-Object { $_.StartsWith('{"status":') } | Select-Object -First 1
if (-not $resultLine) { Get-Content -LiteralPath $logPath -TotalCount 12; throw 'Missing structured browser result' }
$result = $resultLine | ConvertFrom-Json
$result | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $projectRoot "output/playwright/answer-onset-$Variant-$Sample.json") -Encoding utf8
Copy-Item -LiteralPath (Join-Path $projectRoot 'output/playwright/avatar-streaming.png') -Destination (Join-Path $projectRoot "output/playwright/answer-onset-$Variant-$Sample.png")
[pscustomobject]@{
    variant=$Variant; sample=$Sample; status=$result.status; functional=$result.functionalPass;
    semanticMs=$result.semanticLatencyMs; maxGapMs=$result.maxScheduledGapMs; avatar=$result.avatarExperiencePass;
    avatarOffsetMs=$result.avatarOffsetMs; audioNodes=$result.audioNodes.Count;
    nonSemanticChunks=@($result.streamEvents | Where-Object {$_.event -eq 'audio' -and -not $_.semantic}).Count;
    voiceBackends=@($result.streamEvents | Where-Object {$_.event -eq 'audio'} | Select-Object -ExpandProperty backend -Unique);
    cancelled=$result.cancelled; browserError=$result.browserError
} | ConvertTo-Json -Depth 5
