async (page) => {
  const errors = [], blocked = [], requests = [], layouts = [], parentLayouts = [];
  let tests = 0, saves = 0, saved = { provider: "compatible", base_url: "https://qa.example/v1", model: "qa-original", timeout_seconds: 15, search_provider: "codex", api_key_configured: true, revision: "qa-1" };
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(7500);
  await page.addInitScript(() => {
    globalThis.qaPhysicalRequests = 0;
    navigator.mediaDevices ??= {};
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("QA prohibits physical microphones", "NotAllowedError"); };
    globalThis.WebSocket = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
      constructor() { super(); this.readyState = 3; }
      send() {} close() { this.readyState = 3; }
    };
  });
  const wav = await page.evaluate(() => {
    const data = new Uint8Array(1644), view = new DataView(data.buffer);
    const word = (at, text) => [...text].forEach((c, i) => { data[at + i] = c.charCodeAt(0); });
    word(0, "RIFF"); view.setUint32(4, 1636, true); word(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, "data"); view.setUint32(40, 1600, true);
    return btoa(String.fromCharCode(...data));
  });
  const picture = { topic: "蝴蝶", kind: "image", title: "蝴蝶", source: "隔离 QA 示意图", url: "https://zh.wikipedia.org/wiki/Butterfly", thumbnail_url: "https://upload.wikimedia.org/learning-qa.svg" };
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="#f7f4e9"/><ellipse cx="380" cy="300" rx="190" ry="220" fill="#c48532"/><ellipse cx="620" cy="300" rx="190" ry="220" fill="#d9b068"/><path d="M500 180V580" stroke="#184936" stroke-width="20"/></svg>';
  const history = Array.from({ length: 12 }, (_, i) => ({ user_text: `测试问题 ${i + 1}`, assistant_text: `测试回答 ${i + 1}`, created_at: `2026-09-10T08:${String(i).padStart(2, "0")}:00+08:00` }));
  await page.route("**/*", route => {
    const request = route.request(), url = request.url(), path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (url === picture.thumbnail_url) return route.fulfill({ contentType: "image/svg+xml", body: image });
    if (!url.startsWith("http://127.0.0.1:8760/")) { blocked.push(url); return route.abort(); }
    if (path === "/health") return route.fulfill({ json: { tts_ready: true, stt_ready: true, tts_warmup: "ready", llm_configured: true, avatar_idle_ready: false } });
    if (path.startsWith("/api/")) {
      const item = { path, method: request.method() }; requests.push(item);
      if (path === "/api/avatar") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="560"><rect width="420" height="560" fill="#dfd5c6"/><text x="60" y="280" fill="#205844" font-size="28">隔离 QA 画面</text></svg>' });
      if (path === "/api/profile") return route.fulfill({ json: { name: "界面测试", enabled_activities: ["drawing", "story", "game", "music"] } });
      if (path === "/api/memory/history") return route.fulfill({ json: { history } });
      if (path === "/api/media/suggestions") {
        // A matching envelope with a wrong card topic must still be rejected.
        const topic = request.postDataJSON().topic;
        return route.fulfill({ json: { topic, cards: [picture] } });
      }
      if (path === "/api/tts") { item.text = request.postDataJSON().text; return route.fulfill({ json: { audio_base64: wav, content_type: "audio/wav" } }); }
      if (path.endsWith("/stream")) {
        const text = request.postDataJSON()?.text || "";
        const events = [{ event: "user_text", text }, { event: "assistant_delta", text: "这是应被界面口令取消的旧活动回复" }, { event: "done", assistant_text: "这是应被界面口令取消的旧活动回复", ok: true }];
        return route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
      }
      if (path === "/api/parent/dashboard") return route.fulfill({ json: { profile: { name: "界面测试", age: 4 }, today: {}, skill_graph: { skills: [] }, growth_journal: [], brain: {} } });
      if (path === "/api/memories") return route.fulfill({ json: { memories: [] } });
      if (path === "/api/parent/messages") return route.fulfill({ json: { messages: [] } });
      if (path === "/api/parent/models/test") {
        tests++;
        return tests === 1 ? route.fulfill({ status: 503, json: { detail: "隔离测试连接失败，未保存" } }) : route.fulfill({ json: { ok: true, model: request.postDataJSON().model, latency_s: .1 } });
      }
      if (path === "/api/parent/models") {
        if (request.method() === "POST") {
          saves++; const value = request.postDataJSON();
          saved = { provider: value.provider, base_url: value.base_url, model: value.model, timeout_seconds: value.timeout_seconds, search_provider: value.search_provider, image_provider: value.image_provider, api_key_configured: true, revision: `qa-${saves + 1}` };
        }
        return route.fulfill({ json: saved });
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() !== "GET") { blocked.push(`${request.method()} ${path}`); return route.abort(); }
    return route.continue();
  });
  const send = async text => {
    await page.waitForFunction(() => !document.querySelector('#textForm button[type="submit"]')?.disabled, null, { timeout: 7000 });
    await page.locator("#textInput").evaluate((el, text) => { el.value = text; el.form.requestSubmit(); }, text);
  };
  for (const [width, height] of [[1400, 900], [390, 844], [320, 700]]) {
    const requestStart = requests.length;
    await page.setViewportSize({ width, height });
    await page.goto("http://127.0.0.1:8760/", { timeout: 12000 });
    await page.waitForFunction(() => document.querySelector("#serviceBadge")?.textContent === "准备好了" && document.querySelectorAll("#chatHistory .history-turn").length === 1, null, { timeout: 8000 });
    const compact = await page.evaluate(() => {
      const messages = [...document.querySelectorAll("#chatHistory .history-turn .chat-message")], rects = messages.map(e => e.getBoundingClientRect());
      return { turns: document.querySelectorAll("#chatHistory .history-turn").length, vertical: rects[1].y >= rects[0].bottom, fontSize: getComputedStyle(messages[0].querySelector("p")).fontSize, hiddenMedia: document.querySelector("#sharedMediaStage").hidden, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    await page.locator("#historyToggle").click();
    const expanded = await page.locator("#chatHistory .history-turn").count();
    await page.locator("#historyToggle").click();
    await send("我想看大蝴蝶");
    await page.waitForFunction(() => document.querySelector(".media-viewer__countdown")?.textContent.startsWith("3 "), null, { timeout: 7500 });
    await page.locator(".media-viewer__replay").click();
    const replay = await page.locator(".media-viewer__countdown").textContent();
    await page.locator(".media-viewer__close").click();
    const media = await page.evaluate(() => {
      const stage = document.querySelector("#sharedMediaStage"), card = stage.querySelector(".media-card"), r = card.getBoundingClientRect();
      return { separate: !document.querySelector("#chatHistory").contains(card), title: card.querySelector("h3").textContent, width: r.width, stageWidth: stage.getBoundingClientRect().width, visible: !stage.hidden };
    });
    await page.locator("#sharedMediaStage").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `output/playwright/learning-media-${width}x${height}-20260910.png` });
    await send("爸爸老师，再看刚才的图片");
    await page.locator(".media-viewer").waitFor();
    await send("把图片关掉");
    await page.waitForFunction(() => !document.querySelector(".media-viewer"), null, { timeout: 7000 });
    let wrongTopicRejected = true;
    if (width === 1400) {
      await send("我想看飞机图片");
      await page.waitForFunction(() => document.querySelector("#sharedMediaContent")?.textContent.includes("没有找到合适的飞机"), null, { timeout: 7000 });
      wrongTopicRejected = await page.evaluate(() => !document.querySelector(".media-viewer") && !document.querySelector("#sharedMediaContent .media-card"));
    }
    await page.locator("#playButton").click();
    await page.locator('[data-chess="true"]').click();
    await page.locator(".chess-board").waitFor();
    await page.locator('.chess-board__square[data-square="e2"]').click();
    await page.locator('.chess-board__square[data-square="e3"]').click();
    await page.waitForFunction(() => !document.querySelector('#textForm button[type="submit"]')?.disabled, null, { timeout: 7000 });
    const specificTts = requests.slice(requestStart).some(r => r.path === "/api/tts" && /白兵向前走了一格.*e2.*e3/.test(r.text));
    await send("爸爸老师，下一课");
    await page.waitForFunction(() => document.querySelector(".chess-board__lesson-title")?.textContent.includes("第 2"), null, { timeout: 7500 });
    const chess = await page.evaluate(() => ({ title: document.querySelector(".chess-board__lesson-title").textContent, source: document.querySelector('.chess-board__square[data-square="d4"]').classList.contains("is-guidance-source"), companion: !!document.querySelector(".chess-board > .avatar-companion"), oldReplySuppressed: document.querySelector("#liveTurn").hidden }));
    await page.screenshot({ path: `output/playwright/learning-chess-${width}x${height}-20260910.png` });
    await page.locator(".chess-board__back").click();
    layouts.push({ width, height, compact, expanded, replay, media, wrongTopicRejected, specificTts, chess });
  }
  for (const [width, height] of [[1400, 900], [390, 844], [320, 700]]) {
    await page.setViewportSize({ width, height });
    await page.goto("http://127.0.0.1:8760/parent", { timeout: 12000 });
    await page.locator("#modelPanel summary").click();
    await page.waitForFunction(() => document.querySelector("#modelSaveStatus")?.textContent.includes("载入"), null, { timeout: 7500 });
    if (width === 1400) {
      await page.locator("#modelProvider").selectOption("openai");
      const fixedUrl = await page.locator("#modelBaseUrl").evaluate(e => e.readOnly && e.value === "https://api.openai.com/v1");
      await page.locator("#modelName").fill("qa-new-model");
      await page.locator("#imageProvider").selectOption("openai");
      await page.locator("#modelKey").fill("qa-dummy-not-a-secret");
      await page.locator("#testModel").click();
      await page.waitForFunction(() => document.querySelector("#modelSaveStatus")?.textContent.includes("连接失败"), null, { timeout: 7000 });
      const failedNotSaved = saves === 0 && saved.model === "qa-original";
      await page.locator("#testModel").click();
      await page.waitForFunction(() => document.querySelector("#modelSaveStatus")?.textContent.includes("尚未保存"), null, { timeout: 7000 });
      const testedNotSaved = saves === 0;
      await page.locator('#modelForm button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelector("#modelSaveStatus")?.textContent.includes("已保存并应用"), null, { timeout: 7000 });
      parentLayouts.push({ width, fixedUrl, failedNotSaved, testedNotSaved, savedApplied: saves === 1 && saved.model === "qa-new-model" && saved.image_provider === "openai", keyCleared: await page.locator("#modelKey").inputValue() === "" });
    } else parentLayouts.push({ width, restored: await page.locator("#modelName").inputValue() === "qa-new-model" && await page.locator("#imageProvider").inputValue() === "openai" });
    const geometry = await page.locator("#modelForm").evaluate(form => ({ overflow: document.documentElement.scrollWidth > innerWidth || form.scrollWidth > form.clientWidth + 1, minControlWidth: Math.min(...[...form.querySelectorAll("input,select")].map(e => e.getBoundingClientRect().width)) }));
    parentLayouts.at(-1).geometry = geometry;
    await page.locator("#modelForm").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `output/playwright/learning-parent-models-${width}x${height}-20260910.png` });
  }
  await page.goto("about:blank");
  const pass = layouts.every(item => item.compact.turns === 1 && item.compact.vertical && item.compact.fontSize === "13px" && !item.compact.overflow && item.expanded === 10 && item.replay === "5 秒后收起" && item.media.separate && item.media.visible && item.media.title === "蝴蝶" && item.media.width >= item.media.stageWidth - 60 && item.wrongTopicRejected && item.specificTts && item.chess.source && item.chess.companion && item.chess.oldReplySuppressed)
    && parentLayouts.every(item => !item.geometry.overflow && (item.width === 1400 ? item.fixedUrl && item.failedNotSaved && item.testedNotSaved && item.savedApplied && item.keyCleared : item.restored)) && !errors.length && !blocked.length;
  return { status: pass ? "PASS" : "FAIL", layouts, parentLayouts, errors, blocked, tests, saves, requestCount: requests.length, boundary: "Every API, health, socket and physical media intercepted. Synthetic history, image, silent WAV and model results only. Real app/parent static modules exercised; no model call, real configuration or family writes." };
}
