async (page) => {
  const errors = [], mediaRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/ws/avatar", socket => socket.close());
  await page.addInitScript(() => {
    navigator.mediaDevices ??= {};
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("Physical media is forbidden in media-card QA"); };
  });
  await page.route("https://upload.wikimedia.org/**", route => route.fulfill({
    status: 200, contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="100%" height="100%" fill="#d9e7ef"/><circle cx="400" cy="250" r="150" fill="#f7f0c8"/><circle cx="340" cy="210" r="25" fill="#d6cea9"/><circle cx="460" cy="290" r="38" fill="#d6cea9"/></svg>',
  }));
  await page.route("https://i.ytimg.com/**", route => route.fulfill({
    status: 200, contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="100%" height="100%" fill="#cfe5d7"/><path d="M330 120 560 225 330 330Z" fill="#245f4c"/></svg>',
  }));
  await page.route("https://www.youtube-nocookie.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>video fixture</title>" }));
  await page.route("**/health", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    tts_ready: true, stt_ready: true, tts_warmup: "ready", llm_configured: true,
  }) }));
  await page.route("**/api/**", route => {
    const request = route.request();
    const pathname = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (pathname === "/api/avatar") return route.continue();
    if (pathname === "/api/profile") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "媒体测试", enabled_activities: ["story"] }) });
    if (pathname === "/api/memory/history") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ history: [] }) });
    if (pathname === "/api/conversation/text/stream") {
      const events = [
        { event: "user_text", text: "我想看看月亮" },
        { event: "assistant_delta", text: "我们一起看看月亮。" },
        { event: "done", assistant_text: "我们一起看看月亮。", commit_required: false,
          history: { user_text: "我想看看月亮", assistant_text: "我们一起看看月亮。", created_at: "2026-09-09T08:00:00+08:00" } },
      ];
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
    }
    if (pathname === "/api/media/suggestions") {
      mediaRequests.push({ url: request.url(), body: request.postDataJSON() });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ topic: "月亮", cards: [
        { kind: "image", title: "月亮", description: "一起观察月面", url: "https://zh.wikipedia.org/wiki/%E6%9C%88%E7%90%83", thumbnail_url: "https://upload.wikimedia.org/moon.svg", source: "Wikipedia / Wikimedia Commons" },
        { kind: "video", title: "月亮小视频", description: "点一下再播放", url: "https://www.youtube.com/watch?v=AcYCMJvdupI", thumbnail_url: "https://i.ytimg.com/vi/AcYCMJvdupI/hqdefault.jpg", source: "儿童视频" },
        { kind: "link", title: "月亮资料", description: "给大人打开", url: "https://zh.wikipedia.org/wiki/%E6%9C%88%E7%90%83", thumbnail_url: "", source: "Wikipedia" },
      ] }) });
    }
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:8760/");
  await page.locator(".grownup-help").evaluate(element => { element.open = true; });
  await page.locator("#textInput").fill("我想看看月亮");
  await page.locator("#textForm button").click();
  await page.locator("#chatHistory .media-card").first().waitFor();
  const integrated = await page.evaluate(() => ({
    cards: document.querySelectorAll("#chatHistory .media-card").length,
    feeds: document.querySelectorAll("#chatHistory").length,
    iframesBeforeClick: document.querySelectorAll(".media-viewer iframe").length,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  await page.locator(".media-card--image .media-card__media-button").click();
  await page.locator(".media-viewer__image").waitFor();
  await page.screenshot({ path: "output/playwright/media-image-overlay-390x844.png", fullPage: false });
  await page.getByRole("button", { name: "关闭查看器" }).click();
  await page.locator(".media-card--video .media-card__media-button").click();
  const video = await page.evaluate(() => ({
    iframeCount: document.querySelectorAll(".media-viewer iframe").length,
    src: document.querySelector(".media-viewer iframe")?.src || "",
  }));
  await page.screenshot({ path: "output/playwright/media-video-overlay-390x844.png", fullPage: false });
  const pass = integrated.cards === 3 && integrated.feeds === 1 && integrated.iframesBeforeClick === 0
    && !integrated.overflow && video.iframeCount === 1 && /youtube-nocookie\.com\/embed\//.test(video.src)
    && mediaRequests.length === 1 && mediaRequests[0].body.topic === "月亮"
    && !mediaRequests[0].url.includes("月亮") && errors.length === 0;
  return {
    status: pass ? "PASS" : "FAIL", integrated, video, mediaRequests, errors,
    boundary: "Conversation, profile, history, media results, remote images, video embed and avatar socket are mocked. The request body is inspected to prove only the canonical topic leaves the child page; no real family data or physical media is used.",
  };
}
