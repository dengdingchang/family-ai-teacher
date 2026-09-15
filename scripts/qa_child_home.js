async (page) => {
  const errors = [], results = [], mediaRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/ws/avatar", socket => socket.close());
  await page.addInitScript(() => {
    navigator.mediaDevices ??= {};
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__childHomeMediaRequests.push(constraints);
      throw new Error("Physical media is forbidden in child-home QA");
    };
    window.__childHomeMediaRequests = [];
  });
  await page.route("**/api/**", route => {
    const pathname = route.request().url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (pathname === "/api/avatar") return route.continue();
    const payload = pathname === "/api/profile"
      ? { name: "布局测试", enabled_activities: ["drawing", "story", "game", "music", "vision_photo", "vision_video"] }
      : pathname === "/api/memory/history" ? { history: [] } : { ok: true };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.route("**/health", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    tts_ready: true, stt_ready: true, tts_warmup: "ready", llm_configured: true,
  }) }));

  for (const size of [{ width: 1400, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
    await page.setViewportSize(size);
    await page.goto("http://127.0.0.1:8760/");
    await page.waitForFunction(() => document.querySelector("#serviceBadge")?.textContent === "准备好了");
    const before = await page.evaluate(() => {
      const box = selector => { const value = document.querySelector(selector).getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
      return {
        primary: box(".dad-video .video-frame"), secondary: box(".child-video .video-frame"),
        conversationStart: box(".chat-shell").y,
        conversationVisible: Math.max(0, Math.min(box(".chat-shell").height, innerHeight - box(".chat-shell").y)),
        feedCount: document.querySelectorAll("#chatHistory #liveTurn").length,
        overflow: document.documentElement.scrollWidth > innerWidth,
        controls: [...document.querySelectorAll(".camera-tool,.record-button,.activity-row > button")].map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
      };
    });
    await page.locator(".child-video .video-frame").click();
    const swapped = await page.evaluate(() => document.querySelector(".stage-card").dataset.callPrimary === "child");
    await page.locator(".dad-video .video-frame").click();
    const restored = await page.evaluate(() => document.querySelector(".stage-card").dataset.callPrimary === "dad");
    await page.locator("#playButton").click();
    const choices = await page.evaluate(() => ({
      expanded: document.querySelector("#playButton").getAttribute("aria-expanded"),
      visible: !document.querySelector("#playChoices").hidden,
      count: document.querySelectorAll("#playChoices button").length,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    const shot = `output/playwright/child-home-${size.width}x${size.height}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    results.push({ ...size, before, swapped, restored, choices, shot });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:8760/");
  await page.locator("#playButton").click();
  await page.locator("#playChoices button", { hasText: "钢琴" }).click();
  const musicEntry = await page.evaluate(() => ({
    visible: !document.querySelector(".music-studio")?.hidden,
    mode: document.querySelector(".music-studio__modes [aria-pressed=true]")?.textContent,
    keyCount: document.querySelectorAll(".music-studio__key").length,
    mediaRequests: window.__childHomeMediaRequests,
  }));
  await page.screenshot({ path: "output/playwright/music-studio-390x844.png", fullPage: false });
  await page.goto("about:blank");
  const pass = results.every(result => result.before.primary.width > result.before.secondary.width
    && result.before.feedCount === 1 && !result.before.overflow && result.before.conversationStart > result.before.primary.y
    && result.before.controls.every(control => control.width >= 47.5 && control.height >= 47.5)
    && result.swapped && result.restored && result.choices.expanded === "true" && result.choices.visible
    && result.choices.count === 4 && !result.choices.overflow)
    && musicEntry.visible && musicEntry.mode?.includes("弹钢琴") && musicEntry.keyCount === 5
    && musicEntry.mediaRequests.length === 0 && errors.length === 0;
  return {
    status: pass ? "PASS" : "FAIL", results, musicEntry, errors,
    boundary: "Dedicated local page with mocked profile/history/health, blocked avatar socket, and denied synthetic media requests; no real microphone, camera, or family data is used.",
  };
}
