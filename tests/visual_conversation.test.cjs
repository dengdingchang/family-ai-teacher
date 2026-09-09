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
    musicStudio: null, mediaViewer: { handleVoiceCommand: () => false, close() {} },
    conversationActive: true, segmentRecording: true, segmentShouldSend: true, segmentPcmChunks: [1],
    avatarReady: false, AbortController, FormData, Blob, DOMException,
    globalThis: { crypto: { randomUUID: () => 'visual-regression' }, familyInteractionClock: {
      sessionId: 'real-session', begin() { calls.push('begin'); return 'real-session'; },
      confirmInput() { calls.push('input'); }, end() {},
    } },
    setBusy() {}, setStatus() {}, resetLiveTurn() {}, hideLiveTurn() {},
    loadMediaSuggestions() {},
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

test('a spoken picture replay consumes the UI command without old activity audio or completion', async () => {
  const viewed = [];
  const f = conversation({
    mediaViewer: { openKind: 'image', handleVoiceCommand(text) { viewed.push(text); return true; }, close() { throw new Error('must preserve requested picture'); } },
    consumeSse: async (_response, emit) => {
      emit({ event: 'user_text', text: '爸爸老师，再看刚才的图片' });
      emit({ event: 'audio' });
      emit({ event: 'done', assistant_text: '你找到红色了吗', commit_required: true, ok: true });
    },
  });
  const result = await f.c.sendStreamingRequest({ endpoint: '/api/conversation/stream', body: new FormData() });
  assert.equal(result.localCommand, true);
  assert.deepEqual(viewed, ['爸爸老师，再看刚才的图片']);
  assert.equal(f.calls.includes('audio'), false);
  assert.equal(f.requests.some(r => r.url.endsWith('/complete')), false);
  assert.equal(f.requests.some(r => r.url.endsWith('/cancel')), true);
  assert.equal(f.c.activeRequestController, null);
  assert.equal(f.calls.at(-1), 'listen');
});

test('music voice commands release the STT request before arranging real narration and notes', async () => {
  const f = conversation({
    parseMusicVoiceCommand: text => text === '慢一点' ? 'slower' : '',
    consumeSse: async (_response, emit) => {
      emit({ event: 'user_text', text: '慢一点' });
      throw new DOMException('cancelled reading', 'AbortError');
    },
  });
  const musicCalls = [];
  f.c.musicStudio = { opened: true, handleVoiceCommand(text) {
    assert.equal(f.c.activeRequestController, null);
    musicCalls.push(text);
    f.c.activeRequestController = new AbortController(); // music now owns narration
  } };
  const result = await f.c.sendStreamingRequest({ endpoint: '/api/conversation/stream', body: new FormData() });
  assert.equal(result.localCommand, true);
  assert.deepEqual(musicCalls, ['慢一点']);
  assert.equal(f.calls.includes('listen'), false, 'music owns the full note tail before listening');
  assert.ok(f.c.activeRequestController);
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

test('streaming and complete audio use the compatible legacy avatar cues', () => {
  const events = [];
  const c = vm.createContext({ avatarReady: true, avatarSocket: { readyState: 1 }, WebSocket: { OPEN: 1 },
    avatarAudioLeadMs: 900, avatarAcceptFrames: false,
    flushAvatar() { events.push('flush'); }, sendAvatarEvent(event) { events.push(event.type); return true; },
  });
  vm.runInContext(extract('function cueAvatar(', 'function resolveQueueWaiters('), c);
  c.cueAvatar({ sequence: 1, audio_stream: true, avatar_pcm_base64: 'a' });
  c.cueAvatar({ sequence: 2, audio_stream: true, avatar_pcm_base64: 'b' });
  assert.deepEqual(events, ['flush', 'audio', 'audio']);
  events.length = 0;
  c.cueAvatar({ sequence: 1, avatar_pcm_base64: 'whole-utterance' });
  assert.deepEqual(events, ['flush', 'audio']);
});

for (const transition of [{action:'set',activity:'story',step:1}, {action:'clear',activity:'drawing',step:2}]) {
  test(`completed drawing voice ${transition.action}/${transition.activity} closes the board only after playback and receipt`, async () => {
    let closed=0, release;
    const f=conversation({drawingBoard:{isOpen:true,close(){closed++;assert.ok(f.requests.at(-1).url.endsWith('/complete'));}},
      waitForAudioQueue:()=>new Promise(resolve=>{release=resolve;}),
      consumeSse:async(_response,emit)=>{emit({event:'audio'});emit({event:'done',assistant_text:'我们接着玩。',ok:true,commit_required:true,activity_transition:transition});}});
    const result=f.c.sendStreamingRequest({endpoint:'/api/conversation/stream',body:new FormData(),source:'drawing-voice'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(closed,0);release();
    assert.equal((await result).ok,true);assert.equal(closed,1);
    assert.ok(f.calls.includes('listen'));
  });
}

test('failed playback receipt preserves the drawing board and its pixels', async()=>{
  let closed=0;
  const f=conversation({drawingBoard:{isOpen:true,close(){closed++;}},
    fetch:async url=>({ok:!url.endsWith('/complete'),json:async()=>({ok:!url.endsWith('/complete'),detail:'synthetic receipt failure'})}),
    consumeSse:async(_response,emit)=>emit({event:'done',assistant_text:'休息一下。',ok:true,commit_required:true,activity_transition:{action:'clear',activity:'drawing'}})});
  assert.equal((await f.c.sendStreamingRequest({endpoint:'/api/conversation/stream',body:new FormData(),source:'drawing-voice'})).ok,false);
  assert.equal(closed,0);
});

test('continuing drawing and automatic observations cannot close the board',async()=>{
  let closed=0;
  const f=conversation({drawingBoard:{isOpen:true,close(){closed++;}},
    consumeSse:async(_response,emit)=>emit({event:'done',assistant_text:'再添一笔。',ok:true,commit_required:true,activity_transition:{action:'set',activity:'drawing',step:3}})});
  assert.equal((await f.c.sendStreamingRequest({endpoint:'/api/conversation/stream',body:new FormData(),source:'drawing-voice'})).ok,true);
  f.c.consumeSse=async(_response,emit)=>emit({event:'done',assistant_text:'一条蓝线。',ok:true,commit_required:false,activity_transition:{action:'clear',activity:'drawing'}});
  assert.equal((await f.c.sendStreamingRequest({endpoint:'/api/conversation/stream',body:new FormData(),source:'drawing-observation'})).ok,true);
  assert.equal(closed,0);
});

for (const cancellation of ['pause', 'playback-replaced', 'request-replaced']) {
  test(`late successful receipt cannot close the board after ${cancellation}`, async () => {
    let closed = 0, releaseReceipt;
    const f = conversation({ drawingBoard: { isOpen: true, close() { closed++; } },
      fetch: async url => ({ ok: true, json: async () => url.endsWith('/complete')
        ? new Promise(resolve => { releaseReceipt = resolve; }) : { ok: true } }),
      consumeSse: async (_response, emit) => emit({ event: 'done', assistant_text: '来听故事。', ok: true,
        commit_required: true, activity_transition: { action: 'set', activity: 'story', step: 1 } }) });
    const pending = f.c.sendStreamingRequest({ endpoint: '/api/conversation/stream', body: new FormData(), source: 'drawing-voice' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseReceipt, 'function');
    if (cancellation === 'pause') { f.c.conversationActive = false; f.c.activeRequestController.abort(); }
    if (cancellation === 'playback-replaced') f.c.queueGeneration++;
    if (cancellation === 'request-replaced') f.c.activeRequestController = new AbortController();
    releaseReceipt({ ok: true });
    assert.equal((await pending).ok, false);
    assert.equal(closed, 0);
    assert.equal(f.calls.includes('listen'), false);
  });
}
