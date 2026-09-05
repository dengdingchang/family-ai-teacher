const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../frontend/app.js"), "utf8");
const fn = source.slice(source.indexOf("async function startActivityConversation("), source.indexOf("for (const button of activityButtons) {", source.indexOf("async function startActivityConversation(")));

function fixture(overrides = {}) {
  const calls = [];
  const context = vm.createContext({
    conversationActive: false, conversationStarting: false, activeRequestController: null,
    segmentRecording: true, segmentShouldSend: true, segmentPcmChunks: [new Float32Array([0.2])],
    activityEnabled: () => true,
    async startContinuousConversation() { calls.push("microphone"); context.conversationActive = true; },
    stopVadLoop() { calls.push("pause-listening"); },
    async sendStreamingRequest(request) { calls.push(request); },
    stopContinuousConversation() { throw new Error("An activity must keep the active microphone"); },
    ensureCameraStream() { throw new Error("An activity must not open a camera"); },
    setStatus(message) { calls.push(message); }, recordHint: {textContent: ""},
    ...overrides,
  });
  vm.runInContext(fn, context);
  return {context, calls, run: () => vm.runInContext('startActivityConversation({dataset:{activity:"drawing",prompt:"一起画恐龙"}})', context)};
}

test("activity entry opens voice and uses a continuous reply so normal playback resumes listening", async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls.slice(0, 2), ["microphone", "pause-listening"]);
  const request = f.calls[2];
  assert.equal(request.continuous, true);
  assert.equal(request.endpoint, "/api/conversation/text/stream");
  assert.equal(JSON.parse(request.body).text, "一起画恐龙");
  assert.equal(f.context.conversationActive, true);
  assert.equal(f.context.segmentRecording, false);
  assert.equal(f.context.segmentShouldSend, false);
  assert.equal(f.context.segmentPcmChunks.length, 0);
});

test("switching a listening session to an activity reuses its microphone", async () => {
  const f = fixture({conversationActive: true}); await f.run();
  assert.equal(f.calls[0], "pause-listening");
  assert.equal(f.calls.filter(item => item === "microphone").length, 0);
  assert.equal(f.calls[1].continuous, true);
});

test("parent-disabled, pending permission, or an active reply cannot create a competing activity", async () => {
  for (const overrides of [{activityEnabled: () => false}, {conversationStarting: true}, {activeRequestController: {}}]) {
    const f = fixture(overrides); await f.run(); assert.equal(f.calls.length, 0);
  }
});

test("denied microphone does not start a one-way activity or claim to be listening", async () => {
  const f = fixture({async startContinuousConversation() {throw new Error("permission denied");}});
  await f.run();
  assert.equal(f.context.conversationActive, false);
  assert.deepEqual(f.calls, ["麦克风还没打开"]);
  assert.match(f.context.recordHint.textContent, /家长.*麦克风/);
});

test("a reply or parent change during microphone permission leaves listening intact without dispatching an activity", async () => {
  for (const change of [
    context => { context.activeRequestController = {}; },
    context => { context.activityEnabled = () => false; },
  ]) {
    let grantPermission;
    const permission = new Promise(resolve => { grantPermission = resolve; });
    const f = fixture({async startContinuousConversation() {
      await permission;
      f.context.conversationActive = true;
    }});
    const pending = f.run();
    change(f.context);
    grantPermission();
    await pending;
    assert.deepEqual(f.calls, []);
    assert.equal(f.context.conversationActive, true);
    assert.equal(f.context.segmentRecording, true);
    assert.equal(f.context.segmentPcmChunks.length, 1);
  }
});
