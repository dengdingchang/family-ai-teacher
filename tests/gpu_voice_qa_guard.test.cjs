const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("GPU voice QA keeps pagehide timing and history private when network routing fails", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../scripts/qa_gpu_voice_journey.js"), "utf8");
  let initScript;
  const run = vm.runInNewContext(`(${source})`);
  await assert.rejects(run({
    async exposeBinding() {},
    async addInitScript(callback) { initScript = callback.toString(); },
    async route() { throw new Error("router unavailable"); },
  }), /router unavailable/);
  const calls = [], records = [], events = {};
  const browser = vm.createContext({
    URL, Request, Response, Date, location:{href:"http://127.0.0.1:8760/"}, WebSocket:class {},
    async fetch(input) { calls.push(input); return new Response(JSON.stringify({cancelled:true})); },
    async __recordGpuVoiceGuard(record) { records.push(record); },
    addEventListener(name, handler) { (events[name] ||= []).push(handler); },
  });
  browser.window = browser;
  vm.runInContext(`(${initScript})()`, browser);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/interaction-clock.js"), "utf8"), browser);
  let now = 0;
  browser.familyInteractionClock = new browser.InteractionClock({
    now:()=>now, wallNow:()=>Date.parse("2026-09-06T00:00:00Z")+now,
    makeId:()=>"11111111-2222-4333-8444-555555555555",
    send:body=>browser.fetch("/api/conversation/interaction-interval", {method:"POST",body:JSON.stringify(body),keepalive:true}),
  });
  browser.familyInteractionClock.begin();
  browser.familyInteractionClock.confirmInput(browser.familyInteractionClock.sessionId);
  now = 1400;
  events.pagehide.forEach(callback=>callback());
  assert.equal(calls.length, 0);
  assert.equal(records[0].durationSeconds, 1.4);
  assert.equal(records[0].keepalive, true);
  assert.equal((await (await browser.fetch("/api/memory/history")).json()).count, 0);
  assert.equal(calls.length, 0);
  const completion = await browser.fetch("/api/conversation/turns/synthetic-id/complete", {method:"POST"});
  assert.equal((await completion.json()).qa_cancelled, true);
  assert.deepEqual(calls, ["/api/conversation/turns/synthetic-id/cancel"]);
  await browser.fetch(new Request("http://127.0.0.1:8760/api/conversation/interaction-interval?late=1", {
    method:"POST",body:JSON.stringify({session_id:"PRIVATE_DO_NOT_EXPORT",extra:"PRIVATE_DO_NOT_EXPORT"}),keepalive:true,
  }));
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(records).includes("PRIVATE_DO_NOT_EXPORT"), false);
});

test("GPU voice network fallback runs all protected routes without a URL global", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../scripts/qa_gpu_voice_journey.js"), "utf8");
  const sandbox = vm.createContext({});
  assert.equal(vm.runInContext("typeof URL", sandbox), "undefined");
  const run = vm.runInContext(`(${source})`, sandbox);
  let handler, routePattern;
  const result = await run({
    async exposeBinding() {}, async addInitScript() {},
    async route(pattern, callback) { routePattern = pattern; handler = callback; },
    on() {},
    async setViewportSize() { throw new Error("No browser journey in this route-only test"); },
    url:()=>"about:blank",
  });
  function routeFor(url, method, payload, cancelSuccess = true) {
    const calls = [], fulfilled = [];
    return {
      request:()=>({url:()=>url, method:()=>method, postDataJSON:()=>payload}),
      async fulfill(reply) { fulfilled.push(reply); },
      async fetch(options) {
        calls.push(options);
        return {ok:()=>cancelSuccess, json:async()=>({cancelled:cancelSuccess, private_text:"DO_NOT_EXPORT"})};
      },
      continue:()=>assert.fail("protected request must not reach the backend"),
      fallback:()=>assert.fail("protected request must not fall through"),
      calls, fulfilled,
    };
  }
  const timingUrl = "http://127.0.0.1:8760/api/conversation/interaction-interval?teardown=1";
  assert.ok(routePattern.test(timingUrl));
  const timing = routeFor(timingUrl, "POST", {
    session_id:"DO_NOT_EXPORT", sequence:3, start_at:"2026-09-06T00:00:00Z", end_at:"2026-09-06T00:00:02.500Z", private_text:"DO_NOT_EXPORT",
  });
  await handler(timing);
  assert.equal(timing.calls.length, 0);
  assert.deepEqual(JSON.parse(timing.fulfilled[0].body), {ok:true,recorded:true,qa_intercepted:true});
  assert.equal(result.outerNetworkGuard[0].durationSeconds, 2.5);
  assert.equal(result.outerNetworkGuard[0].sequence, 3);

  const history = routeFor("http://127.0.0.1:8760/api/memory/history?limit=20", "GET");
  await handler(history);
  assert.equal(history.calls.length, 0);
  assert.deepEqual(JSON.parse(history.fulfilled[0].body), {history:[],records:[],count:0});

  const completion = routeFor("http://127.0.0.1:8760/api/conversation/turns/synthetic-id/complete?qa=1", "POST");
  await handler(completion);
  assert.equal(completion.calls.length, 1);
  assert.equal(completion.calls[0].url, "http://127.0.0.1:8760/api/conversation/turns/synthetic-id/cancel?qa=1");
  assert.equal(completion.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(completion.fulfilled[0].body), {ok:true,history:null,qa_cancelled:true});
  assert.equal(JSON.stringify([result.outerNetworkGuard, timing.fulfilled, history.fulfilled, completion.fulfilled]).includes("DO_NOT_EXPORT"), false);

  const failedCancel = routeFor("http://127.0.0.1:8760/api/conversation/turns/synthetic-id/complete", "POST", null, false);
  await assert.rejects(handler(failedCancel), /Network QA cancellation failed/);
  assert.equal(failedCancel.fulfilled.length, 0, "failed cancellation must not be reported as successful completion");
  await assert.rejects(handler(routeFor("file:///api/memory/history", "GET")), /Unexpected QA request URL/);
});
