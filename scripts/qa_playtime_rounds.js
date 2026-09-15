async (page) => {
  const root = "X:/Workspace/family-ai-teacher";
  const context = await page.context().browser().newContext({ hasTouch:true, viewport:{width:1000,height:850} });
  page = await context.newPage(); const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const check = (value, message) => { if (!value) throw new Error(message); };
  try {
    await page.route("**/*", route => {
      const path = route.request().url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      if (path === "/") return route.fulfill({contentType:"text/html",body:'<!doctype html><link rel="stylesheet" href="/chess-board.css"><link rel="stylesheet" href="/music-studio.css"><link rel="stylesheet" href="/drawing-board.css"><button id="open">开始</button>'});
      return route.fulfill({path:`${root}/frontend${path}`});
    });
    await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new Error("No physical media"); }; });
    await page.goto("http://127.0.0.1:8760/");
    await page.evaluate(async () => {
      const {ChessBoard} = await import('/chess-board.js'); const {MusicStudio} = await import('/music-studio.js'); await import('/drawing-board.js');
      globalThis.chess = new ChessBoard({nativeFullscreen:false,onSpeak:async()=>({ok:true})});
      globalThis.synth = new AudioContext(); globalThis.destination = synth.createMediaStreamDestination();
      globalThis.music = new MusicStudio({storage:null,onSpeak:async()=>({ok:true}),transcribe:async()=>"啦啦啦（合成测试）",acquireMicrophone:async()=>{
        await synth.resume();
        for (const [index, hz] of [261.63,293.66,329.63].entries()) {
          const oscillator=synth.createOscillator(), gain=synth.createGain(), at=synth.currentTime+index*1.5;
          oscillator.frequency.value=hz; gain.gain.value=.15; oscillator.connect(gain); gain.connect(destination);
          oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();}; oscillator.start(at);oscillator.stop(at+1.25);
        }
        return destination.stream;
      }});
      globalThis.observed = 0;
      globalThis.drawing = createDrawingBoard({nativeFullscreen:false,onObserve:async(blob)=>{if(blob.size>0) observed++; return {text:"我看到一条你画的线，我们再添一条吧。"};}});
      document.querySelector('#open').onclick=()=>chess.open();
    });
    await page.locator('#open').click(); await page.getByRole('button',{name:'和爸爸下棋',exact:true}).click();
    await page.locator('[data-square="e2"]').click(); await page.locator('[data-square="e4"]').click();
    await page.waitForFunction(()=>chess.game.history().length===2 && chess.game.turn()==='w');
    const chessRound = await page.evaluate(()=>({moves:chess.game.history(),whiteTurn:chess.game.turn()==='w'}));
    await page.getByRole('button',{name:'悔棋一回合',exact:true}).click();
    check(await page.evaluate(()=>chess.game.history().length===0),'undo round failed');
    await page.evaluate(()=>{chess.close(); music.open(); music.setMode('sing');});
    await page.locator('.music-studio__demo').click(); await page.waitForFunction(()=>!music.demoActive);
    await page.locator('.music-studio__turn').tap();
    await page.waitForFunction(()=>music.recording?.recorder.state==='recording');
    await page.waitForFunction(()=>music.listeningAllowed && !music.recording, null, {timeout:8000});
    const singing = await page.evaluate(()=>music.feedback.textContent);
    check(/音高：.*节奏：.*合成测试.*发音这次没有评估/.test(singing),'singing complete feedback missing');
    await page.screenshot({path:`${root}/output/playwright/playtime-singing.png`});
    await page.evaluate(()=>{music.close();drawing.open();});
    const canvas=page.locator('.drawing-board__canvas'), box=await canvas.boundingBox();
    await page.mouse.move(box.x+40,box.y+50); await page.mouse.down(); await page.mouse.move(box.x+180,box.y+130,{steps:12}); await page.mouse.up();
    await page.waitForFunction(()=>observed===1, null, {timeout:7000});
    check(await page.evaluate(()=>drawing.revision>0),'drawing unchanged');
    await page.screenshot({path:`${root}/output/playwright/playtime-drawing.png`});
    await page.keyboard.press('Escape'); check(await page.evaluate(()=>!drawing.isOpen),'drawing did not close');
    await page.evaluate(()=>{chess.destroy();music.destroy();drawing.destroy();destination.stream.getTracks().forEach(t=>t.stop());void synth.close();});
    check(!errors.length,'page error');
    return {status:'PASS',chessRound,undo:true,singing,drawingObservation:true,errors,boundary:'Real legal chess opponent, real browser reference tones and MediaRecorder of three synthetic tones, actual canvas stroke/observation queue with mock description. No physical mic/camera, family data or remote service.'};
  } finally { await context.close(); }
}
