async (page) => {
  // Run with playwright-cli run-code --filename; routes serve only this checkout's static files.
  const root = "C:/Users/user/.codex/worktrees/13e8/family-ai-teacher";
  const context = await page.context().browser().newContext({ hasTouch: true });
  page = await context.newPage();
  const errors = [], blocked = [], results = [];
  page.on("pageerror", error => errors.push(error.message));
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  try {
    await page.route("**/*", route => {
      const path = route.request().url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      if (path === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chess-board.css"><link rel="stylesheet" href="/avatar-companion.css"><body style="margin:0"><button id="open">打开棋盘</button><section id="stage"><div class="dad-video"><div class="video-frame"><canvas id="avatarCanvas"></canvas></div></div></section>` });
      if (["/chess-board.js", "/chess-board.css", "/vendor/chess.js", "/avatar-companion.js", "/avatar-companion.css"].includes(path)) return route.fulfill({ path: `${root}/frontend${path}` });
      blocked.push(path); return route.abort();
    });
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new Error("No physical media in QA"); };
      globalThis.WebSocket = class { constructor() { throw new Error("No sockets in QA"); } };
    });
    await page.goto("http://127.0.0.1:8760/");
    await page.evaluate(async () => {
      const { ChessBoard } = await import("/chess-board.js");
      const { AvatarCompanion } = await import("/avatar-companion.js");
      globalThis.qaSetup = () => {
        globalThis.board?.destroy(); globalThis.companion?.destroy(); globalThis.speech = [];
        globalThis.board = new ChessBoard({ nativeFullscreen: false, onSpeak: text => { speech.push(text); return Promise.resolve({ ok: true }); } });
        globalThis.companion = new AvatarCompanion(document.querySelector("#stage"));
        const canvas = document.querySelector("canvas"), ctx = canvas.getContext("2d");
        ctx.fillStyle = "#dfd5c6"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#205844"; ctx.font = "20px sans-serif"; ctx.fillText("QA 爸爸画面占位", 30, 80);
        document.querySelector("#open").onclick = () => board.open();
      };
    });
    const move = async (from, to, touch = false) => {
      for (const square of [from, to]) await page.locator(`[data-square="${square}"]`)[touch ? "tap" : "click"]();
    };
    for (const [width, height] of [[1400, 900], [390, 844], [320, 700]]) {
      await page.setViewportSize({ width, height }); await page.evaluate(() => qaSetup());
      await page.locator("#open").click(); await move("e2", "e3", width < 500);
      check(await page.evaluate(() => !board.celebration.hidden && board.confettiAnimations.length === 20), "completion burst missing");
      // A pointer double-click and voice arriving together must consume only this completed lesson.
      await page.locator(".chess-board__continue").dblclick();
      await page.evaluate(() => board.handleVoiceCommand("下一课"));
      check(await page.evaluate(() => board.lessonIndex === 1 && !board.lessonComplete && !board.confetti), "duplicate skipped a lesson");
      await move("d4", "d7", width < 500);
      await page.evaluate(() => {
        globalThis.burst = board.confetti; globalThis.count = speech.length;
        board.selectSquare("d7"); board._render();
        // Deliberately place Dad directly under the modal's main action.
        const r = board.continueButton.getBoundingClientRect();
        companion.position = { left: r.x, top: r.y - 40 }; companion.place();
      });
      const layout = await page.evaluate(() => {
        const r = board.continueButton.getBoundingClientRect();
        return { accessible: board.continueButton.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
          inViewport: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight,
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
          duplicateIgnored: burst === board.confetti && count === speech.length,
          label: board.continueButton.textContent, color: getComputedStyle(board.continueButton).backgroundColor };
      });
      check(layout.accessible && layout.inViewport && layout.noOverflow && layout.duplicateIgnored, "layout or repeat failure");
      await page.screenshot({ path: `${root}/output/playwright/chess-celebration-${width}x${height}.png` });
      await page.waitForFunction(() => !board.confetti && board.confettiAnimations.length === 0);
      await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
      check(await page.evaluate(() => document.activeElement === board.continueButton), "focus escaped modal");
      await page.evaluate(() => board.handleVoiceCommand("爸爸老师，下一课"));
      check(await page.evaluate(() => board.lessonIndex === 2 && board.celebration.hidden), "voice next failed");
      await move("d4", "f5", width < 500);
      check(await page.locator(".chess-board__continue").textContent() === "再学一遍 ↻", "last lesson unclear");
      await page.locator(".chess-board__continue").tap();
      check(await page.evaluate(() => board.lessonIndex === 0 && !board.lessonComplete && !board.confetti), "restart failed");
      results.push({ size: `${width}x${height}`, ...layout, touch: width < 500, cleanup: true, voice: true, finalLesson: true });
      await page.evaluate(() => board.close());
    }
    await page.emulateMedia({ reducedMotion: "reduce" }); await page.evaluate(() => qaSetup());
    await page.locator("#open").click(); await move("e2", "e3");
    check(await page.evaluate(() => !board.confetti && !board.celebration.hidden), "reduced motion failure");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => { board.reset(); board.selectSquare("e2"); board.selectSquare("e3"); board.close(); });
    check(await page.evaluate(() => !board.confetti && !board.confettiAnimations.length), "close cleanup failed");
    await page.evaluate(() => board.open());
    check(await page.evaluate(() => !board.celebration.hidden && !board.confetti), "reopen repeated celebration");
    await page.evaluate(() => { board.destroy(); companion.destroy(); });
    check(await page.evaluate(() => document.getAnimations().length === 0), "animations leaked");
    check(!errors.length && !blocked.length, "page or unexpected request error");
    return { status: "PASS", results, reducedMotion: true, closeReopenDestroy: true, errors, blocked, boundary: "Static checkout modules only; synthetic onSpeak and avatar; no server, API, family data, models or physical devices used." };
  } finally { await context.close(); }
}

