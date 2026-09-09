async (page) => {
  const errors = [], blockedRequests = [], results = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const requestUrl = route.request().url();
    const url = { origin: requestUrl.match(/^https?:\/\/[^/]+/)?.[0], pathname: requestUrl.replace(/^https?:\/\/[^/]+/, "").split("?")[0] };
    if (url.origin === "http://127.0.0.1:8760" && ["/media-viewer.js", "/media-viewer.css"].includes(url.pathname)) return route.continue();
    if (url.origin === "http://127.0.0.1:8760" && url.pathname === "/") return route.fulfill({
      contentType: "text/html", body: '<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated picture QA</title><link rel="stylesheet" href="/media-viewer.css"></head><body style="margin:0;font-family:system-ui"><button id="open" style="min-height:48px">打开测试图片</button><button id="fullscreen" style="min-height:48px">全屏测试</button><section id="game"><div id="cards"></div></section></body></html>',
    });
    if (url.origin === "https://upload.wikimedia.org" && url.pathname === "/qa-moon.svg") return route.fulfill({
      contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#e6eee6"/><circle cx="400" cy="250" r="175" fill="#eed6a5"/><circle cx="330" cy="190" r="30" fill="#d4b988"/><circle cx="470" cy="310" r="48" fill="#d4b988"/></svg>',
    });
    blockedRequests.push(url.pathname); return route.abort();
  });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("Physical media forbidden in picture QA"); };
    globalThis.WebSocket = class { constructor() { throw new Error("Sockets forbidden in picture QA"); } };
  });
  page.setDefaultTimeout(7000);
  await page.goto("http://127.0.0.1:8760/", { timeout: 10000 });
  await page.evaluate(async () => {
    const { MediaViewer } = await import("/media-viewer.js");
    globalThis.qaPicture = { kind: "image", title: "测试月亮", url: "https://zh.wikipedia.org/wiki/Moon", thumbnail_url: "https://upload.wikimedia.org/qa-moon.svg", source: "仅用于隔离验证的示意图" };
    globalThis.qaEvents = [];
    globalThis.qaViewer = new MediaViewer({ container: document.querySelector("#cards"),
      onOpen: kind => qaEvents.push({ type: "open", kind, at: performance.now() }),
      onClose: kind => qaEvents.push({ type: "close", kind, at: performance.now() }),
    });
    document.querySelector("#open").onclick = event => qaViewer.openImage(qaPicture, event.currentTarget);
    document.querySelector("#fullscreen").onclick = async () => {
      try { await document.querySelector("#game").requestFullscreen(); } catch { /* CSS fullscreen is still available. */ }
      qaViewer.openImage(qaPicture, document.querySelector("#fullscreen"));
    };
  });
  for (const [width, height] of [[1400, 900], [390, 844], [320, 700]]) {
    await page.setViewportSize({ width, height });
    await page.locator("#open").click();
    await page.waitForFunction(() => qaViewer.timer?.loaded, null, { timeout: 7000 });
    const geometry = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { overlay: rect(".media-viewer"), image: rect(".media-viewer__image"), close: rect(".media-viewer__close"), replay: rect(".media-viewer__replay"), hint: document.querySelector(".media-viewer__hint").textContent,
        focus: document.activeElement.className, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    await page.screenshot({ path: `output/playwright/media-fullscreen-${width}x${height}-20260910.png` });
    if (width === 1400) {
      const started = await page.evaluate(() => performance.now());
      await page.mouse.move(700, 450);
      await page.waitForFunction(() => !document.querySelector(".media-viewer"), null, { timeout: 6500 });
      const closed = await page.evaluate(() => ({ at: performance.now(), focus: document.activeElement.id }));
      results.push({ size: `${width}x${height}`, geometry, autoCloseMs: Math.round(closed.at - started), restoredFocus: closed.focus });
    } else {
      await page.keyboard.press("Shift+Tab");
      const trapped = await page.evaluate(() => document.activeElement.className.includes("media-viewer__replay"));
      await page.keyboard.press("Escape");
      results.push({ size: `${width}x${height}`, geometry, trapped, restoredFocus: await page.evaluate(() => document.activeElement.id) });
    }
  }
  const reopened = await page.evaluate(() => qaViewer.handleVoiceCommand("爸爸老师，再看一次"));
  await page.waitForFunction(() => qaViewer.timer?.loaded, null, { timeout: 7000 });
  const voiceClosed = await page.evaluate(() => qaViewer.handleVoiceCommand("把图片关掉"));
  await page.locator("#fullscreen").click();
  await page.waitForFunction(() => qaViewer.timer?.loaded, null, { timeout: 7000 });
  const fullscreen = await page.evaluate(() => ({ native: Boolean(document.fullscreenElement), hostCorrect: !document.fullscreenElement || qaViewer.overlay.parentElement === document.fullscreenElement }));
  await page.locator(".media-viewer__close").click();
  await page.evaluate(async () => { qaViewer.destroy(); if (document.fullscreenElement) await document.exitFullscreen(); });
  const pass = results.every(item => item.geometry.overlay.width === Number(item.size.split("x")[0])
    && item.geometry.overlay.height === Number(item.size.split("x")[1])
    && item.geometry.image.width >= item.geometry.overlay.width - 40 && item.geometry.image.height > item.geometry.overlay.height * .65
    && item.geometry.close.width >= 48 && item.geometry.close.height >= 48
    && item.geometry.replay.width >= 48 && item.geometry.replay.height >= 48
    && item.geometry.hint.includes("5秒") && !item.geometry.overflow && item.restoredFocus === "open")
    && results[0].autoCloseMs >= 4200 && results[0].autoCloseMs <= 6000
    && results.slice(1).every(item => item.trapped) && reopened && voiceClosed && fullscreen.hostCorrect
    && blockedRequests.length === 0 && errors.length === 0;
  return { status: pass ? "PASS" : "FAIL", results, reopened, voiceClosed, fullscreen, blockedRequests, errors,
    boundary: "Only real media-viewer static JS/CSS is loaded. All HTML and images are isolated fixtures; no app API, family data, physical media, model service or socket is used." };
}
