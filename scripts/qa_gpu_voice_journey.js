async (page) => {
  const browserGuardRecords = [], routeGuardRecords = [], pageErrors = [];
  await page.exposeBinding("__recordGpuVoiceGuard", (_, record) => browserGuardRecords.push(record));
  await page.addInitScript(() => {
    const qa = window.__gpuVoiceGuard = { intervalRecords: [], readyToRun: false, framesBeforeRun: 0 };
    const nativeFetch = window.fetch.bind(window);
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    const report = async record => {
      try { await window.__recordGpuVoiceGuard(record); } catch (_) {}
    };
    // This outer guard remains installed when the inner driver's hooks are
    // restored and throughout pagehide, even if Playwright routing disappears.
    window.fetch = async (input, init = {}) => {
      const isRequest = input instanceof Request;
      const url = new URL(isRequest ? input.url : String(input), location.href);
      const method = String(init.method || (isRequest ? input.method : "GET")).toUpperCase();
      if (url.pathname === "/api/conversation/interaction-interval" && method === "POST") {
        let body = {}, validJson = true;
        try {
          body = JSON.parse(init.body ?? (isRequest ? await input.clone().text() : ""));
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid timing body");
        } catch (_) { body = {}; validJson = false; }
        const seconds = (Date.parse(body.end_at) - Date.parse(body.start_at)) / 1000;
        const record = {
          kind: "interaction-interval", validJson,
          sessionId: typeof body.session_id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.session_id) ? body.session_id : null,
          sequence: Number.isInteger(body.sequence) ? body.sequence : null,
          durationSeconds: Number.isFinite(seconds) ? seconds : null,
          keepalive: init.keepalive ?? (isRequest ? input.keepalive : false),
          fulfilled: true,
        };
        qa.intervalRecords.push(record);
        await report(record);
        return json({ ok: true, recorded: true, qa_intercepted: true });
      }
      if (url.pathname === "/api/memory/history" && method === "GET")
        return json({ history: [], records: [], count: 0 });
      if (/^\/api\/conversation\/turns\/[^/]+\/complete$/.test(url.pathname) && method === "POST") {
        const response = await nativeFetch(url.pathname.replace(/\/complete$/, "/cancel"), { method: "POST", keepalive: true });
        const receipt = await response.json();
        if (!response.ok || receipt.cancelled !== true) throw new Error("QA completion cancellation failed");
        await report({ kind: "completion-cancelled", cancelled: true });
        return json({ ok: true, history: null, qa_cancelled: true });
      }
      return nativeFetch(input, init);
    };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        if (new URL(this.url).pathname === "/ws/avatar")
          this.addEventListener("message", event => {
            if (!qa.readyToRun && typeof event.data !== "string") qa.framesBeforeRun++;
          });
      }
    };
    addEventListener("pagehide", () => globalThis.familyInteractionClock?.end());
  });
  await page.route(/\/api\/memory\/history(?:\?.*)?$|\/api\/conversation\/interaction-interval(?:\?.*)?$|\/api\/conversation\/turns\/[^/]+\/complete(?:\?.*)?$/, async route => {
    // The CLI callback sandbox has no URL global. Requests here are absolute
    // HTTP(S) URLs; extract only their path and reject any other scheme.
    const request = route.request(), requestUrl = request.url();
    const pathMatch = /^https?:\/\/[^/?#\\]+(\/[^?#]*)?(?:[?#].*)?$/.exec(requestUrl);
    if (!pathMatch) throw new Error("Unexpected QA request URL");
    const pathname = pathMatch[1] || "/";
    let body;
    if (pathname === "/api/memory/history") body = { history: [], records: [], count: 0 };
    else if (pathname.endsWith("/complete")) {
      const cancelled = await route.fetch({ url: request.url().replace(/\/complete(?=\?|$)/, "/cancel"), method: "POST" });
      const receipt = await cancelled.json();
      if (!cancelled.ok() || receipt.cancelled !== true) throw new Error("Network QA cancellation failed");
      routeGuardRecords.push({ kind: "completion-cancelled", cancelled: true });
      body = { ok: true, history: null, qa_cancelled: true };
    } else {
      let payload = {};
      try { payload = request.postDataJSON() || {}; } catch (_) {}
      const seconds = (Date.parse(payload.end_at) - Date.parse(payload.start_at)) / 1000;
      routeGuardRecords.push({ kind: "interaction-interval", sequence: Number.isInteger(payload.sequence) ? payload.sequence : null,
        durationSeconds: Number.isFinite(seconds) ? seconds : null, fulfilled: true });
      body = { ok: true, recorded: true, qa_intercepted: true };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  const probe = /* SYNTHETIC_PROBE */ null;
  let response = { status: "FAIL", failure: "Probe did not start" }, framesBeforeRun = null;
  try {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("http://127.0.0.1:8760/");
    await page.waitForFunction(() => document.querySelector("#serviceBadge")?.textContent === "准备好了", null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("#avatarStateText")?.textContent === "准备好啦，可以一起说话", null, { timeout: 15000 });
    await page.waitForTimeout(2000);
    framesBeforeRun = await page.evaluate(() => window.__gpuVoiceGuard.framesBeforeRun);
    if (framesBeforeRun !== 0) throw new Error("Existing Avatar activity prevents an isolated synthetic journey");
    await page.evaluate(() => { window.__gpuVoiceGuard.readyToRun = true; });
    response = await probe(page);
  } catch (error) {
    response = { ...response, status: "FAIL", failure: String(error?.message || error) };
  } finally {
    // The reused driver's finally already stops the synthetic session and goes
    // blank; cover preflight failures too. Never release the outer routes here.
    if (page.url() !== "about:blank") {
      await page.evaluate(async () => {
        if (typeof stopContinuousConversation === "function") stopContinuousConversation();
        globalThis.familyInteractionClock?.end();
        await window.__restoreSyntheticVoiceQa?.();
      }).catch(() => {});
      await page.goto("about:blank");
    }
  }
  const formalSignalMs = (response.turnTiming || []).map(turn => turn.semanticFirstSignalLatencyMs);
  const latencyPass = formalSignalMs.length === 3 && formalSignalMs.every(value => Number.isFinite(value) && value <= 2500);
  return {
    ...response,
    status: response.status === "PASS" && latencyPass && !pageErrors.length ? "PASS" : "FAIL",
    journeyStatusBeforeLatency: response.status,
    latencyPass, formalSignalTargetMs: 2500,
    pageErrors, historyCountsMocked: true, framesBeforeRun,
    browserTimingGuard: browserGuardRecords,
    outerNetworkGuard: routeGuardRecords,
    finalUrl: page.url(),
    isolation: "Browser fetch and retained network guards cancel completion and block timing through about:blank; family file integrity is checked independently.",
  };
}
