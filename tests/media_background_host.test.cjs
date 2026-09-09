const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/app.js"), "utf8");
const mediaSource = source.slice(source.indexOf("function cancelMediaSuggestionLookup("), source.indexOf("function renderHistory("));
const themeSource = source.slice(source.indexOf("function cancelMusicTheme("), source.indexOf("async function openMusicActivity("));
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const json = value => ({ ok: true, json: async () => value });

function fixture() {
  const fetches = [], cancellations = [], waits = [], opened = [];
  let serial = 0;
  const context = vm.createContext({
    AbortController, DOMException, setTimeout, clearTimeout,
    crypto: { randomUUID: () => `${String(++serial).padStart(8, "0")}-0000-4000-8000-000000000000` },
    mediaSuggestionRequestController: null, mediaSuggestionGeneration: 0, mediaSuggestionJobStatusUrl: "", mediaSuggestionGroups: [],
    musicThemeController: null, musicThemeJobUrl: "", musicStudio: { opened: true },
    document: { hidden: false }, renderHistory() {},
    mediaViewer: { close() {}, openImage(card) { opened.push(card); }, openVideo(card) { opened.push(card); } },
    chooseMediaSuggestion: text => text === "ordinary" ? null : { topic: text, kind: "image", generateImage: true },
    fetch(url, options = {}) {
      if (url.endsWith("/cancel")) { cancellations.push(url); return Promise.resolve(json({ status: "cancelled" })); }
      const response = deferred(); fetches.push({ url, options, response }); return response.promise;
    },
  });
  vm.runInContext(mediaSource + "\n" + themeSource, context);
  context.waitForMediaPoll = (_ms, signal) => {
    if (signal.aborted) return Promise.resolve(false);
    const wait = deferred(); waits.push(wait); signal.addEventListener("abort", () => wait.resolve(false), { once: true }); return wait.promise;
  };
  return { context, fetches, cancellations, waits, opened };
}

test("an aborted earlier media request must not cancel the new generation job", async () => {
  const f = fixture();
  const first = f.context.loadMediaSuggestions("蝴蝶");
  const oldJob = f.context.mediaSuggestionJobStatusUrl;
  const second = f.context.loadMediaSuggestions("飞机");
  const currentJob = f.context.mediaSuggestionJobStatusUrl;
  try {
    assert.notEqual(currentJob, oldJob);
    f.fetches[0].response.reject(new DOMException("Superseded request", "AbortError"));
    await first;
    assert.equal(f.cancellations.includes(`${currentJob}/cancel`), false, "the stale catch must not send cancellation for its successor");
    assert.equal(f.context.mediaSuggestionJobStatusUrl, currentJob);
  } finally {
    f.fetches[1].response.resolve(json({ topic: "飞机", cards: [], image_generation: "failed" }));
    await second;
    f.context.cancelMediaSuggestionLookup();
  }
});

test("ordinary conversation leaves an in-flight requested picture alive", async () => {
  const f = fixture();
  const image = f.context.loadMediaSuggestions("蝴蝶");
  const controller = f.context.mediaSuggestionRequestController, generation = f.context.mediaSuggestionGeneration;
  await f.context.loadMediaSuggestions("ordinary", "We can keep talking");
  assert.equal(controller.signal.aborted, false);
  assert.equal(f.context.mediaSuggestionGeneration, generation);
  assert.equal(f.fetches.length, 1);
  f.fetches[0].response.resolve(json({ topic: "蝴蝶", cards: [{ topic: "蝴蝶", kind: "image" }] }));
  await image; assert.equal(f.opened.length, 1);
});

test("late theme response cannot replace the currently owned job cancellation URL", async () => {
  const f = fixture(), oldBody = deferred();
  const first = f.context.prepareMusicTheme("蝴蝶");
  const oldJob = f.context.musicThemeJobUrl;
  f.fetches[0].response.resolve({ ok: true, json: () => oldBody.promise });
  await settle();
  const second = f.context.prepareMusicTheme("飞机");
  const currentJob = f.context.musicThemeJobUrl;
  try {
    oldBody.resolve({ topic: "蝴蝶主题的可爱音乐玩具", cards: [], image_generation_job: { status_url: oldJob } });
    assert.equal(await first, undefined);
    assert.equal(f.context.musicThemeJobUrl, currentJob, "late JSON must not steal the current cancellation handle");
    f.context.cancelMusicTheme();
    assert.ok(f.cancellations.includes(`${currentJob}/cancel`), "closing cancels the current backend job");
  } finally {
    f.fetches[1].response.resolve(json({ topic: "飞机主题的可爱音乐玩具", cards: [{ generated: true, topic: "飞机主题的可爱音乐玩具", thumbnail_url: "/api/generated-media/0123456789abcdef01234567.png" }] }));
    await second;
    f.context.cancelMusicTheme();
  }
});

test("an old poll wakeup cannot abort a newly selected music theme", async () => {
  const f = fixture(); let oldCurrent = true;
  const first = f.context.prepareMusicTheme("蝴蝶", { isCurrent: () => oldCurrent });
  const oldJob = f.context.musicThemeJobUrl;
  f.fetches[0].response.resolve(json({ topic: "蝴蝶主题的可爱音乐玩具", cards: [], image_generation_job: { status_url: oldJob } }));
  await settle();
  assert.equal(f.waits.length, 1);
  f.waits[0].resolve(true);
  oldCurrent = false;
  const second = f.context.prepareMusicTheme("飞机");
  const controller = f.context.musicThemeController, currentJob = f.context.musicThemeJobUrl;
  try {
    await first;
    assert.equal(controller.signal.aborted, false, "the superseded loop must not call a global cancel on its successor");
    assert.equal(f.cancellations.includes(`${currentJob}/cancel`), false);
  } finally {
    f.fetches[1].response.resolve(json({ topic: "飞机主题的可爱音乐玩具", cards: [{ generated: true, topic: "飞机主题的可爱音乐玩具", thumbnail_url: "/api/generated-media/0123456789abcdef01234567.png" }] }));
    await second; f.context.cancelMusicTheme();
  }
});

test("a theme closed during a late response never returns artwork", async () => {
  const f = fixture();
  const pending = f.context.prepareMusicTheme("蝴蝶");
  f.context.musicStudio.opened = false; f.context.cancelMusicTheme();
  f.fetches[0].response.resolve(json({ topic: "蝴蝶主题的可爱音乐玩具", cards: [{ generated: true, topic: "蝴蝶主题的可爱音乐玩具", thumbnail_url: "/api/generated-media/0123456789abcdef01234567.png" }] }));
  assert.equal(await pending, undefined);
});

test("switching to a cached or plain theme cancels an obsolete background generation", async () => {
  const f = fixture(); let current = true;
  const pending = f.context.prepareMusicTheme("蝴蝶", { isCurrent: () => current });
  const job = f.context.musicThemeJobUrl;
  // Cached/plain themes have no new onThemeRequest, so no successor cancels it.
  current = false;
  f.fetches[0].response.resolve(json({ topic: "蝴蝶主题的可爱音乐玩具", cards: [], image_generation_job: { status_url: job } }));
  assert.equal(await pending, undefined);
  assert.ok(f.cancellations.includes(`${job}/cancel`), "do not discard the last cancellation handle while its backend generation is still active");
});

test("an interrupted lesson finally cannot restart microphone capture over a playing video", () => {
  const start = source.indexOf("function beginContinuousSegment(");
  const end = source.indexOf("function finishContinuousSegment(", start);
  const calls = [];
  const context = vm.createContext({ conversationActive: true, recordingStream: { active: true }, segmentRecording: false,
    mediaViewer: { openKind: "video" }, musicStudio: null, resetListeningLevel() {}, stopBargeInMonitor() {}, recordHint: {},
    setStatus(...args) { calls.push(args); }, scheduleVad() { calls.push("VAD resumed"); }, performance,
    segmentPcmChunks: [], segmentShouldSend: false, speechStartedAt: 0, lastVoiceAt: 0, loudSince: 0 });
  vm.runInContext(source.slice(start, end), context);
  context.beginContinuousSegment();
  assert.equal(context.segmentRecording, false, "the finalizer must respect the active video's microphone pause");
  assert.equal(calls.length, 0);
  context.mediaViewer.openKind = null;
  context.beginContinuousSegment();
  assert.equal(context.segmentRecording, true, "capture remains resumable after closing the video");
});

test("opening video cancels unfinished speech and releases its audio waiter without a completion receipt", async () => {
  const start = source.indexOf("function resolveQueueWaiters(");
  const end = source.indexOf("async function playAudioPayload(", start);
  assert.ok(start > 0 && end > start);
  const core = source.slice(start, end);
  const viewerStart = source.indexOf("const mediaViewer = new MediaViewer(");
  const viewerEnd = source.indexOf("const mediaSuggestionGroups =", viewerStart);
  const controller = new AbortController(), cancelledTurns = [];
  const context = vm.createContext({
    MediaViewer: class { constructor(options) { this.callbacks = options; this.openKind = "video"; } },
    document: { createElement: () => ({}) }, mediaPlaybackGeneration: 0, mediaResumePending: false, mediaConversationWasActive: false,
    conversationActive: true, activeRequestController: controller, interruptedRequestController: null, activeTurnId: "synthetic-turn",
    cancelConversationTurn(id) { cancelledTurns.push(id); return Promise.resolve(); }, stopVadLoop() {}, stopBargeInMonitor() {},
    segmentRecording: true, segmentShouldSend: true, segmentPcmChunks: [new Float32Array(2)],
    audioQueue: [{}], queueDraining: true, queueGeneration: 1, queueDrainWaiters: [], queuePlaybackError: null,
    streamingPlayback: null, cancelAvatarFrameWaiters() {}, flushAvatar() {}, activeAudio: null, activeAudioUrl: null,
    activePlayback: { finish() { context.queueDraining = false; context.activePlayback = null; context.resolveQueueWaiters(); } },
  });
  vm.runInContext(core + "\n" + source.slice(viewerStart, viewerEnd), context);
  const audioWait = context.waitForAudioQueue();
  vm.runInContext("mediaViewer.callbacks.onOpen('video')", context);
  await audioWait;
  assert.equal(controller.signal.aborted, true);
  assert.equal(context.interruptedRequestController, controller);
  assert.deepEqual(cancelledTurns, ["synthetic-turn"]);
  assert.equal(context.segmentRecording, false);
  assert.equal(context.queueDrainWaiters.length, 0);
  assert.equal(context.activePlayback, null);
});

test("a slow completion receipt keeps the post-video resume pending until the request releases", async () => {
  const start = source.indexOf("async function resumeConversationAfterMedia(");
  const end = source.indexOf("const mediaViewer = new MediaViewer", start);
  let clock = 0, resumed = 0;
  const context = vm.createContext({ performance: { now: () => clock }, setTimeout(fn) { clock += 1000; queueMicrotask(fn); },
    activeRequestController: {}, conversationActive: true, conversationStarting: false, segmentRecording: false,
    mediaPlaybackGeneration: 1, mediaResumePending: true, mediaViewer: { openKind: null },
    beginContinuousSegment() { resumed++; },
  });
  vm.runInContext(source.slice(start, end), context);
  await context.resumeConversationAfterMedia(1);
  assert.equal(resumed, 0);
  assert.equal(context.mediaResumePending, true, "a bounded wait must not erase the request to resume when a slow receipt settles");
  context.activeRequestController = null;
  await context.resumeConversationAfterMedia(1);
  assert.equal(resumed, 1);
  assert.equal(context.mediaResumePending, false);
});
