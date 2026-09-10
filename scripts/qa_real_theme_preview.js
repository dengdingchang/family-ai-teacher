async (page) => {
  const context=await page.context().browser().newContext({viewport:{width:1280,height:850}});
  page=await context.newPage(); const errors=[], requests=[]; let outcome;
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    navigator.mediaDevices ??= {};
    navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('No physical media','NotAllowedError');};
    globalThis.WebSocket=class extends EventTarget{static CONNECTING=0;static OPEN=1;static CLOSED=3;constructor(){super();this.readyState=3;}send(){}close(){}};
    const original=fetch.bind(window);window.fetch=(input,init)=>String(input).includes('interaction-interval')?Promise.resolve(new Response('{"ok":true}')):original(input,init);
  });
  await page.route('**/*',route=>{
    const request=route.request(),url=request.url(),path=url.replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    if(!url.startsWith('http://127.0.0.1:8760/'))return route.abort();
    if(path==='/api/profile')return route.fulfill({json:{name:'界面测试',enabled_activities:['music']}});
    if(path==='/api/memory/history')return route.fulfill({json:{history:[]}});
    // Only the named image-generation flow is real in this targeted follow-up.
    if(/^\/api\/(media\/suggestions|image-generation\/jobs\/|generated-media\/)/.test(path)) {requests.push(path);if(path==='/api/media/suggestions')return page.waitForTimeout(800).then(()=>route.continue());return route.continue();}
    if(path.startsWith('/api/')&&!['/api/avatar','/api/avatar/idle'].includes(path))return route.fulfill({status:path==='/api/tts'?503:200,json:{ok:false}});
    return route.continue();
  });
  try{
    await page.goto('http://127.0.0.1:8760/');await page.waitForFunction(()=>document.querySelector('#serviceBadge').textContent==='准备好了');
    await page.locator('#playButton').click();await page.locator('[data-music-mode=piano]').click();
    await page.waitForFunction(()=>document.querySelector('.music-studio__feedback')?.textContent.startsWith('轮到你啦'));
    await page.evaluate(()=>{globalThis.themeStates=[];globalThis.themeObserver=new MutationObserver(()=>themeStates.push(document.querySelector('.music-studio__feedback').textContent));themeObserver.observe(document.querySelector('.music-studio__feedback'),{childList:true,subtree:true,characterData:true});});
    await page.locator('.music-studio__controls button').filter({hasText:'换主题'}).click();
    const start=Date.now();await page.getByRole('button',{name:'植物大战僵尸 · 预览',exact:true}).click();
    await page.locator('.music-studio__key[data-note=C4]').click();
    const whileWaiting=await page.evaluate(()=>({status:document.querySelector('.music-studio__theme-status').textContent,feedback:document.querySelector('.music-studio__feedback').textContent,keyResponded:document.querySelector('.music-studio__key[data-note=C4]').classList.contains('is-playing')}));
    await page.screenshot({path:'output/playwright/playtime-plants-waiting.png'});
    await page.waitForFunction(()=>{const image=document.querySelector('.music-studio__scene-art');return image?.complete&&image.naturalWidth>0;},null,{timeout:300000});
    const loaded=await page.evaluate(()=>{const image=document.querySelector('.music-studio__scene-art');return {theme:document.querySelector('.music-studio').dataset.theme,alt:image.alt,width:image.naturalWidth,height:image.naturalHeight,states:themeStates,images:document.querySelectorAll('.music-studio__scene-art').length,keysClear:[...document.querySelectorAll('.music-studio__key')].every(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})};});
    await page.screenshot({path:'output/playwright/playtime-plants-loaded.png'});
    await page.evaluate(()=>themeObserver.disconnect());
    await page.locator('.music-studio__back').click();
    outcome={status:whileWaiting.keyResponded&&whileWaiting.status.includes('正在准备植物大战僵尸')&&loaded.keysClear&&loaded.theme==='plants-zombies'&&loaded.images===1&&loaded.states.some(s=>s.includes('正在准备植物大战僵尸'))?'PASS':'FAIL',durationMs:Date.now()-start,requestDelayMs:800,whileWaiting,loaded,requests:requests.length,errors,boundary:'Actual named-theme click and existing generation service; family APIs and physical media isolated, TTS deliberately not repeated.'};
  }finally{await context.close();}
  if(errors.length)outcome.status='FAIL';return outcome;
}
