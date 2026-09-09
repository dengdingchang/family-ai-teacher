async (page) => {
  // Real UI and event-stream dispatch, entirely synthetic replies and media.
  const errors = [], requests = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/ws/avatar', socket => socket.close());
  await page.addInitScript(() => {
    globalThis.qaPhysicalRequests = 0;
    globalThis.qaSyntheticMicrophones = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      qaSyntheticMicrophones++;
      globalThis.qaSilentContext ||= new AudioContext();
      return qaSilentContext.createMediaStreamDestination().stream;
    };
  });
  const picture = { kind:'image', title:'蝴蝶', source:'隔离测试示意图', url:'https://zh.wikipedia.org/wiki/Butterfly', thumbnail_url:'https://upload.wikimedia.org/qa-butterfly.svg' };
  await page.route('https://upload.wikimedia.org/**', route => route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="#f8f5eb"/><ellipse cx="380" cy="300" rx="190" ry="220" fill="#c48532"/><ellipse cx="620" cy="300" rx="190" ry="220" fill="#d9b068"/><path d="M500 180V580" stroke="#184936" stroke-width="20"/></svg>'}));
  await page.route('**/api/**', route => {
    const request = route.request(), pathname = request.url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    if (pathname === '/api/avatar') return route.continue();
    requests.push({pathname,method:request.method()});
    if (pathname === '/api/profile') return route.fulfill({json:{name:'界面测试',enabled_activities:['drawing','story','game','music','vision_photo','vision_video']}});
    if (pathname === '/api/memory/history') return route.fulfill({json:{history:[]}});
    if (pathname === '/api/media/suggestions') return route.fulfill({json:{topic:'蝴蝶',cards:[picture]}});
    if (pathname === '/api/tts') { requests.at(-1).text=request.postDataJSON().text; return route.fulfill({status:503,json:{detail:'Isolated QA uses local piano notes only'}}); }
    if (pathname.endsWith('/stream')) {
      const data = request.postDataJSON(), text = data?.text || '';
      const events = [{event:'user_text',text}, {event:'assistant_delta',text:text.includes('蝴蝶')?'我们一起看蝴蝶的图片。':'你找到红色了吗？'},
        {event:'done',assistant_text:text.includes('蝴蝶')?'我们一起看蝴蝶的图片。':'你找到红色了吗？',ok:true}];
      return route.fulfill({contentType:'text/event-stream',body:events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')});
    }
    return route.fulfill({json:{ok:true}});
  });
  await page.route('**/health', route => route.fulfill({json:{status:'ok',tts_ready:true,stt_ready:true,tts_warmup:'ready',llm_configured:true}}));
  await page.setViewportSize({width:1400,height:900});
  await page.goto('http://127.0.0.1:8760/');
  await page.waitForFunction(()=>document.querySelector('#serviceBadge').textContent==='准备好了');
  await page.locator('.grownup-help summary').click();
  const send = async text => {
    // The same SSE user_text path handles STT transcripts in an active voice session.
    await page.locator('#textInput').fill(text);
    await page.locator('#textForm').evaluate(form=>form.requestSubmit());
  };
  await send('我想看大蝴蝶');
  await page.locator('.media-viewer__image').waitFor();
  await page.waitForFunction(()=>document.querySelector('.media-viewer__image')?.complete);
  const openedAt=await page.evaluate(()=>performance.now());
  results.push({automatic:true,fullWidth:await page.locator('.media-viewer').evaluate(e=>e.getBoundingClientRect().width===innerWidth),companion:await page.locator('.media-viewer .avatar-companion').count()});
  await page.mouse.move(700,450);
  await page.waitForFunction(()=>!document.querySelector('.media-viewer'),null,{timeout:6500});
  results.push({autoCloseMs:Math.round(await page.evaluate(()=>performance.now())-openedAt)});
  await send('爸爸老师，再看刚才的图片');
  await page.locator('.media-viewer').waitFor();
  await page.waitForFunction(()=>!document.querySelector('#textForm button').disabled);
  results.push({voiceReplay:true,oldReplySuppressed:await page.locator('#liveTurn').isHidden(),cancelled:requests.some(r=>r.pathname.endsWith('/cancel'))});
  // Feed another transcript through the hidden helper form while the image is open.
  await page.locator('#textInput').evaluate(e=>{e.value='把图片关掉';e.form.requestSubmit();});
  await page.waitForFunction(()=>!document.querySelector('.media-viewer'));
  results.push({voiceClose:true});
  await page.locator('#playButton').click();
  await page.locator('[data-music-mode="piano"]').click();
  await page.locator('.music-studio').waitFor();
  await page.waitForFunction(()=>document.querySelector('#statusText')?.textContent==='我在听，请说话…');
  await page.locator('#textInput').evaluate(e=>{e.value='换一组';e.form.requestSubmit();});
  await page.waitForTimeout(3000);
  results.push({musicVoiceNewGroup:requests.some(r=>r.text?.includes('咪、来、哆')),ttsRequested:requests.some(r=>r.pathname==='/api/tts'),dadPresent:await page.locator('.music-studio .avatar-companion').count(),listeningResumed:await page.locator('#statusText').textContent()});
  await page.locator('.music-studio__back').click();
  const physical=await page.evaluate(()=>qaPhysicalRequests);
  if(errors.length||physical) throw new Error(JSON.stringify({errors,physical}));
  if(!results[0].fullWidth||results[0].companion!==1||results[1].autoCloseMs<4300||results[1].autoCloseMs>6000||!results[2].oldReplySuppressed||!results[2].cancelled||!results[4].musicVoiceNewGroup||results[4].listeningResumed!=='我在听，请说话…') throw new Error(JSON.stringify(results));
  return {pass:true,results,physical,errors,syntheticRequestCount:requests.length};
}
