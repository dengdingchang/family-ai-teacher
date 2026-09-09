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
      const question = String(request.postDataJSON()?.text || "");
      const topic = question.includes("火山") ? "火山" : "蝴蝶";
      const events = [
        { event: "user_text", text: `我想看看${topic}` },
        { event: "assistant_delta", text: `我们一起看看${topic}。` },
        { event: "done", assistant_text: `我们一起看看${topic}。`, commit_required: false,
          history: { user_text: `我想看看${topic}`, assistant_text: `我们一起看看${topic}。`, created_at: "2026-09-09T08:00:00+08:00" } },
      ];
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
    }
    if (pathname === "/api/media/suggestions") {
      mediaRequests.push({ url: request.url(), body: request.postDataJSON() });
      if (request.postDataJSON()?.topic === "火山") {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({
          topic: "火山", cards: [], online_search: true, reason: "no_suitable_result",
        }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ topic: "蝴蝶", cards: [
        { kind: "image", title: "蝴蝶", description: "一起观察翅膀", url: "https://zh.wikipedia.org/wiki/%E8%9D%B4%E8%9D%B6", thumbnail_url: "https://upload.wikimedia.org/butterfly.svg", source: "Wikipedia / Wikimedia Commons" },
        { kind: "video", title: "蝴蝶小视频", description: "点一下再播放", url: "https://www.youtube.com/watch?v=AcYCMJvdupI", thumbnail_url: "https://i.ytimg.com/vi/AcYCMJvdupI/hqdefault.jpg", source: "儿童视频" },
        { kind: "link", title: "蝴蝶资料", description: "给大人打开", url: "https://zh.wikipedia.org/wiki/%E8%9D%B4%E8%9D%B6", thumbnail_url: "", source: "Wikipedia" },
      ] }) });
    }
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:8760/");
  await page.locator(".grownup-help").evaluate(element => { element.open = true; });
  await page.locator("#textInput").fill("我想看看蝴蝶");
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
  await page.getByRole("button", { name: "关闭查看器" }).click();
  await page.locator("#textInput").fill("我想看看火山");
  await page.locator("#textForm button").click();
  await page.locator(".media-history-heading", { hasText: "没有找到合适的火山图片" }).waitFor();
  const noResult = await page.evaluate(() => {
    const turn = [...document.querySelectorAll(".media-history-turn")].at(-1);
    return { message: turn?.querySelector(".media-history-heading")?.textContent || "", cards: turn?.querySelectorAll(".media-card").length || 0 };
  });
  const pass = integrated.cards === 3 && integrated.feeds === 1 && integrated.iframesBeforeClick === 0
    && !integrated.overflow && video.iframeCount === 1 && /youtube-nocookie\.com\/embed\//.test(video.src)
    && mediaRequests.length === 2 && mediaRequests[0].body.topic === "蝴蝶" && mediaRequests[1].body.topic === "火山"
    && !mediaRequests.some(item => item.url.includes("蝴蝶") || item.url.includes("火山"))
    && noResult.cards === 0 && noResult.message.includes("没有找到合适的火山图片") && errors.length === 0;
  return {
    status: pass ? "PASS" : "FAIL", integrated, video, noResult, mediaRequests, errors,
    boundary: "Conversation, profile, history, media results, remote images, video embed and avatar socket are mocked. The request body is inspected to prove only the canonical topic leaves the child page; no real family data or physical media is used.",
  };
}
