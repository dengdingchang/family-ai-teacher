async (page) => {
  const errors=[], requests=[], layouts=[];
  const onError=error=>errors.push(error.message);
  page.on("pageerror",onError);
  const skills=[
    {id:"english.words",domain:"英语",name:"日常单词",status:"practicing",practice_count:4,parent_reviewed_at:""},
    {id:"math.addition",domain:"数学",name:"简单加法",status:"practicing",practice_count:3,parent_reviewed_at:"2026-09-06T00:00:00Z"},
  ];
  const journal={week:"2026-W36",summary:"一起尝试，再慢慢进步。",learning_progress:[{name:"日常单词",turns:4,trend:"",source:"topic_exposure"}],
    practice_results:[{source:"local_number_activity",activity:"numbers",question:"两块积木再加一块，一共有几块？",correct:1,incorrect:2,last_result:"correct"}],
    skill_reviews:[{name:"简单加法",previous_status:"not_started",status:"practicing",evidence:"爸爸看到独立摆出两加一，继续用积木练习"}],
    recommendation:"明天继续用积木试一试，一次只问一个小问题。"};
  const payloads={
    "/api/parent/dashboard":{profile:{name:"测试探索家",age:4},today:{conversation_turns:4,interaction_seconds:126,interaction_timing_available:true},skill_graph:{skills},growth_journal:[journal],memory_tiers:{}},
    "/api/memories":{memories:[]}, "/api/parent/messages":{messages:[]},
  };
  async function intercept(route) {
    const request=route.request(),path=request.url().replace(/^https?:\/\/[^/]+/,"").split("?")[0];
    requests.push({path,method:request.method()});
    await route.fulfill({status:request.method()==="GET"&&payloads[path]?200:403,contentType:"application/json",body:JSON.stringify(payloads[path]||{detail:"Unexpected API blocked by QA"})});
  }
  await page.route("**/api/**",intercept);
  try {
    for(const size of [{width:1400,height:960},{width:390,height:844}]) {
      const recovering=size.width===390;
      payloads["/api/parent/dashboard"].skill_graph.recovery_required=recovering;
      await page.setViewportSize(size);
      await page.goto("http://127.0.0.1:8760/parent");
      await page.waitForFunction(()=>document.querySelector("#journalContent").textContent.includes("答对 1 次"));
      const checks=await page.evaluate(()=>({
        journal:document.querySelector("#journalContent").textContent,
        selected:[...document.querySelectorAll("#skillGroups select")].map(select=>select.selectedOptions[0].textContent),
        disabled:[...document.querySelectorAll("#skillGroups select")].every(select=>select.disabled),
        recoveryNoticeVisible:!document.querySelector("#skillRecoveryNotice").hidden,
        documentWidth:document.documentElement.scrollWidth,
        overflow:[...document.querySelectorAll(".journal-panel,.journal-entry li,.skill-row,.skill-row select")].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.className||el.tagName),
      }));
      await page.locator(".journal-panel").scrollIntoViewIfNeeded();
      const screenshot=`output/playwright/parent-growth-evidence-${size.width}.png`;
      await page.screenshot({path:screenshot,fullPage:false});
      const skillsScreenshot=`output/playwright/parent-skill-recovery-${size.width}.png`;
      await page.locator("#skillGroups").locator("xpath=..").screenshot({path:skillsScreenshot});
      layouts.push({...size,...checks,screenshot,skillsScreenshot,pass:checks.documentWidth===size.width&&checks.overflow.length===0&&checks.selected.includes("持续接触")&&checks.selected.includes("持续练习")&&checks.journal.includes("答对 1 次、再试 2 次")&&checks.journal.includes("尚未开始 → 持续练习")&&!checks.journal.includes("↑")&&checks.recoveryNoticeVisible===recovering&&checks.disabled===recovering});
    }
  } finally {
    await page.goto("about:blank");
    await page.unroute("**/api/**",intercept);
    page.off("pageerror",onError);
  }
  return {status:layouts.length===2&&layouts.every(item=>item.pass)&&errors.length===0?"PASS":"FAIL",layouts,requests,errors,finalUrl:page.url(),boundary:"All family APIs mocked; synthetic practice and assessment only, no model calls or data writes."};
}
