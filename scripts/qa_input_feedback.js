async (page) => {
  // The runner inserts the committed baseline as strings. No audio, model, or
  // family data API is sent to the server in this visual comparison.
  const baselineAssets = /* BASELINE_ASSETS */ null;
  const errors = [], blockedPosts = [], results = [];
  let phase = "baseline", evaluation = { checks: {} };
  const outputPrefix = "output/playwright/input-feedback-final";
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/ws/avatar", socket => socket.close());
  await page.exposeBinding("__reportFeedbackPost", (_, value) => blockedPosts.push(value));
  await page.addInitScript(() => {
    const qa = window.__inputFeedbackQa = { streams: [], contexts: [], gains: [], devices: [] };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const request = input instanceof Request;
      const path = new URL(request ? input.url : String(input), location.href).pathname;
      const method = String(init.method || (request ? input.method : "GET")).toUpperCase();
      if (path.startsWith("/api/") && method !== "GET") {
        await window.__reportFeedbackPost({ path, method });
        return new Response(JSON.stringify({ ok: true, recorded: true, qa_intercepted: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return nativeFetch(input, init);
    };
    if (!navigator.mediaDevices) return; // about:blank has no mediaDevices.
    navigator.mediaDevices.getUserMedia = async constraints => {
      qa.devices.push({ audio: Boolean(constraints.audio), video: Boolean(constraints.video) });
      if (!constraints.audio || constraints.video) throw new Error("Only synthetic microphone input is allowed");
      const context = new AudioContext(), source = context.createOscillator();
      const gain = context.createGain(), destination = context.createMediaStreamDestination();
      source.frequency.value = 440;
      gain.gain.value = 0;
      source.connect(gain).connect(destination);
      source.start();
      await context.resume();
      qa.contexts.push(context); qa.gains.push(gain); qa.streams.push(destination.stream);
      return destination.stream;
    };
    addEventListener("pagehide", () => {
      for (const stream of qa.streams) stream.getTracks().forEach(track => track.stop());
      for (const context of qa.contexts) void context.close();
    });
  });
  await page.route(/\/api\/|\/health(?:\?|$)|\/(?:app\.js|styles\.css)(?:\?|$)/, async route => {
    const request = route.request(), path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path === "/app.js" || path === "/styles.css") {
      if (phase !== "baseline") return route.continue();
      if (!baselineAssets) throw new Error("Committed baseline assets are required");
      return route.fulfill({ contentType: path.endsWith(".js") ? "text/javascript" : "text/css", body: baselineAssets[path] });
    }
    if (path === "/api/avatar" || path === "/api/avatar/idle") return route.continue();
    let payload;
    if (path === "/health") payload = { status: "ok", stt_ready: true, tts_ready: true, tts_warmup: "ready", llm_configured: true, interaction_timing_supported: true };
    else if (path === "/api/profile") payload = { name: "测试探索家", enabled_activities: ["drawing", "story", "game"] };
    else if (path === "/api/memory/history") payload = { history: [], count: 0 };
    else {
      errors.push(`Unexpected isolated request: ${request.method()} ${path}`);
      return route.abort();
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  async function sample(amplitude) {
    await page.evaluate(value => { window.__inputFeedbackQa.gains.at(-1).gain.value = value; }, amplitude);
    await page.waitForTimeout(320);
    return page.evaluate(() => {
      const stage = document.querySelector("#avatarStage"), bar = stage.querySelector(".voice-bars i");
      const transform = getComputedStyle(bar).transform;
      return { state: stage.dataset.state, level: stage.style.getPropertyValue("--listening-level"),
        scale: new DOMMatrixReadOnly(transform).d, height: bar.getBoundingClientRect().height,
        animation: getComputedStyle(bar).animationName };
    });
  }
  try {
    await page.setViewportSize({ width: 1366, height: 768 });
    for (phase of ["baseline", "candidate"]) {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto("http://127.0.0.1:8760/");
      await page.waitForFunction(() => document.querySelector("#serviceBadge")?.textContent === "准备好了");
      await page.locator("#recordButton").click();
      const silence = await sample(0), quiet = await sample(0.03), voice = await sample(0.18);
      await page.screenshot({ path: `${outputPrefix}-${phase}.png` });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const reducedVoice = await sample(0.18), reducedSilence = await sample(0);
      await page.locator("#recordButton").click();
      const stopped = await page.evaluate(() => ({ state: document.querySelector("#avatarStage").dataset.state,
        level: document.querySelector("#avatarStage").style.getPropertyValue("--listening-level"),
        tracksEnded: window.__inputFeedbackQa.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")) }));
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.locator("#recordButton").click();
      const restarted = await sample(0);
      await page.locator("#recordButton").click();
      results.push({ phase, silence, quiet, voice, reducedVoice, reducedSilence, stopped, restarted });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#recordButton").click();
    await sample(0.18);
    const mobile = await page.evaluate(() => {
      const button = document.querySelector("#recordButton").getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth, primaryVisible: button.top >= 0 && button.bottom <= innerHeight,
        primaryHeight: button.height, devices: window.__inputFeedbackQa.devices };
    });
    await page.screenshot({ path: `${outputPrefix}-mobile.png` });
    await page.locator("#recordButton").click();
    const [baseline, candidate] = results;
    const checks = {
      baselineWasStatic: baseline.voice.height === baseline.silence.height,
      candidateResponds: candidate.quiet.height > candidate.silence.height && candidate.voice.height > candidate.quiet.height,
      reducedMotionStatic: candidate.reducedVoice.height === candidate.reducedSilence.height && candidate.reducedVoice.animation === "none",
      clearedOnStop: candidate.stopped.state === "idle" && candidate.stopped.tracksEnded && !candidate.stopped.level,
      resetOnRestart: candidate.restarted.height === candidate.silence.height,
      mobileLayout: !mobile.overflow && mobile.primaryVisible && mobile.primaryHeight >= 48,
      onlySyntheticAudio: mobile.devices.every(device => device.audio && !device.video),
      noDataPosts: blockedPosts.length === 0,
      noPageErrors: errors.length === 0,
    };
    evaluation = { checks, results, mobile, blockedPosts, errors,
      boundary: "Committed baseline versus current frontend; actual WebAudio oscillator and VAD sampling; mocked data APIs, no models or physical devices." };
  } finally {
    await page.evaluate(async () => {
      if (document.querySelector("#recordButton")?.getAttribute("aria-pressed") === "true") document.querySelector("#recordButton").click();
      for (const stream of window.__inputFeedbackQa?.streams || []) stream.getTracks().forEach(track => track.stop());
      await Promise.all((window.__inputFeedbackQa?.contexts || []).map(context => context.close().catch(() => {})));
    }).catch(() => {});
    await page.goto("about:blank");
  }
  // Teardown pageerrors are part of the verdict, including init scripts on the
  // blank destination. Do not compute PASS before finally has completed.
  evaluation.checks.noPageErrors = errors.length === 0;
  return { status: Object.values(evaluation.checks).every(Boolean) ? "PASS" : "FAIL", ...evaluation, finalUrl: page.url() };
}
