async (page, baseUrl = "http://127.0.0.1:8760") => {
  const errors = [], layouts = [], tts = [];
  let releaseSpeech, failSpeech = false;
  const json = payload => ({ contentType: "application/json", body: JSON.stringify(payload) });
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/ws/avatar", socket => socket.close());
  await page.addInitScript(() => {
    window.__mediaRequests = [];
    navigator.mediaDevices ??= {};
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__mediaRequests.push(constraints);
      if (constraints.audio) throw new Error("No physical microphone in QA");
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#e7efe8"; ctx.fillRect(0, 0, 320, 240);
      return canvas.captureStream(0);
    };
  });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/avatar") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#e7efe8"/><text x="320" y="240" text-anchor="middle" font-size="28" fill="#205844">爸爸老师 · 布局测试</text></svg>' });
    if (path === "/api/tts") {
      tts.push(JSON.parse(route.request().postData()));
      await new Promise(resolve => { releaseSpeech = resolve; });
      return failSpeech ? route.fulfill({ status: 503, ...json({}) }) : route.fulfill(json({
        audio_base64: "UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA", audio_mime: "audio/wav",
      }));
    }
    return route.fulfill(json(path === "/api/profile" ? { name: "布局测试", enabled_activities: ["drawing", "story", "game", "vision_photo", "vision_video"] }
      : path === "/api/memory/history" ? { history: [] } : { ok: true }));
  });
  await page.route("**/health", route => route.fulfill(json({ tts_ready: true, stt_ready: true, tts_warmup: "ready", llm_configured: true })));
  const checkLayout = () => page.evaluate(() => {
    const frame = document.querySelector('.child-video .video-frame').getBoundingClientRect();
    const toolbar = document.querySelector('#cameraToolbar').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('.camera-tool')].filter(node => node.getClientRects().length).map(node => {
      const r = node.getBoundingClientRect();
      return { width: r.width, height: r.height, x: r.x, right: r.right, y: r.y, bottom: r.bottom };
    });
    const label = document.querySelector('.camera-state');
    return { overflow: document.documentElement.scrollWidth > innerWidth,
      outsidePreview: toolbar.y >= frame.bottom, labelFits: label.scrollWidth <= label.clientWidth,
      primary: document.querySelector('.stage-card').dataset.callPrimary, buttons,
      controlsFit: buttons.every(r => r.width >= 44 && r.height >= 44 && r.x >= toolbar.x && r.right <= toolbar.right + .5 && r.bottom <= toolbar.bottom + .5) };
  });
  for (const [width, height] of [[320, 700], [390, 844], [768, 1024], [1024, 768], [1400, 900]]) {
    await page.setViewportSize({ width, height }); await page.goto(baseUrl);
    await page.waitForFunction(() => document.querySelector('#serviceBadge').textContent === '准备好了');
    const closed = await checkLayout();
    await page.screenshot({ path: `output/playwright/teacher-camera-${width}-closed.png` });
    await page.locator('#cameraButton').click();
    await page.waitForFunction(() => document.querySelector('#cameraButton').dataset.open === 'true');
    const opened = await checkLayout();
    if (opened.primary !== 'dad') throw new Error('Camera action swapped the preview');
    await page.screenshot({ path: `output/playwright/teacher-camera-${width}-open.png` });
    await page.locator('.child-video .video-frame').click(); const swapped = await checkLayout();
    await page.locator('.dad-video .video-frame').click();
    await page.locator('#dadExpandButton').click(); const immersive = await checkLayout();
    await page.keyboard.press('Escape'); await page.locator('#cameraButton').click();
    layouts.push({ width, height, closed, opened, swapped, immersive });
    if ([closed, opened, swapped, immersive].some(x => x.overflow || !x.outsidePreview || !x.controlsFit || !x.labelFits)) throw new Error(`Camera layout failed at ${width}`);
  }
  await page.locator('#playButton').click();
  await page.locator('#playChoices [data-chess]').click();
  await page.waitForFunction(() => document.querySelector('.chess-board__grid')?.getAttribute('aria-busy') === 'true');
  const locked = () => page.evaluate(() => document.querySelectorAll('.chess-board__square:disabled').length === 64 && !document.querySelector('.is-guidance-source'));
  if (!await locked()) throw new Error('Board unlocked before TTS');
  await page.locator('[data-square="b4"]').dispatchEvent('click');
  if (!await page.locator('.chess-board__celebration').isHidden()) throw new Error('Early tap completed the lesson');
  await page.screenshot({ path: 'output/playwright/teacher-chess-listening.png' });
  failSpeech = true; releaseSpeech();
  await page.waitForFunction(() => document.querySelector('.chess-board__grid').getAttribute('aria-busy') === 'false');
  if (!await locked()) throw new Error('Failed narration unlocked the board');
  await page.getByRole('button', { name: '再听一遍', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.chess-board__grid').getAttribute('aria-busy') === 'true');
  failSpeech = false; releaseSpeech();
  await page.waitForFunction(() => document.querySelectorAll('.chess-board__square:disabled').length === 0);
  await page.locator('[data-square="b4"]').click();
  await page.locator('.chess-board__continue').click();
  await page.waitForFunction(() => document.querySelector('.chess-board__lesson-title').textContent === '认识三颗棋子');
  if (!await locked()) throw new Error('Next lesson unlocked before explanation');
  const mediaRequests = await page.evaluate(() => window.__mediaRequests);
  if (mediaRequests.some(x => x.audio) || errors.length) throw new Error(JSON.stringify({ errors, mediaRequests }));
  releaseSpeech();
  await page.getByRole('button', { name: '← 返回' }).click();
  await page.goto('about:blank');
  if (errors.length) throw new Error(JSON.stringify(errors));
  return { status: 'PASS', layouts, tts: tts.length, mediaRequests, errors, boundary: 'Local static candidate; API, TTS and avatar mocked; camera uses an in-memory canvas stream, no physical device, GPU service or family data.' };
}
