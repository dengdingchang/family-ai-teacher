const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("activity QA blocks real clock pagehide timing even when Playwright routing fails", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../scripts/qa_activity_voice_entry.js"), "utf8");
  let initScript;
  const routeFailure = new Error("synthetic route failure");
  const run = vm.runInNewContext(`(${source})`);
  await assert.rejects(run({
    async evaluate() { return "synthetic-wav"; },
    on() {}, async routeWebSocket() {},
    async addInitScript(callback) { initScript = callback.toString(); },
    async route() { throw routeFailure; },
  }), error => error === routeFailure);

  let mono = 0, nativeFetchCalls = 0;
  const events = {};
  const browser = vm.createContext({
    URL, Request, Response, Date, location:{href:"http://127.0.0.1:8760/"},
    navigator:{mediaDevices:{}},
    fetch:async () => { nativeFetchCalls++; return new Response("native"); },
    addEventListener(name, handler) { (events[name] ||= []).push(handler); },
  });
  browser.window = browser;
  vm.runInContext(`(${initScript})()`, browser);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/interaction-clock.js"), "utf8"), browser);
  const clock = new browser.InteractionClock({
    now:() => mono, wallNow:() => Date.parse("2026-09-06T01:00:00Z") + mono,
    makeId:() => "11111111-2222-4333-8444-555555555555",
    send:payload => browser.fetch("/api/conversation/interaction-interval", {
      method:"POST", keepalive:true, body:JSON.stringify(payload),
    }),
  });
  clock.begin(); clock.confirmInput(clock.sessionId);
  mono = 1200;
  (events.pagehide ||= []).push(() => clock.end());
  for (const handler of events.pagehide) handler();
  assert.equal(nativeFetchCalls, 0, "teardown telemetry must never reach the disabled router or network");
  assert.equal(browser.__activityVoiceQa.timing.length, 1);
  assert.equal(browser.__activityVoiceQa.timing[0].sessionId, "11111111-2222-4333-8444-555555555555");
  assert.equal(browser.__activityVoiceQa.timing[0].durationSeconds, 1.2);
  assert.equal(browser.__activityVoiceQa.timing[0].keepalive, true);

  const reply = await browser.fetch(new Request("http://127.0.0.1:8760/api/conversation/interaction-interval?late=1", {
    method:"POST", keepalive:true, body:JSON.stringify({session_id:"DO_NOT_EXPORT",extra_private_text:"DO_NOT_EXPORT",sequence:2}),
  }));
  assert.deepEqual(await reply.json(), {ok:true,recorded:true,qa_intercepted:true});
  await browser.fetch("/api/conversation/interaction-interval", {method:"POST",body:"broken JSON"});
  assert.equal(browser.__activityVoiceQa.timing[2].validJson, false);
  assert.equal(nativeFetchCalls, 0);
  assert.equal(JSON.stringify(browser.__activityVoiceQa.timing).includes("DO_NOT_EXPORT"), false);
  await browser.fetch("/health");
  assert.equal(nativeFetchCalls, 1, "other QA networking keeps the existing route path");
});
