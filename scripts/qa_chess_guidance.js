async (page) => {
  const errors = [], tts = [], mediaRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/ws/avatar", socket => socket.close());
  await page.addInitScript(() => {
    navigator.mediaDevices ??= {};
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__chessMediaRequests.push(constraints);
      throw new Error("Physical media is forbidden in chess QA");
    };
    window.__chessMediaRequests = [];
  });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const pathname = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (pathname === "/api/avatar") return route.continue();
    if (pathname === "/api/tts") {
      tts.push(JSON.parse(request.postData() || "{}"));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        audio_base64: "UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA",
        audio_mime: "audio/wav",
      }) });
    }
    const payload = pathname === "/api/profile"
      ? { name: "棋盘测试", enabled_activities: ["game"] }
      : pathname === "/api/memory/history" ? { history: [] } : { ok: true };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.route("**/health", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    tts_ready: true, stt_ready: true, tts_warmup: "ready", llm_configured: true,
  }) }));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:8760/");
  await page.locator("#playButton").click();
  await page.locator("#playChoices button", { hasText: "下棋" }).click();
  await page.locator(".chess-board:not([hidden])").waitFor();
  await page.locator('[data-square="b4"]').click();
  await page.locator('.chess-board__continue').click();
  for (const square of ["e2", "d4", "c3"]) await page.locator(`[data-square="${square}"]`).click();
  await page.locator('.chess-board__continue').click();
  await page.waitForFunction(() => document.querySelector('.chess-board__grid').getAttribute('aria-busy') === 'false');
  const source = await page.evaluate(() => ({
    source: document.querySelector('[data-square="e2"]').classList.contains("is-guidance-source"),
    target: document.querySelector('[data-square="e3"]').classList.contains("is-guidance-target"),
    lineHidden: document.querySelector(".chess-board__guide-path line").hidden,
  }));
  await page.locator('[data-square="e2"]').click();
  await page.waitForFunction(() => document.querySelector('.chess-board__grid').getAttribute('aria-busy') === 'false');
  const path = await page.evaluate(() => ({
    source: document.querySelector('[data-square="e2"]').classList.contains("is-guidance-source"),
    target: document.querySelector('[data-square="e3"]').classList.contains("is-guidance-target"),
    lineHidden: document.querySelector(".chess-board__guide-path line").hidden,
    coordinates: document.querySelector('[data-square="e2"] .chess-board__coordinate').textContent
      + "→" + document.querySelector('[data-square="e3"] .chess-board__coordinate').textContent,
  }));
  await page.screenshot({ path: "output/playwright/chess-guidance-learn-390x844.png", fullPage: false });
  await page.getByRole("button", { name: "和爸爸下棋" }).click();
  await page.getByRole("button", { name: "给我提示" }).click();
  await page.waitForFunction(() => document.querySelector('.chess-board__grid').getAttribute('aria-busy') === 'false');
  const playHint = await page.evaluate(() => ({
    sourceCount: document.querySelectorAll(".is-guidance-source").length,
    targetCount: document.querySelectorAll(".is-guidance-target").length,
    lineHidden: document.querySelector(".chess-board__guide-path line").hidden,
  }));
  await page.screenshot({ path: "output/playwright/chess-guidance-hint-390x844.png", fullPage: false });
  mediaRequests.push(...await page.evaluate(() => window.__chessMediaRequests));
  const pass = source.source && !source.target && source.lineHidden
    && path.source && path.target && !path.lineHidden && path.coordinates === "e2→e3"
    && playHint.sourceCount === 1 && playHint.targetCount === 1 && !playHint.lineHidden
    && tts.some(item => /e2.*e3/.test(item.text || ""))
    && mediaRequests.length === 0
    && errors.length === 0;
  return {
    status: pass ? "PASS" : "FAIL", source, path, playHint,
    spokenInstructions: tts.map(item => item.text), mediaRequests, errors,
    boundary: "Profile, history, health, TTS and avatar socket are mocked; no microphone permission is requested. No family data or physical media is used.",
  };
}
