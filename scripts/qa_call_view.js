async (page) => {
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.route('**/api/**', route=> {
    const path=route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if(path==='/api/avatar') return route.continue();
    const value=path==='/api/profile'?{name:'布局测试',enabled_activities:['game','story','drawing','vision_photo','vision_video']}:path==='/api/memory/history'?{history:[]}:{};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  await page.route('**/health',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({tts_ready:true,stt_ready:true,tts_warmup:'ready',llm_configured:true})}));
  await page.addInitScript(()=>{
    window.__qaMediaRequests=0; window.__qaSockets=0;
    if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=async()=>{window.__qaMediaRequests++;throw Error('No physical media in layout QA');};
    window.WebSocket=class {static OPEN=1;static CONNECTING=0;constructor(){window.__qaSockets++;this.readyState=3;}addEventListener(){}close(){}send(){}};
  });
  await page.goto('http://127.0.0.1:8760/');
  await page.addStyleTag({url:'/call-view.css'});
  await page.evaluate(async()=>{
    const {CallView}=await import('/call-view.js');
    const stage=document.querySelector('.stage-card');
    stage.requestFullscreen=()=>Promise.reject(new Error('Exercise viewport fallback'));
    window.__callView=new CallView(stage);
    window.__originalNodes=[...document.querySelectorAll('#avatarCanvas,#avatarImage,#cameraVideo,#recordButton')];
    const entry=document.createElement('button');entry.id='qaCallEntry';entry.textContent='大画面';entry.onclick=()=>window.__callView.open();stage.querySelector('.stage-heading').append(entry);
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=120;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#adbc91';ctx.fillRect(0,0,160,120);
    window.__syntheticStream=canvas.captureStream(1);
    const video=document.querySelector('#cameraVideo');video.srcObject=window.__syntheticStream;await video.play();
    window.__qaSocketsBefore=window.__qaSockets;
  });
  const results=[];
  for(const [width,height] of [[1400,900],[390,844],[320,700]]) {
    await page.setViewportSize({width,height});await page.locator('#qaCallEntry').click();
    await page.waitForTimeout(80);
    const before=await page.evaluate(()=>{
      const r=selector=>{const b=document.querySelector(selector).getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};};
      return {dad:r('.dad-video .video-frame'),child:r('.child-video .video-frame'),buttons:[...document.querySelectorAll('.call-view button')].filter(x=>x.getClientRects().length).map(x=>{const b=x.getBoundingClientRect();return {label:x.textContent.trim(),x:b.x,y:b.y,w:b.width,h:b.height};})};
    });
    await page.locator('.call-view .child-video .video-frame').click();
    const swapped=await page.evaluate(()=>document.querySelector('.stage-card').dataset.callPrimary==='child');
    await page.locator('.call-view-tools button').first().click();
    const screen=`output/playwright/call-view-${width}-20260907.png`;await page.screenshot({path:screen});
    await page.keyboard.press('Escape');
    const after=await page.evaluate(()=>({closed:!window.__callView.opened,focus:document.activeElement.id,
      sameNodes:window.__originalNodes.every(n=>n===document.getElementById(n.id)),sameStream:document.querySelector('#cameraVideo').srcObject===window.__syntheticStream,
      playing:!document.querySelector('#cameraVideo').paused,noMedia:window.__qaMediaRequests===0,noSockets:window.__qaSocketsBefore===window.__qaSockets,
      overflow:document.documentElement.scrollWidth>innerWidth,inert:document.querySelector('.topbar')?.inert||false}));
    results.push({width,height,before,swapped,after,screen});
  }
  await page.evaluate(()=>delete document.querySelector('.stage-card').requestFullscreen);
  await page.locator('#qaCallEntry').click();
  await page.waitForTimeout(150);
  const nativeEntered=await page.evaluate(()=>document.fullscreenElement===document.querySelector('.stage-card'));
  await page.locator('.child-video .video-frame').focus();
  await page.keyboard.press('Enter');
  const keyboardSwapped=await page.evaluate(()=>window.__callView.primary==='child');
  await page.locator('.call-view-tools button').last().click();
  await page.waitForTimeout(150);
  const nativeExited=await page.evaluate(()=>!document.fullscreenElement&&!window.__callView.opened&&document.activeElement.id==='qaCallEntry');
  await page.evaluate(()=>{window.__callView.destroy();window.__syntheticStream.getTracks().forEach(t=>t.stop());});
  await page.goto('about:blank');
  return {results,errors,nativeEntered,nativeExited,keyboardSwapped,status:results.every(r=>r.swapped&&r.after.focus==='qaCallEntry'&&r.before.dad.w>r.before.child.w&&r.before.buttons.length===4&&r.before.buttons.every(b=>b.w>=48&&b.h>=48&&b.x>=0&&b.x+b.w<=r.width&&b.y+b.h<=r.height)&&r.after.closed&&r.after.sameNodes&&r.after.sameStream&&r.after.playing&&r.after.noMedia&&r.after.noSockets&&!r.after.overflow&&!r.after.inert)&&nativeEntered&&nativeExited&&keyboardSwapped&&errors.length===0?'PASS':'FAIL',boundary:'Isolated unlinked call layout; real native media nodes with RAM synthetic camera stream, no physical capture or avatar connection. Tests viewport fallback and native fullscreen separately.'};
}
