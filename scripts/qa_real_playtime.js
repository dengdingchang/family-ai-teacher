async (page) => {
  const context=await page.context().browser().newContext(); page=await context.newPage();
  let outcome;
  const errors=[], requests=[], results=[];
  page.on('pageerror',e=>errors.push(e.message)); page.setDefaultTimeout(10000);
  await page.addInitScript(()=>{
    globalThis.realQa={frames:0,playback:[],denied:0};
    navigator.mediaDevices ??= {};
    try { localStorage.removeItem('family-ai-teacher.music-practice.v1'); } catch (_) { /* blank teardown document */ }
    navigator.mediaDevices.getUserMedia=async()=>{realQa.denied++;throw new DOMException('No physical media in QA','NotAllowedError');};
    const draw=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas.id==='avatarCanvas')realQa.frames++;return draw.apply(this,args);};
    addEventListener('family-audio-playback',e=>realQa.playback.push(e.detail.type));
    const original=fetch.bind(window);window.fetch=(input,init)=>String(input).includes('interaction-interval')?Promise.resolve(new Response('{"ok":true}')):original(input,init);
  });
  await page.route('**/*',route=>{
    const request=route.request(), url=request.url(), path=url.replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    if(!url.startsWith('http://127.0.0.1:8760/')) return route.abort();
    if(path==='/api/profile')return route.fulfill({json:{name:'界面测试',enabled_activities:['game','music','drawing','story']}});
    if(path==='/api/memory/history')return route.fulfill({json:{history:[]}});
    if(path.startsWith('/api/')&&!['/api/tts','/api/avatar','/api/avatar/idle'].includes(path)) return route.fulfill({json:{ok:true,history:null}});
    if(path==='/api/tts')requests.push('real TTS');
    return route.continue();
  });
  try{
    await page.goto('http://127.0.0.1:8760/');await page.waitForFunction(()=>document.querySelector('#serviceBadge').textContent==='准备好了');
    await page.locator('#playButton').click();await page.locator('[data-chess=true]').click();
    const ended=()=>page.evaluate(()=>realQa.playback.filter(t=>t==='ended').length);
    const waitEnd=n=>page.waitForFunction(n=>realQa.playback.filter(t=>t==='ended').length>n,n,{timeout:35000});
    await waitEnd(0);
    for(const square of ['e2','e3']){const before=await ended();await page.locator(`[data-square=${square}]`).click();await waitEnd(before);}
    results.push({chessCompleted:await page.locator('.chess-board__celebration').isVisible(),frames:await page.evaluate(()=>realQa.frames)});
    await page.screenshot({path:'output/playwright/playtime-real-tts-chess.png'});
    await page.locator('.chess-board__continue').click();
    await page.waitForFunction(()=>realQa.playback.at(-1)==='scheduled');
    const start=Date.now();await page.locator('.chess-board__back').click();
    await page.waitForFunction(()=>!document.querySelector('#playButton').disabled,null,{timeout:2500});
    results.push({chessCloseMs:Date.now()-start});
    if(await page.locator('#playButton').getAttribute('aria-expanded')!=='true')await page.locator('#playButton').click();
    await page.locator('[data-music-mode=piano]').click();
    await page.waitForFunction(()=>document.querySelector('.music-studio__feedback')?.textContent.startsWith('轮到你啦'),null,{timeout:35000});
    for(const key of ['a','s','d']){await page.keyboard.press(key);await page.waitForTimeout(250);}
    await page.waitForFunction(()=>!document.querySelector('.music-studio__next').hidden);
    const before=await ended();await waitEnd(before);
    results.push({musicCompleted:true,frames:await page.evaluate(()=>realQa.frames)});
    await page.screenshot({path:'output/playwright/playtime-real-tts-music.png'});
    await page.locator('.music-studio__back').click();
    outcome={status:errors.length || !results[0].chessCompleted || !results.at(-1).frames ? 'FAIL':'PASS',results,requests:requests.length,errors,boundary:'Saved project and live TTS/Avatar services; profile/history/commits/timing intercepted, physical mic/camera denied. Real sound and avatar frames, not human hearing/lipsync acceptance.'};
  }finally{await context.close();}
  if(errors.length)outcome.status='FAIL';
  return outcome;
}
