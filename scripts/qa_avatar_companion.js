async (page) => {
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
    if (url === "https://upload.wikimedia.org/companion-qa.svg") return route.fulfill({ contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="650"><rect width="900" height="650" fill="#dfeade"/><circle cx="450" cy="325" r="220" fill="#dfbd71"/></svg>' });
    if (!url.startsWith("http://127.0.0.1:8760/")) { externalRequests.push(url); return route.abort(); }
    if (pathname === "/health") return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      tts_ready: true, stt_ready: true, tts_warmup: "ready", llm_configured: true, avatar_idle_ready: true,
    }) });
    if (pathname.startsWith("/api/")) {
      if (["/api/avatar", "/api/avatar/idle"].includes(pathname) && request.method() === "GET") return route.continue();
      apiRequests.push({ pathname, method: request.method() });
      const payload = pathname === "/api/profile" ? { name: "界面测试", enabled_activities: ["drawing", "story", "game", "music"] }
        : pathname === "/api/memory/history" ? { history: [
          { user_text: "我们看月亮吧", assistant_text: "月亮有时圆，有时像弯弯的小船。", created_at: "2026-09-10T08:00:00+08:00" },
          { user_text: "我想听三个音", assistant_text: "我们一起试试，先听再按。", created_at: "2026-09-10T08:01:00+08:00" },
        ] } : { ok: true };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    }
    if (request.method() !== "GET") { externalRequests.push(`${request.method()} ${pathname}`); return route.abort(); }
    return route.continue();
  });
  for (const size of [{ width: 1400, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
    await page.setViewportSize(size);
    await page.goto("http://127.0.0.1:8760/", { timeout: 12000 });
    await page.waitForFunction(() => document.querySelector("#serviceBadge")?.textContent === "准备好了"
      && document.querySelectorAll("#chatHistory .history-turn").length === 2, null, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector("#avatarIdle")?.readyState >= 2, null, { timeout: 7000 });
    await page.evaluate(() => {
      globalThis.__qaNodes = { canvas: document.querySelector("#avatarCanvas"), idle: document.querySelector("#avatarIdle"), image: document.querySelector("#avatarImage"), frame: document.querySelector(".dad-video .video-frame") };
      globalThis.__qaBox = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      globalThis.__qaCompanionState = () => {
        const panel = document.querySelector(".avatar-companion"), visible = panel && !panel.hidden;
        const host = visible ? panel.parentElement : null;
        return { visible, host: host?.className || "", sameCanvas: document.querySelector("#avatarCanvas") === __qaNodes.canvas,
          sameIdle: document.querySelector("#avatarIdle") === __qaNodes.idle, sameImage: document.querySelector("#avatarImage") === __qaNodes.image,
          canvasCount: document.querySelectorAll("#avatarCanvas").length, idleCount: document.querySelectorAll("#avatarIdle").length,
          socketCount: __qaSocketCount, home: __qaNodes.frame.parentElement?.classList.contains("dad-video") || false,
          idlePaused: __qaNodes.idle.paused, idleReady: __qaNodes.idle.readyState,
          rect: visible ? __qaBox(panel) : null,
          native: Boolean(document.fullscreenElement), nativeContains: !document.fullscreenElement || document.fullscreenElement.contains(panel),
          viewportOverflow: document.documentElement.scrollWidth > innerWidth,
          tools: visible ? [...panel.querySelectorAll("button")].map(node => ({ label: node.getAttribute("aria-label"), ...__qaBox(node) })) : [],
        };
      };
    });
    const home = await page.evaluate(() => {
      const frame = __qaBox(__qaNodes.frame), feed = document.querySelector("#chatHistory"), turns = [...feed.querySelectorAll(".history-turn")];
      return { frame, idle: __qaCompanionState(), bubbles: turns.map(turn => [...turn.querySelectorAll(".chat-message")].map(__qaBox)),
        feedWidth: __qaBox(feed).width, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    await page.screenshot({ path: `output/playwright/companion-home-${size.width}x${size.height}-20260910-run2.png` });
    const activities = [];
    for (const activity of ["music", "chess", "drawing"]) {
      if (activity !== "drawing") {
        if (await page.locator("#playChoices").isHidden()) await page.locator("#playButton").click();
        await page.locator(activity === "music" ? '[data-music-mode="piano"]' : '[data-chess="true"]').click();
      } else await page.locator('[data-activity="drawing"]').click();
      const host = activity === "music" ? ".music-studio" : activity === "chess" ? ".chess-board" : ".drawing-board";
      await page.waitForFunction(selector => { const panel = document.querySelector(`${selector} > .avatar-companion`); return panel && !panel.hidden; }, host, { timeout: 8000 });
      const initial = await page.evaluate(({ host, activity }) => {
        const back = document.querySelector(`${host}__back`), backRect = back.getBoundingClientRect();
        const backTop = document.elementFromPoint(backRect.x + backRect.width / 2, backRect.y + backRect.height / 2);
        const area = document.querySelector(activity === "music" ? ".music-studio__keys" : activity === "chess" ? ".chess-board__grid" : ".drawing-board canvas");
        const areaRect = area.getBoundingClientRect(), areaTop = document.elementFromPoint(areaRect.x + areaRect.width / 2, areaRect.y + areaRect.height / 2);
        return { ...__qaCompanionState(), backClickable: back.contains(backTop), playArea: __qaBox(area), playAreaUncovered: area.contains(areaTop) };
      }, { host, activity });
      await page.screenshot({ path: `output/playwright/companion-${activity}-${size.width}x${size.height}-20260910-run2.png` });
      let controls = null, media = null;
      if (activity === "music") {
        const handle = await page.locator(".avatar-companion__move").boundingBox();
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down(); await page.mouse.move(handle.x - 90, handle.y + 75, { steps: 5 }); await page.mouse.up();
        const dragged = await page.evaluate(() => __qaCompanionState());
        await page.locator(".avatar-companion__move").focus(); await page.keyboard.press("ArrowRight");
        const keyboard = await page.evaluate(() => __qaCompanionState());
        await page.getByRole("button", { name: "放大爸爸画面", exact: true }).click();
        const enlarged = await page.evaluate(() => __qaCompanionState());
        for (let i = 0; i < 6; i++) await page.getByRole("button", { name: "缩小爸爸画面", exact: true }).click();
        const smallest = await page.evaluate(() => __qaCompanionState());
        const resize = await page.getByRole("button", { name: "拖动调整爸爸画面大小", exact: true }).boundingBox();
        await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
        await page.mouse.down(); await page.mouse.move(size.width + 500, size.height + 500, { steps: 6 }); await page.mouse.up();
        const clamped = await page.evaluate(() => __qaCompanionState());
        controls = { dragged, keyboard, enlarged, smallest, clamped };
        // Restore the user's original size and position with actual pointer input,
        // so later screenshots assess each activity's default placement.
        const resetSize = await page.getByRole("button", { name: "拖动调整爸爸画面大小", exact: true }).boundingBox();
        await page.mouse.move(resetSize.x + resetSize.width / 2, resetSize.y + resetSize.height / 2);
        await page.mouse.down(); await page.mouse.move(resetSize.x + resetSize.width / 2 + initial.rect.width - clamped.rect.width, resetSize.y + resetSize.height / 2, { steps: 5 }); await page.mouse.up();
        const resetHandle = await page.locator(".avatar-companion__move").boundingBox();
        const resetState = await page.evaluate(() => __qaCompanionState());
        await page.mouse.move(resetHandle.x + resetHandle.width / 2, resetHandle.y + resetHandle.height / 2);
        await page.mouse.down(); await page.mouse.move(resetHandle.x + resetHandle.width / 2 + initial.rect.x - resetState.rect.x, resetHandle.y + resetHandle.height / 2 + initial.rect.y - resetState.rect.y, { steps: 5 }); await page.mouse.up();
        // Use the same public viewer module with a fixture image inside the real game.
        await page.evaluate(async () => {
          const { MediaViewer } = await import("/media-viewer.js");
          globalThis.__qaViewer = new MediaViewer({ container: document.createElement("div") });
          __qaViewer.openImage({ kind: "image", title: "隔离图片测试", url: "https://zh.wikipedia.org/wiki/Moon", thumbnail_url: "https://upload.wikimedia.org/companion-qa.svg", source: "隔离示意图" });
        });
        await page.waitForFunction(() => __qaViewer.timer?.loaded && document.querySelector(".media-viewer > .avatar-companion"), null, { timeout: 7000 });
        media = await page.evaluate(() => {
          const overlay = document.querySelector(".media-viewer"), image = document.querySelector(".media-viewer__image"), box = image.getBoundingClientRect();
          const node = document.elementFromPoint(Math.min(32, innerWidth / 2), Math.min(box.y + 80, innerHeight / 2));
          const close = document.querySelector(".media-viewer__close"), closeRect = close.getBoundingClientRect();
          return { ...__qaCompanionState(), mediaCloseClickable: close.contains(document.elementFromPoint(closeRect.x + closeRect.width / 2, closeRect.y + closeRect.height / 2)),
            mediaIsTopAtImage: overlay.contains(node), mediaZ: Number(getComputedStyle(overlay).zIndex), gameZ: Number(getComputedStyle(document.querySelector(".music-studio")).zIndex) };
        });
        await page.screenshot({ path: `output/playwright/companion-media-${size.width}x${size.height}-20260910-run2.png` });
        await page.locator(".media-viewer__close").click();
        await page.evaluate(() => __qaViewer.destroy());
        await page.waitForFunction(() => document.querySelector(".music-studio > .avatar-companion"), null, { timeout: 5000 });
      }
      await page.locator(`${host}__back`).click();
      await page.waitForFunction(() => __qaNodes.frame.parentElement?.classList.contains("dad-video") && !document.fullscreenElement, null, { timeout: 7000 });
      const restored = await page.evaluate(() => __qaCompanionState());
      activities.push({ activity, initial, controls, media, restored });
    }
    results.push({ size, home, activities, deniedMediaRequests: await page.evaluate(() => __qaDeniedMedia.length) });
  }
  await page.goto("about:blank");
  const nodeOkay = state => state.sameCanvas && state.sameIdle && state.sameImage && state.canvasCount === 1 && state.idleCount === 1 && state.socketCount <= 1;
  const within = (state, size) => state.rect.x >= 0 && state.rect.y >= 0 && state.rect.right <= size.width && state.rect.bottom <= size.height;
  const pass = results.every(result => result.home.frame.height >= (result.size.width > 640 ? 380 : 279)
    && !result.home.overflow && result.home.bubbles.every(pair => pair.length === 2 && pair[1].y >= pair[0].bottom && pair[0].width > result.home.feedWidth * .8)
    && result.activities.every(item => nodeOkay(item.initial) && item.initial.visible && within(item.initial, result.size) && item.initial.nativeContains
      && item.initial.backClickable && item.initial.playAreaUncovered && item.initial.playArea.bottom <= result.size.height
      && item.initial.playArea.height >= (item.activity === "chess" ? 280 : 160)
      && nodeOkay(item.restored) && item.restored.home && !item.restored.visible && !item.restored.idlePaused
      && (!item.controls || (item.controls.dragged.rect.x !== item.initial.rect.x && item.controls.keyboard.rect.x > item.controls.dragged.rect.x
        && item.controls.enlarged.rect.width > item.controls.keyboard.rect.width && within(item.controls.clamped, result.size)
        && item.controls.smallest.tools.every(button => button.width >= 48 && button.right <= item.controls.smallest.rect.right)))
      && (!item.media || (nodeOkay(item.media) && item.media.mediaIsTopAtImage && item.media.mediaCloseClickable && item.media.mediaZ > item.media.gameZ))))
    && errors.length === 0 && externalRequests.length === 0;
  return { status: pass ? "PASS" : "FAIL", results, errors, externalRequests, apiRequests,
    boundary: "Real production HTML/modules and approved avatar image/idle video only. Every other API, health, history and image is intercepted; media requests are denied; socket is an inert fixture. No model, live voice SSE, family write or physical device is exercised." };
}
