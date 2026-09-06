const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

function conversation(overrides = {}) {
  const calls = [], requests = [];
  const c = vm.createContext({
    activeRequestController: null, activeTurnId: null, interruptedRequestController: null,
    activeRequestSource: '', drawingBoard: null, queueGeneration: 1,
    conversationActive: true, segmentRecording: true, segmentShouldSend: true, segmentPcmChunks: [1],
    avatarReady: false, AbortController, FormData, Blob, DOMException,
    globalThis: { crypto: { randomUUID: () => 'visual-regression' }, familyInteractionClock: {
      sessionId: 'real-session', begin() { calls.push('begin'); return 'real-session'; },
      confirmInput() { calls.push('input'); }, end() {},
    } },
    setBusy() {}, setStatus() {}, resetLiveTurn() {}, hideLiveTurn() {},
    stopVadLoop() { calls.push('pause'); }, startBargeInMonitor() { calls.push('barge'); }, stopBargeInMonitor() {},
    beginContinuousSegment() { calls.push('listen'); c.segmentRecording = true; },
    clearResponseQueue() {}, cancelPlayback() {}, enqueueAudio() { calls.push('audio'); },
    waitForAudioQueue: async () => { calls.push('played'); },
    answerBox: { classList: { add() {} }, textContent: '' }, liveTurn: {}, userTextBox: {},
    appendHistoryRecord() {},
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true }) }; },
    consumeSse: async (_response, emit) => {
      emit({ event: 'user_text', text: '看看这张照片' });
      emit({ event: 'audio' });
      emit({ event: 'done', assistant_text: '手里有一个银色工具。', commit_required: true, ok: true });
    },
    ...overrides,
  });
  vm.runInContext(extract('function createConversationTurnId()', '\nasync function sendText('), c);
  return { c, calls, requests };
}

test('a photo reply pauses an already-open microphone and resumes it for the next spoken turn', async () => {
  const f = conversation();
  const photo = await f.c.sendStreamingRequest({ endpoint: '/api/conversation/frame/stream', body: new Blob(['fixture']) });
  assert.equal(photo.ok, true);
  assert.equal(f.calls[0], 'pause');
  assert.ok(f.calls.indexOf('barge') < f.calls.indexOf('audio'));
  assert.ok(f.calls.indexOf('played') < f.calls.indexOf('listen'));
  assert.equal(f.c.segmentPcmChunks.length, 0);
  assert.equal(f.c.segmentRecording, true);
  const voice = await f.c.sendStreamingRequest({ endpoint: '/api/conversation/stream', body: new FormData(), continuous: true });
  assert.equal(voice.ok, true);
  assert.equal(f.calls.filter(x => x === 'listen').length, 2);
  assert.equal(f.requests.filter(x => x.url.endsWith('/complete')).length, 2);
});

test('automatic drawing observation speaks but cannot confirm a child input or commit a history turn', async () => {
  const f = conversation({ consumeSse: async (_response, emit) => {
    emit({ event: 'user_text', text: 'synthetic observer instruction' });
    emit({ event: 'audio' });
    emit({ event: 'done', assistant_text: '看到一条蓝线。', ok: true, commit_required: false });
  } });
  const result = await f.c.sendStreamingRequest({ endpoint: '/api/conversation/stream', body: new FormData(), source: 'drawing-observation' });
  assert.equal(result.ok, true);
  assert.ok(f.calls.includes('played'));
  assert.equal(f.calls.includes('begin'), false);
  assert.equal(f.calls.includes('input'), false);
  assert.equal(f.requests.some(x => x.url.endsWith('/complete')), false);
  assert.equal(f.requests.some(x => x.url.endsWith('/cancel')), true, 'release the non-committing server turn after speech');
});

test('an explicit reference to the captured photo reuses that image instead of silently taking a different one', async () => {
  const image = new Blob(['old-visible-picture'], { type: 'image/jpeg' });
  let step = 0;
  const f = conversation({ conversationActive: false, capturedBlob: image, captureState: {}, cameraStatus: {},
    activityEnabled: () => true,
    makeFrameBlob() { throw new Error('must use the explicitly referenced picture'); },
    consumeSse: async (_response, emit) => {
      if (!step++) emit({ event: 'vision_request', text: '上面这张照片手里拿的是什么？' });
      else emit({ event: 'done', assistant_text: '照片中有一个工具。', ok: true });
    },
  });
  assert.equal((await f.c.sendStreamingRequest({ endpoint: '/api/conversation/stream', body: new FormData() })).ok, true);
  const observed = f.requests[1].options.body;
  assert.equal(await observed.get('frame').text(), 'old-visible-picture');
});

test('streaming avatar has an explicit begin while legacy complete audio remains compatible', () => {
  const events = [];
  const c = vm.createContext({ avatarReady: true, avatarSocket: { readyState: 1 }, WebSocket: { OPEN: 1 },
    avatarAudioLeadMs: 900, avatarAcceptFrames: false,
    flushAvatar() { events.push('flush'); }, sendAvatarEvent(event) { events.push(event.type); return true; },
  });
  vm.runInContext(extract('function cueAvatar(', 'function resolveQueueWaiters('), c);
  c.cueAvatar({ sequence: 1, audio_stream: true, avatar_pcm_base64: 'a' });
  c.cueAvatar({ sequence: 2, audio_stream: true, avatar_pcm_base64: 'b' });
  assert.deepEqual(events, ['flush', 'audio_begin', 'audio', 'audio']);
  events.length = 0;
  c.cueAvatar({ sequence: 1, avatar_pcm_base64: 'whole-utterance' });
  assert.deepEqual(events, ['flush', 'audio']);
});
