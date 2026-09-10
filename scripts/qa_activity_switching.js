async (page) => {
  const root = "C:/Users/user/.codex/worktrees/13e8/family-ai-teacher";
  const context = await page.context().browser().newContext({ hasTouch: true });
  page = await context.newPage();
  const requests = [], errors = [], results = [];
  let gameFixture = [], gameRounds = 0;
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  page.on("pageerror", error => errors.push(error.message));
  try {
    const wav = await page.evaluate(() => {
      const bytes = new Uint8Array(44 + 8000 * 2 * 4), view = new DataView(bytes.buffer);
      const text = (at, s) => [...s].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
      text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt ");
      view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
      view.setUint32(24,8000,true); view.setUint32(28,16000,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
      text(36,"data"); view.setUint32(40,bytes.length-44,true);
      return btoa(String.fromCharCode(...bytes));
    });
    await page.addInitScript(() => {
      globalThis.qaAudio = []; globalThis.qaStreams = []; globalThis.qaPlayback = [];
      const originalFetch = fetch.bind(window);
      window.fetch = (input, init) => String(input).includes("interaction-interval")
        ? Promise.resolve(new Response('{"ok":true}')) : originalFetch(input, init);
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (constraints.video) throw new Error("No physical camera");
        const context = new AudioContext(); await context.resume();
        const stream = context.createMediaStreamDestination().stream;
        qaAudio.push(context); qaStreams.push(stream); return stream;
      };
      globalThis.WebSocket = class extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
        constructor() { super(); this.readyState = 3; } send() {} close() {}
      };
      addEventListener("family-audio-playback", event => qaPlayback.push(event.detail.type));
    });
    await page.route("**/*", route => {
      const path = route.request().url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      if (path === "/qa-game-fixture.json") return route.fulfill({path:`${root}/runtime/playtime-game-fixture.json`});
      if (path === "/health") return route.fulfill({ json: { status: "ok", tts_ready:true, stt_ready:true, tts_warmup:"ready", llm_configured:true, avatar_idle_ready:false } });
      if (path.startsWith("/api/")) {
        requests.push({ path, method: route.request().method() });
        if (path === "/api/profile") return route.fulfill({ json: { name:"界面测试", enabled_activities:["story","game","music","drawing"] } });
        if (path === "/api/memory/history") return route.fulfill({ json: { history:[] } });
        if (path === "/api/avatar") return route.fulfill({ contentType:"image/svg+xml", body:'<svg xmlns="http://www.w3.org/2000/svg" width="220" height="165"><rect width="220" height="165" fill="#dfd5c6"/></svg>' });
        if (path === "/api/tts") return route.fulfill({ json: { audio_base64:wav, audio_mime:"audio/wav" } });
        if (path === "/api/conversation/text/stream") {
          const text = route.request().postDataJSON().text;
          const game = gameFixture.find(item => item.text === text); if (game) gameRounds++;
          const reply = game?.reply || "合成故事回合已结束。";
          const events = [{event:"user_text",text}, {event:"assistant_delta",text:reply}, {event:"done",ok:true,assistant_text:reply,commit_required:true}];
          return route.fulfill({ contentType:"text/event-stream", body:events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join("") });
        }
        return route.fulfill({ json: { ok:true, history:null } });
      }
      return route.fulfill({ path:`${root}/frontend${path === "/" ? "/index.html" : path}` });
    });
    await page.goto("http://127.0.0.1:8760/");
    await page.waitForFunction(() => document.querySelector("#serviceBadge").textContent === "准备好了");
    gameFixture = await page.evaluate(() => fetch("/qa-game-fixture.json").then(r=>r.json()));
    for (let round = 0; round < 3; round++) {
      await Promise.all([page.waitForResponse(r => r.url().includes("/api/conversation/text/stream")), page.locator('[data-activity="story"]').click()]);
      await page.waitForFunction(() => !document.querySelector("#playButton").disabled);
      if (await page.locator("#playButton").getAttribute("aria-expanded") !== "true") await page.locator("#playButton").click();
      await page.locator('[data-music-mode="piano"]').click();
      await page.waitForFunction(() => qaPlayback.at(-1) === "scheduled");
      const start = Date.now();
      await page.locator(".music-studio__back").click();
      await page.waitForFunction(() => !document.querySelector("#playButton").disabled, null, { timeout:1500 });
      results.push({ round:round+1, musicCloseMs:Date.now()-start });
      await page.evaluate(() => { qaPlayback.length = 0; });
      if (await page.locator("#playButton").getAttribute("aria-expanded") !== "true") await page.locator("#playButton").click();
      await page.locator('[data-chess="true"]').click();
      await page.waitForFunction(() => document.querySelector(".chess-board")?.hidden === false);
      await page.locator(".chess-board__back").click();
      await page.waitForFunction(() => !document.querySelector("#playButton").disabled);
    }
    if (await page.locator("#playButton").getAttribute("aria-expanded") !== "true") await page.locator("#playButton").click();
    await page.locator('[data-activity="game"]:not([data-chess])').click();
    await page.waitForFunction(() => !document.querySelector("#playButton").disabled);
    await page.locator('.grownup-help summary').click();
    for (const turn of gameFixture.slice(1)) {
      await page.locator('#textInput').fill(turn.text);
      await Promise.all([page.waitForResponse(r => r.url().includes('/api/conversation/text/stream')), page.locator('#textForm button').click()]);
      await page.waitForFunction(() => !document.querySelector('#textInput').disabled);
      check(await page.locator('#answerBox').textContent() === turn.reply, 'game reply mismatch');
    }
    check(gameRounds === 4, "complete interactive game missing");
    check(!errors.length, "browser error");
    await page.evaluate(() => { for (const s of qaStreams) s.getTracks().forEach(t=>t.stop()); for (const c of qaAudio) void c.close(); });
    return { status:"PASS", results, interactiveGame:{rounds:gameRounds,final:gameFixture.at(-1).transition}, errors, boundary:"Actual app activity buttons, simulated story/game/TTS APIs, real browser player with synthetic silence and synthetic microphone; no family records or physical media." };
  } finally { await context.close(); }
}

