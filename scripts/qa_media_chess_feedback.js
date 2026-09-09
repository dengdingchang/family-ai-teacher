async (page) => {
  const errors = [], blockedRequests = [], results = [];
  page.on("pageerror", error => errors.push(error.message));
  const staticFiles = ["/media-viewer.js", "/media-viewer.css", "/chess-board.js", "/chess-board.css", "/vendor/chess.js", "/avatar-companion.js", "/avatar-companion.css"];
  await page.route("**/*", route => {
    const requestUrl = route.request().url();
    const origin = requestUrl.match(/^https?:\/\/[^/]+/)?.[0];
    const path = requestUrl.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (origin === "http://127.0.0.1:8760" && staticFiles.includes(path)) return route.continue();
    if (origin === "http://127.0.0.1:8760" && path === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated feedback QA</title><link rel="stylesheet" href="/media-viewer.css"><link rel="stylesheet" href="/chess-board.css"><link rel="stylesheet" href="/avatar-companion.css"></head><body style="margin:0;font-family:system-ui"><button id="open-chess" style="min-height:48px">打开测试棋盘</button><section id="stage"><div class="dad-video"><div class="video-frame"><canvas id="avatarCanvas" width="220" height="165"></canvas></div></div></section><div id="cards"></div></body></html>` });
    if (origin === "https://upload.wikimedia.org" && path === "/qa-moon.svg") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#e6eee6"/><circle cx="400" cy="250" r="175" fill="#eed6a5"/><circle cx="330" cy="190" r="30" fill="#d4b988"/><circle cx="470" cy="310" r="48" fill="#d4b988"/></svg>' });
    blockedRequests.push(path); return route.abort();
  });
  await page.addInitScript(() => {
    navigator.mediaDevices ??= {};
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("No physical media in QA"); };
    globalThis.WebSocket = class { constructor() { throw new Error("No sockets in QA"); } };
  });
  page.setDefaultTimeout(7000);
  await page.goto("http://127.0.0.1:8760/", { timeout: 10000 });
  await page.evaluate(async () => {
    const [{ ChessBoard }, { MediaViewer }, { AvatarCompanion }] = await Promise.all([import("/chess-board.js"), import("/media-viewer.js"), import("/avatar-companion.js")]);
    globalThis.qaPicture = { kind: "image", title: "测试月亮", url: "https://zh.wikipedia.org/wiki/Moon", thumbnail_url: "https://upload.wikimedia.org/qa-moon.svg", source: "隔离 QA 示意图" };
    globalThis.qaSetup = () => {
      globalThis.qaCompanion?.destroy(); globalThis.qaBoard?.destroy(); globalThis.qaViewer?.destroy();
      globalThis.qaSpeech = [];
      globalThis.qaBoard = new ChessBoard({ onSpeak: text => { qaSpeech.push(text); return Promise.resolve({ ok: true }); } });
      globalThis.qaViewer = new MediaViewer({ container: document.querySelector("#cards") });
      globalThis.qaCompanion = new AvatarCompanion(document.querySelector("#stage"));
      const ctx = document.querySelector("#avatarCanvas").getContext("2d");
      ctx.fillStyle = "#dfd5c6"; ctx.fillRect(0, 0, 220, 165); ctx.fillStyle = "#205844"; ctx.font = "16px sans-serif"; ctx.fillText("隔离 QA 视频占位", 35, 90);
      document.querySelector("#open-chess").onclick = () => qaBoard.open();
    };
  });
  for (const [width, height] of [[1400, 900], [390, 844], [320, 700]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => qaSetup());
    await page.locator("#open-chess").click();
    await page.locator('.chess-board__square[data-square="e2"]').click();
    await page.locator('.chess-board__square[data-square="e3"]').click();
    const chess = await page.evaluate(() => {
      const r = qaBoard.grid.getBoundingClientRect();
      const square = qaBoard.cells.get("e3").cell, s = square.getBoundingClientRect();
      const visible = document.elementFromPoint(s.x + s.width / 2, s.y + s.height / 2);
      globalThis.qaSuccessCount = qaSpeech.length;
      return { speech: qaSpeech.at(-1), complete: qaBoard.lessonComplete, arrowHidden: getComputedStyle(qaBoard.guideLine).display === "none", marked: square.classList.contains("is-complete"), targetVisible: square.contains(visible), board: { y: r.y, width: r.width, bottom: r.bottom }, native: Boolean(document.fullscreenElement), hostCorrect: !document.fullscreenElement || document.fullscreenElement.contains(qaCompanion.panel), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    await page.locator('.chess-board__square[data-square="e3"]').click();
    chess.duplicateIgnored = await page.evaluate(() => qaSuccessCount === qaSpeech.length);
    await page.screenshot({ path: `output/playwright/chess-feedback-${width}x${height}-20260910.png` });
    const next = await page.evaluate(() => qaBoard.handleVoiceCommand("爸爸老师，下一课") && qaBoard.lessonIndex === 1 && !qaBoard.lessonComplete);
    await page.evaluate(() => qaViewer.openImage(qaPicture));
    await page.waitForFunction(() => qaViewer.timer?.loaded, null, { timeout: 7000 });
    await page.waitForFunction(() => qaViewer.imageCountdown.textContent.startsWith("3 "), null, { timeout: 3500 });
    await page.evaluate(() => { globalThis.qaOriginalImage = document.querySelector(".media-viewer__image"); });
    await page.locator(".media-viewer__replay").click();
    const image = await page.evaluate(() => {
      const hit = selector => {
        const node = document.querySelector(selector), r = node.getBoundingClientRect();
        return { visible: node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), x: r.x, y: r.y, width: r.width, height: r.height };
      };
      globalThis.qaReplayAt = performance.now();
      return { sameImage: qaOriginalImage === document.querySelector(".media-viewer__image"), countdown: qaViewer.imageCountdown.textContent, status: qaViewer.imageStatus.textContent, countBox: hit(".media-viewer__countdown"), replay: hit(".media-viewer__replay"), close: hit(".media-viewer__close"), companion: qaViewer.overlay.contains(qaCompanion.panel), nativeHost: !document.fullscreenElement || document.fullscreenElement.contains(qaViewer.overlay), overflow: qaViewer.panel.scrollWidth > innerWidth };
    });
    await page.screenshot({ path: `output/playwright/media-replay-${width}x${height}-20260910.png` });
    if (width === 1400) {
      await page.waitForFunction(() => !qaViewer.overlay, null, { timeout: 6000 });
      image.autoCloseMs = await page.evaluate(() => Math.round(performance.now() - qaReplayAt));
    } else await page.locator(".media-viewer__close").click();
    await page.locator(".chess-board__back").click();
    await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 });
    results.push({ size: `${width}x${height}`, chess, next, image });
  }
  await page.evaluate(() => { qaCompanion.destroy(); qaBoard.destroy(); qaViewer.destroy(); });
  const pass = results.every(({ chess, next, image }) => chess.complete && chess.arrowHidden && chess.marked && chess.targetVisible && chess.duplicateIgnored && chess.hostCorrect && !chess.overflow && /白兵向前走了一格/.test(chess.speech) && next && image.sameImage && image.countdown === "5 秒后收起" && /继续看这张图/.test(image.status) && image.countBox.visible && image.replay.visible && image.close.visible && image.companion && image.nativeHost && !image.overflow)
    && results[0].image.autoCloseMs >= 4700 && results[0].image.autoCloseMs < 6000 && errors.length === 0 && blockedRequests.length === 0;
  return { status: pass ? "PASS" : "FAIL", results, errors, blockedRequests, boundary: "Only existing static modules are read. Isolated HTML/image/video-placeholder fixtures; onSpeak payloads captured without TTS. No API, family data, model, socket or physical media." };
}
