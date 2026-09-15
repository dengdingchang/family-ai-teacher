async (page) => {
  const context = await page.context().browser().newContext({
    hasTouch: true,
    viewport: { width: 768, height: 1024 },
  });
  page = await context.newPage();
  const errors = [], mediaRequests = [], results = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/ws/avatar", socket => socket.close());
  await page.addInitScript(() => {
    window.__tabletMediaRequests = [];
    navigator.mediaDevices ??= {};
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__tabletMediaRequests.push(constraints);
      throw new Error("Physical media is disabled in tablet QA");
    };
  });
  await page.route("**/api/**", route => {
    const pathname = route.request().url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (pathname === "/api/avatar") return route.continue();
    const payload = pathname === "/api/profile"
      ? { name: "平板测试", enabled_activities: ["drawing", "story", "game", "music", "vision_photo", "vision_video"] }
      : pathname === "/api/memory/history" ? { history: [] }
      : { ok: true };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.route("**/health", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    tts_ready: true, stt_ready: true, tts_warmup: "ready", llm_configured: true,
  }) }));

  const openHome = async size => {
    await page.setViewportSize(size);
    await page.goto("http://127.0.0.1:8760/");
    await page.waitForFunction(() => document.querySelector("#serviceBadge")?.textContent === "准备好了");
  };

  try {
    for (const size of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
      await openHome(size);
      const initial = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        controls: [...document.querySelectorAll("button:not([hidden]):not(:disabled),a[href]")]
          .filter(el => el.getClientRects().length && !el.classList.contains("skip-link"))
          .map(el => { const r = el.getBoundingClientRect(); return { label: el.getAttribute("aria-label") || el.textContent.trim(), width:r.width, height:r.height }; }),
      }));
      await page.locator(".child-video .video-frame").tap();
      const childPrimary = await page.locator(".stage-card").getAttribute("data-call-primary");
      await page.locator(".dad-video .video-frame").tap();
      const dadPrimary = await page.locator(".stage-card").getAttribute("data-call-primary");
      await page.locator("#playButton").tap();
      const menuVisible = await page.locator("#playChoices").isVisible();
      results.push({ size, initial, childPrimary, dadPrimary, menuVisible });
    }

    await openHome({ width: 768, height: 1024 });
    await page.locator('[data-activity="drawing"]').tap();
    await page.waitForSelector(".drawing-board");
    const drawing = await page.locator(".drawing-board").isVisible();

    await openHome({ width: 768, height: 1024 });
    await page.locator("#playButton").tap();
    await page.locator('[data-chess="true"]').tap();
    await page.waitForSelector(".chess-board");
    const chess = await page.locator(".chess-board").isVisible();

    await openHome({ width: 768, height: 1024 });
    await page.locator("#playButton").tap();
    await page.locator('[data-music-mode="piano"]').tap();
    await page.waitForSelector(".music-studio");
    const piano = await page.locator(".music-studio").isVisible();
    const pianoMediaRequests = await page.evaluate(() => window.__tabletMediaRequests.length);

    await openHome({ width: 768, height: 1024 });
    await page.locator("#playButton").tap();
    await page.locator('[data-music-mode="sing"]').tap();
    await page.waitForSelector(".music-studio");
    const singing = await page.locator(".music-studio").isVisible();
    const singingMediaRequests = await page.evaluate(() => window.__tabletMediaRequests.length);

    const pass = results.every(item => !item.initial.overflow
      && item.initial.controls.every(control => control.width >= 47.5 && control.height >= 47.5)
      && item.childPrimary === "child" && item.dadPrimary === "dad" && item.menuVisible)
      && drawing && chess && piano && singing && pianoMediaRequests === 0 && singingMediaRequests === 1 && errors.length === 0;
    return {
      status: pass ? "PASS" : "FAIL", results, drawing, chess, piano, singing,
      pianoMediaRequests, singingMediaRequests, errors,
      boundary: "Production tablet UI with synthetic profile/health APIs, blocked avatar socket, and denied physical microphone/camera. No family data is read or written.",
    };
  } finally {
    await context.close();
  }
}
