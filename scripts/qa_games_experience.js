// Playwright CLI callback. Run in a fresh, dedicated QA browser session:
// npx --no-install --package @playwright/cli playwright-cli -s=music-qa open about:blank
// npx --no-install --package @playwright/cli playwright-cli -s=music-qa run-code --filename scripts/qa_games_experience.js
// Close that session afterwards. Routes read only the root checkout's static files.
// All family APIs, narration and theme art are fixtures; physical media is denied.
// Avatar/idle media are synthetic too. No requests reach the running app.
// Practice storage is disabled so viewport runs cannot inherit one another's progress.
async (page) => {
  const root = "C:/Users/user/.codex/worktrees/13e8/family-ai-teacher";
  const errors = [], externalRequests = [], apiRequests = [], results = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  await page.addInitScript(() => {
    globalThis.__qaDeniedMedia = []; globalThis.__qaSocketCount = 0;
    navigator.mediaDevices ??= {};
    navigator.mediaDevices.getUserMedia = async constraints => {
      __qaDeniedMedia.push(constraints); throw new DOMException("Physical media forbidden in QA", "NotAllowedError");
    };
    globalThis.WebSocket = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
      constructor() { super(); __qaSocketCount++; this.readyState = 1;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ready", audio_stream_protocol: true }) }))); }
      send() {} close() { this.readyState = 3; }
    };
  });
  await page.route("**/*", route => {
    const request = route.request(), url = request.url(), pathname = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (!url.startsWith("http://127.0.0.1:8760/")) { externalRequests.push(url); return route.abort(); }
    if (pathname === "/health") return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      tts_ready: true, stt_ready: true, tts_warmup: "ready", llm_configured: true, avatar_idle_ready: true,
    }) });
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/avatar") return route.fulfill({contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="220" height="165"><rect width="220" height="165" fill="#dfd5c6"/><text x="20" y="80">QA 爸爸画面占位</text></svg>'});
      if (pathname === "/api/avatar/idle") return route.fulfill({status:404,body:""});
      apiRequests.push({ pathname, method: request.method() });
      const payload = pathname === "/api/profile" ? { name: "界面测试", enabled_activities: ["drawing", "story", "game", "music"] }
        : pathname === "/api/memory/history" ? { history: [
          { user_text: "我们看月亮吧", assistant_text: "月亮有时圆，有时像弯弯的小船。", created_at: "2026-09-10T08:00:00+08:00" },
          { user_text: "我想听三个音", assistant_text: "我们一起试试，先听再按。", created_at: "2026-09-10T08:01:00+08:00" },
        ] } : { ok: true };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    }
    if (request.method() !== "GET") { externalRequests.push(`${request.method()} ${pathname}`); return route.abort(); }
    return route.fulfill({ path: `${root}/frontend${pathname === "/" ? "/index.html" : pathname}` });
  });
  await page.route("http://127.0.0.1:8760/api/generated-media/music-theme-qa.svg", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="20" fill="#f5dd96"/><circle cx="60" cy="55" r="32" fill="#5b8975"/><path d="M45 52h10m12 0h10M47 72q13 10 26 0" fill="none" stroke="white" stroke-width="5"/></svg>' }));
  for (const size of [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 1400, height: 900 }]) {
    await page.setViewportSize(size); await page.goto("http://127.0.0.1:8760/", { timeout: 12000 });
    await page.waitForFunction(() => document.querySelector("#serviceBadge")?.textContent === "准备好了");
    await page.evaluate(async () => {
      const { MusicStudio } = await import("/music-studio.js");
      globalThis.__musicSpeech = []; globalThis.__musicAudio = []; globalThis.__musicListening = []; globalThis.__musicClock = null; globalThis.__themesRequested = [];
      globalThis.__music = new MusicStudio({ storage: null, onSpeak: async text => { __musicSpeech.push(text); return { ok: true }; },
        now: () => __musicClock ?? performance.now(), onListeningChange: value => __musicListening.push(value),
        onThemeRequest: async subject => { __themesRequested.push(subject); return "/api/generated-media/music-theme-qa.svg"; },
        audioContextFactory: () => {
          const audio = new AudioContext(), create = audio.createOscillator.bind(audio);
          audio.createOscillator = () => { const oscillator = create(), set = oscillator.frequency.setValueAtTime.bind(oscillator.frequency);
            oscillator.frequency.setValueAtTime = (value, time) => { __musicAudio.push({ value, time }); return set(value, time); }; return oscillator; };
          return audio;
        } });
      __music.open();
    });
    await page.waitForFunction(() => document.querySelector(".music-studio > .avatar-companion:not([hidden])"));
    const inspect = async () => page.evaluate(() => {
      const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
      const visible = node => node.getClientRects().length > 0;
      return { mode: __music.mode, level: __music.journey.index + 1, count: __music.reference.length, completed: __music.journey.completed.size,
        keys: [...__music.keys.values()].map(node => { const r = box(node); return { ...r, clickable: node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; }),
        buttons: [...__music.element.querySelectorAll(".music-studio__controls button")].filter(visible).map(box),
        keyboard: box(__music.keyboard), stage: box(__music.rhythmStage), feedback: __music.feedback.textContent,
        floating: Boolean(__music.element.querySelector(".avatar-companion:not([hidden])")), horizontalOverflow: __music.element.scrollWidth > innerWidth,
        listening: __music.listeningAllowed, audioCount: __musicAudio.length, theme: __music.element.dataset.theme };
    });
    await page.locator(".music-studio__keys").scrollIntoViewIfNeeded();
    const initial = await inspect(); await page.screenshot({ path: `output/playwright/games-experience-piano-${size.width}x${size.height}-20260910.png` });
    await page.locator(".music-studio__demo").click(); await page.waitForFunction(() => !__music.demoActive, null, { timeout: 7000 });
    const audibleDemo = await page.evaluate(() => __musicAudio.slice().map(note => note.value));
    for (const key of ["a", "s", "d"]) { await page.keyboard.press(key); await page.waitForTimeout(160); }
    await page.waitForFunction(() => __music.journey.completed.size === 1 && __music.listeningAllowed, null, { timeout: 5000 });
    const completed = await inspect();
    await page.locator(".music-studio__next").click(); await page.waitForFunction(() => !__music.demoActive, null, { timeout: 7000 });
    const advanced = await inspect();
    await page.getByRole("button", { name: "接音符", exact: true }).click(); await page.waitForFunction(() => __music.rhythmRound?.active);
    await page.evaluate(() => { __musicClock = __music.rhythmRound.dueAt - 200; }); await page.waitForTimeout(70);
    await page.locator(".music-studio__keys").scrollIntoViewIfNeeded();
    const rhythmStart = await inspect(); await page.screenshot({ path: `output/playwright/games-experience-rhythm-${size.width}x${size.height}-20260910.png` });
    await page.keyboard.press("g");
    const wrongStayed = await page.evaluate(() => __music.rhythmRound.index === 0);
    for (const key of ["d", "s", "a"]) {
      await page.evaluate(() => { __musicClock = __music.rhythmRound.dueAt + 900; }); await page.waitForTimeout(50); await page.keyboard.press(key);
    }
    await page.waitForFunction(() => !__music.rhythmRound && __music.listeningAllowed, null, { timeout: 5000 });
    const rhythmComplete = await inspect();
    await page.locator(".music-studio__controls button").filter({ hasText: "换主题" }).click();
    await page.getByRole("button", { name: "奥特曼 · 预览", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".music-studio__scene-art")].length === 1 && [...document.querySelectorAll(".music-studio__scene-art")].every(image => image.complete && image.naturalWidth));
    await page.locator(".music-studio__keys").scrollIntoViewIfNeeded();
    const themePreview = await inspect(); await page.screenshot({ path: `output/playwright/games-experience-theme-${size.width}x${size.height}-20260910.png` });
    await page.keyboard.press("Escape");
    results.push({ size, initial, audibleDemo, completed, advanced, rhythmStart, wrongStayed, rhythmComplete, themePreview,
      closed: await page.locator(".music-studio").isHidden(), deniedMedia: await page.evaluate(() => __qaDeniedMedia.length) });
  }
  await page.goto("about:blank");
  const visibleKeys = result => !result.horizontalOverflow && result.floating && result.keys.every(key => key.width >= 48 && key.height >= 48 && key.clickable);
  return { status: errors.length || externalRequests.length || results.some(result => !visibleKeys(result.initial) || !visibleKeys(result.rhythmStart)
    || !visibleKeys(result.themePreview) || result.audibleDemo.join(",") !== "261.63,293.66,329.63" || result.completed.completed !== 1
    || result.advanced.level !== 2 || !result.wrongStayed || result.rhythmComplete.completed !== 2 || !result.closed || result.deniedMedia) ? "FAIL" : "PASS",
    results, errors, externalRequests, apiRequests,
    boundary: "Production modules/styles, real Web Audio oscillators and keyboard/pointer input; narration, theme image and family APIs are synthetic. No physical microphone, family writes, TTS generation or downloaded character assets." };
}
