const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const nextTick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = () => ({ ok: true, json: async () => ({ audio_base64: 'AA==', audio_mime: 'audio/wav' }) });

function fixture(overrides = {}) {
  const requests = [], plays = [], calls = [];
  const c = vm.createContext({
    AbortController, setTimeout, clearTimeout, performance,
    chessBoard: { isOpen: true }, chessSpeechController: null, chessSpeechGeneration: 0, chessOpenGeneration: 0,
    drawingBoard: null, conversationActive: true, conversationStarting: false,
    activeRequestController: null, activeRequestSource: '', activeTurnId: null, interruptedRequestController: null,
    mediaResumePending: false,
    queueGeneration: 0, segmentRecording: true, segmentShouldSend: true, segmentPcmChunks: ['unfinished'],
    speechStartedAt: 0, loudSince: 0, bargeInMonitoring: false, bargeInPcmChunks: [], recordHint: {},
    activityEnabled: name => name === 'game' || name === 'drawing',
    interruptActiveReply: async () => {},
    stopVadLoop() { calls.push('pause'); },
    startBargeInMonitor() { c.bargeInMonitoring = true; },
    stopBargeInMonitor() { c.bargeInMonitoring = false; },
    clearResponseQueue() { c.queueGeneration++; },
    cancelPlayback() { for (const play of plays) if (!play.done) { play.done = true; play.wait.resolve(); } },
    beginContinuousSegment(chunks = [], speaking = false) {
      calls.push('listen'); c.segmentRecording = true; c.segmentPcmChunks = chunks; c.speechStartedAt = speaking ? 100 : 0;
    },
    setBusy(busy) { calls.push(['busy', busy]); }, setStatus(message, state) { calls.push(['status', state]); },
    prepareStreamingAudio: async () => true,
    fetch(url, options) { const wait = deferred(); requests.push({ url, options, wait }); return wait.promise; },
    playAudioPayload(payload, generation) {
      const wait = deferred(); plays.push({ payload, generation, wait, owner: c.activeRequestController }); return wait.promise;
    },
    ...overrides,
  });
  vm.runInContext(section('function cancelChessExplanation(', 'function getDrawingBoard('), c);
  return { c, requests, plays, calls, speak: text => c.speakChessInstruction(text) };
}

test('a factual chess instruction uses only TTS and resumes the existing microphone after playback', async () => {
  const f = fixture(), pending = f.speak('白兵从 e2 走到 e3。');
  await nextTick();
  assert.equal(f.c.segmentRecording, false);
  assert.equal(f.c.segmentPcmChunks.length, 0);
  assert.equal(f.c.segmentShouldSend, false);
  assert.equal(f.c.activeTurnId, null);
  assert.equal(f.c.activeRequestSource, 'chess-explanation');
  assert.equal(f.requests[0].url, '/api/tts');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { text: '白兵从 e2 走到 e3。' });
  f.requests[0].wait.resolve(response()); await nextTick();
  assert.equal(f.plays.length, 1);
  assert.equal(f.calls.includes('listen'), false);
  f.plays[0].wait.resolve(); assert.equal((await pending).ok, true);
  assert.equal(f.c.activeRequestController, null);
  assert.equal(f.c.segmentRecording, true);
  assert.deepEqual(f.requests.map(item => item.url), ['/api/tts']);
});

test('a newer explanation aborts an old fetch and ignores its late payload', async () => {
  const f = fixture(), first = f.speak('白兵向前走。'); await nextTick();
  const second = f.speak('白车沿直线走。'); await nextTick();
  assert.equal(f.requests[0].options.signal.aborted, true);
  f.requests[0].wait.resolve(response()); assert.equal((await first).aborted, true);
  assert.equal(f.plays.length, 0);
  assert.equal(f.c.activeRequestController, f.c.chessSpeechController);
  f.requests[1].wait.resolve(response()); await nextTick();
  f.plays[0].wait.resolve(); assert.equal((await second).ok, true);
  assert.equal(f.calls.filter(item => item === 'listen').length, 1);
});

test('new explanation cancels current sound; closing cancels the replacement without clearing a newer conversation', async () => {
  const f = fixture(), first = f.speak('白兵向前走。'); await nextTick();
  f.requests[0].wait.resolve(response()); await nextTick();
  const second = f.speak('白车沿直线走。'); await nextTick();
  assert.equal(f.plays[0].done, true); assert.equal((await first).aborted, true);
  f.c.chessBoard.isOpen = false; f.c.cancelChessExplanation(true);
  assert.equal(f.requests[1].options.signal.aborted, true);
  const nextController = new AbortController();
  f.c.activeRequestController = nextController;
  f.c.activeRequestSource = 'new-child-turn';
  const generation = f.c.queueGeneration;
  f.requests[1].wait.resolve(response()); assert.equal((await second).aborted, true);
  assert.equal(f.c.activeRequestController, nextController);
  assert.equal(f.c.activeRequestSource, 'new-child-turn');
  assert.equal(f.c.queueGeneration, generation);
});

test('the actual barge-in hook stops chess sound and preserves the new child preroll', async () => {
  const f = fixture(), cancellations = [];
  f.c.cancelConversationTurn = id => { if (id) cancellations.push(id); };
  vm.runInContext(section('function triggerBargeIn()', 'function checkBargeIn()'), f.c);
  const pending = f.speak('白马可以跳过棋子。'); await nextTick();
  f.requests[0].wait.resolve(response()); await nextTick();
  f.c.bargeInPcmChunks = ['first-child-syllable'];
  f.c.triggerBargeIn();
  assert.equal((await pending).aborted, true);
  assert.equal(f.c.segmentRecording, true);
  assert.deepEqual(Array.from(f.c.segmentPcmChunks), ['first-child-syllable']);
  assert.equal(f.c.speechStartedAt, 100);
  assert.equal(f.c.activeRequestController, null);
  assert.deepEqual(cancellations, []);
  const explanation = await f.speak('黑兵从 e7 走到 e5。');
  assert.equal(explanation.ok, false);
  assert.match(explanation.error, /先听你说/);
  assert.equal(f.requests.length, 1, 'an automatic opponent explanation must not start new TTS during child speech');
  assert.deepEqual(Array.from(f.c.segmentPcmChunks), ['first-child-syllable']);
  assert.equal(f.c.speechStartedAt, 100);
});

test('voice failure remains retryable without microphone permission or family requests', async () => {
  const f = fixture({ conversationActive: false, segmentRecording: false });
  const pending = f.speak('白王每次走一格。'); await nextTick();
  f.requests[0].wait.reject(new Error('private detail'));
  const failed = await pending;
  assert.equal(failed.ok, false); assert.match(failed.error, /再听一遍/);
  assert.doesNotMatch(failed.error, /private/);
  assert.equal(f.calls.includes('listen'), false);
  const retry = f.speak('白王每次走一格。'); await nextTick();
  f.requests[1].wait.resolve(response()); await nextTick();
  f.plays[0].wait.resolve(); assert.equal((await retry).ok, true);
});

test('opening chess is independent of microphone permission and closes drawing first', async () => {
  const f = fixture({ conversationActive: false, chessBoard: null });
  let permissionAttempts = 0;
  f.c.startContinuousConversation = async () => { permissionAttempts++; throw new Error('microphone denied'); };
  let closed = false;
  f.c.drawingBoard = { close() { closed = true; } };
  f.c.ChessBoard = class {
    constructor(options) { this.options = options; }
    open() { assert.equal(closed, true); this.isOpen = true; }
  };
  await f.c.openChessActivity();
  assert.equal(f.c.chessBoard.isOpen, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.c.conversationActive, false);
  assert.equal(permissionAttempts, 1);
  f.c.activityEnabled = () => false; f.c.chessBoard = null;
  await f.c.openChessActivity(); assert.equal(f.c.chessBoard, null);
});

test('parent-disabled, oversized, and pending-permission speech never dispatches TTS', async () => {
  for (const overrides of [{ activityEnabled: () => false }, { conversationStarting: true }, {}]) {
    const f = fixture(overrides);
    const result = await f.speak(Object.keys(overrides).length ? '白兵向前走。' : '字'.repeat(201));
    assert.equal(result.ok, false); assert.equal(f.requests.length, 0);
  }
});

test('a missing optional chess module is a caught local error, not an application startup dependency', async () => {
  const f = fixture({ chessBoard: null, conversationActive: false });
  await f.c.openChessActivity(); // VM has no dynamic-import callback, modelling an unavailable module.
  assert.equal(f.c.chessBoard, null);
  assert.match(f.c.recordHint.textContent, /棋盘暂时没打开/);
  assert.equal(f.requests.length, 0);
});

test('automatic chess explanations cannot cancel an in-flight child STT, model, or playback request', async () => {
  for (const phase of ['stt', 'model', 'playback']) {
    const f = fixture({ segmentRecording: false }), previous = new AbortController();
    f.c.activeRequestController = previous; f.c.activeTurnId = 'previous-real-turn';
    f.c.activeRequestSource = '';
    const forbidden = () => { throw new Error(`must preserve the child ${phase}`); };
    f.c.cancelConversationTurn = forbidden;
    f.c.interruptActiveReply = forbidden;
    const result = await f.speak('黑兵从 e7 走到 e5。');
    assert.equal(result.ok, false); assert.match(result.error, /再听一遍/);
    assert.equal(previous.signal.aborted, false);
    assert.equal(f.c.activeRequestController, previous);
    assert.equal(f.c.activeTurnId, 'previous-real-turn');
    assert.equal(f.requests.length, 0); assert.equal(f.plays.length, 0);
    assert.equal(f.c.segmentRecording, false);
  }
});

test('an actual child request survives a late automatic opponent explanation', async () => {
  const f = fixture(), previous = new AbortController();
  f.c.segmentRecording = false;
  f.c.activeRequestController = previous; f.c.activeTurnId = 'previous-real-turn';
  const cancelled = [];
  f.c.cancelConversationTurn = id => cancelled.push(id);
  vm.runInContext(section('async function interruptActiveReply()', 'function cancelChessExplanation('), f.c);
  previous.signal.addEventListener('abort', () => { f.c.activeRequestController = null; });
  const pending = f.speak('黑兵从 e7 走到 e5。'); await nextTick();
  assert.equal(previous.signal.aborted, false);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(cancelled, []);
  assert.equal((await pending).ok, false);
});

test('a fresh chess click opens continuous voice and resumes listening after the initial explanation', async () => {
  const f = fixture({ conversationActive: false, chessBoard: null, segmentRecording: false });
  const permission = deferred(); let starts = 0, spoken;
  f.c.startContinuousConversation = async () => {
    starts++; f.c.conversationStarting = true;
    await permission.promise;
    f.c.conversationStarting = false; f.c.conversationActive = true; f.c.beginContinuousSegment();
  };
  f.c.ChessBoard = class {
    constructor(options) { this.options = options; }
    open() { this.isOpen = true; spoken = this.options.onSpeak('白兵每次向前走。'); }
  };
  const opening = f.c.openChessActivity(); await nextTick();
  assert.equal(starts, 1); assert.equal(f.requests.length, 0);
  permission.resolve(); await opening; await nextTick();
  assert.equal(f.c.chessBoard.isOpen, true); assert.equal(f.c.conversationActive, true);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/tts');
  f.requests[0].wait.resolve(response()); await nextTick();
  assert.equal(f.plays.length, 1);
  f.plays[0].wait.resolve(); assert.equal((await spoken).ok, true);
  assert.equal(f.c.segmentRecording, true);
  assert.equal(f.c.activeRequestController, null);
  assert.equal(starts, 1);
});

test('a superseded or parent-disabled chess entry is not opened after microphone permission resolves', async () => {
  for (const scenario of ['superseded', 'disabled']) {
    const f = fixture({ conversationActive: false, chessBoard: null });
    const permission = deferred(); let opened = 0;
    f.c.startContinuousConversation = () => permission.promise;
    f.c.ChessBoard = class { open() { opened++; } };
    const pending = f.c.openChessActivity(); await nextTick();
    assert.equal(opened, 0);
    if (scenario === 'superseded') f.c.chessOpenGeneration++;
    else f.c.activityEnabled = () => false;
    permission.resolve(); await pending;
    assert.equal(opened, 0);
    assert.equal(f.requests.length, 0);
  }
});

test('the shared WAV player does not extend interaction timing for an automatic chess explanation', async () => {
  let timed = 0;
  const c = vm.createContext({
    queueGeneration: 1, activeRequestSource: 'chess-explanation',
    atob, Uint8Array, Blob, URL, performance, setTimeout, clearTimeout,
    activeAudioUrl: null, activeAudio: null, activePlayback: null, avatarFrameSerial: 0, avatarReady: false,
    familyInteractionClock: { sessionId: 'prior-conversation', playbackEnded() { timed++; } },
    cueAvatar: () => 0,
    Audio: class extends EventTarget {
      play() { queueMicrotask(() => this.dispatchEvent(new Event('ended'))); return Promise.resolve(); }
      pause() {} removeAttribute() {} load() {}
    },
  });
  vm.runInContext(section('async function playAudioPayload(', 'async function drainResponseQueue('), c);
  await c.playAudioPayload({ audio_base64: 'AA==', audio_mime: 'audio/wav' }, 1);
  assert.equal(timed, 0);
  c.activeRequestSource = '';
  await c.playAudioPayload({ audio_base64: 'AA==', audio_mime: 'audio/wav' }, 1);
  assert.equal(timed, 1, 'normal completed conversations retain their timing hook');
});

test('SSE chess redirect opens only after releasing the conversation controller and never commits stale audio', async () => {
  const f = fixture({ chessBoard: null, conversationActive: false, segmentRecording: false });
  const events = [], forbidden = () => { throw new Error('no transcript history, audio, or receipt on chess redirect'); };
  Object.assign(f.c, {
    FormData, Blob, DOMException, avatarReady: false,
    createConversationTurnId: () => 'synthetic-chess-intent',
    resetLiveTurn() {}, hideLiveTurn() {},
    consumeSse: async (_response, emit) => {
      emit({ event: 'chess_request', text: '我想学国际象棋' });
      emit({ event: 'audio', audio_base64: 'AA==' });
      emit({ event: 'done', assistant_text: 'old game text', history: {} });
    },
    enqueueAudio: forbidden, appendHistoryRecord: forbidden, completeConversationTurn: forbidden,
    cancelConversationTurn: forbidden, waitForAudioQueue: forbidden,
    openChessActivity() { assert.equal(f.c.activeRequestController, null); events.push('open'); },
  });
  vm.runInContext(section('async function sendStreamingRequest(', 'async function sendText('), f.c);
  const pending = f.c.sendStreamingRequest({ endpoint: '/synthetic-intent', body: '{}' });
  await nextTick(); f.requests[0].wait.resolve({ ok: true });
  const result = await pending;
  assert.equal(result.chess, true); assert.deepEqual(events, ['open']);
  assert.deepEqual(f.requests.map(item => item.url), ['/synthetic-intent']);
});

function conversationFixture(overrides = {}) {
  const f = fixture({ conversationActive: false, segmentRecording: false, ...overrides });
  Object.assign(f.c, {
    FormData, Blob, DOMException, avatarReady: false,
    answerBox: { classList: { add() {} } }, liveTurn: {},
    createConversationTurnId: () => 'synthetic-chess-context',
    resetLiveTurn() {}, hideLiveTurn() {}, cancelConversationTurn() {},
    loadMediaSuggestions() {},
    waitForAudioQueue: async () => {},
    consumeSse: async (_response, emit) => emit({ event: 'done', assistant_text: '这是模拟棋盘回答。', ok: true }),
  });
  vm.runInContext(section('async function sendStreamingRequest(', 'function stopVadLoop()'), f.c);
  return f;
}

async function dispatchedConversation(f, entry) {
  const pending = entry === 'audio'
    ? f.c.sendAudio(new Blob(['synthetic-audio'], { type: 'audio/wav' }))
    : f.c.sendText('  这个马可以走哪里？  ');
  await nextTick();
  assert.equal(f.requests.length, 1);
  f.requests[0].wait.resolve({ ok: true });
  await pending;
  assert.equal(f.calls.some(item => Array.isArray(item) && item[0] === 'status' && item[1] === 'offline'), false);
  return f.requests[0];
}

test('real text and audio sends carry only the open board current bounded facts', async () => {
  const facts = '当前白方行棋；白马在g1，合法走法g1-f3。';
  for (const entry of ['text', 'audio']) {
    let reads = 0;
    const f = conversationFixture({ chessBoard: {
      isOpen: true, getConversationContext() { reads++; return facts + '事实'.repeat(1800); },
    } });
    const request = await dispatchedConversation(f, entry);
    assert.equal(reads, 1);
    if (entry === 'text') {
      assert.equal(request.url, '/api/conversation/text/stream');
      const body = JSON.parse(request.options.body);
      assert.equal(body.text, '这个马可以走哪里？');
      assert.equal(body.chess_context, (facts + '事实'.repeat(1800)).slice(0, 3000));
      assert.deepEqual(Object.keys(body).sort(), ['chess_context', 'text']);
    } else {
      assert.equal(request.url, '/api/conversation/stream');
      assert.equal(request.options.body.get('chess_context'), (facts + '事实'.repeat(1800)).slice(0, 3000));
      assert.equal(await request.options.body.get('audio').text(), 'synthetic-audio');
      assert.equal(request.options.body.has('frame'), false);
    }
  }
});

test('closed, unavailable, empty, or parent-disabled boards preserve the old request shapes', async () => {
  const unexpected = () => { throw new Error('closed or disabled boards must not be read'); };
  for (const overrides of [
    { chessBoard: { isOpen: false, getConversationContext: unexpected } },
    { chessBoard: null },
    { chessBoard: { isOpen: true } },
    { chessBoard: { isOpen: true, getConversationContext: () => '  ' } },
    { chessBoard: { isOpen: true, getConversationContext: unexpected }, activityEnabled: () => false },
  ]) {
    for (const entry of ['text', 'audio']) {
      const request = await dispatchedConversation(conversationFixture(overrides), entry);
      if (entry === 'text') assert.deepEqual(JSON.parse(request.options.body), { text: '这个马可以走哪里？' });
      else assert.equal(request.options.body.has('chess_context'), false);
    }
  }
});

test('closing the board while audio setup waits does not send stale chess context', async () => {
  for (const entry of ['text', 'audio']) {
    const setup = deferred();
    const f = conversationFixture({
      chessBoard: { isOpen: true, getConversationContext() { throw new Error('already closed'); } },
      prepareStreamingAudio: () => setup.promise,
    });
    const pending = entry === 'audio' ? f.c.sendAudio(new Blob(['synthetic'], { type: 'audio/wav' }))
      : f.c.sendText('我想聊点别的');
    await nextTick();
    assert.equal(f.requests.length, 0);
    f.c.chessBoard.isOpen = false;
    setup.resolve(true);
    await nextTick();
    assert.equal(f.requests.length, 1);
    const body = f.requests[0].options.body;
    assert.equal(entry === 'audio' ? body.has('chess_context') : Object.hasOwn(JSON.parse(body), 'chess_context'), false);
    f.requests[0].wait.resolve({ ok: true });
    await pending;
  }
});

test('leaving chess closes the board only after playback and a successful activity receipt', async () => {
  for (const transition of [{ action: 'clear' }, { action: 'set', activity: 'story', step: 1 },
    { action: 'set', activity: 'game', step: 1 }]) {
    let closed = 0, completed = 0;
    const playback = deferred(), receipt = deferred();
    const f = conversationFixture({ chessBoard: { isOpen: true,
      getConversationContext: () => '当前棋盘：白方走。',
      close() { this.isOpen = false; closed++; },
    } });
    f.c.waitForAudioQueue = () => playback.promise;
    f.c.completeConversationTurn = () => { completed++; return receipt.promise; };
    f.c.consumeSse = async (_response, emit) => emit({ event: 'done', assistant_text: '开始新的活动。',
      ok: true, commit_required: true, activity_transition: transition });
    const pending = f.c.sendStreamingRequest({ endpoint: '/api/conversation/text/stream', body: '{"text":"我想听故事"}' });
    await nextTick(); f.requests[0].wait.resolve({ ok: true }); await nextTick();
    assert.equal(completed, 0); assert.equal(closed, 0);
    playback.resolve(); await nextTick();
    assert.equal(completed, 1); assert.equal(closed, 0);
    receipt.resolve({ ok: true });
    assert.equal((await pending).ok, true);
    assert.equal(closed, 1);
  }
});

test('ordinary chess questions, failed receipts, cancelled playback, and reopened boards stay open', async () => {
  for (const scenario of ['question', 'failed', 'cancelled', 'reopened']) {
    let closed = 0;
    const playback = deferred();
    const f = conversationFixture({ chessBoard: { isOpen: true,
      getConversationContext: () => '当前棋盘：白方走。', close() { closed++; this.isOpen = false; },
    } });
    f.c.consumeSse = async (_response, emit) => emit({ event: 'done', assistant_text: '这是模拟回答。',
      ok: true, commit_required: true, activity_transition: scenario === 'question' ? null : { action: 'clear' } });
    f.c.waitForAudioQueue = () => playback.promise;
    f.c.completeConversationTurn = async () => {
      if (scenario === 'failed') throw new Error('simulated receipt failure');
      assert.notEqual(scenario, 'cancelled');
      return { ok: true };
    };
    const pending = f.c.sendStreamingRequest({ endpoint: '/api/conversation/text/stream', body: '{"text":"模拟孩子提问"}' });
    await nextTick(); f.requests[0].wait.resolve({ ok: true }); await nextTick();
    if (scenario === 'cancelled') f.c.activeRequestController.abort();
    if (scenario === 'reopened') f.c.chessOpenGeneration++;
    playback.resolve();
    const result = await pending;
    assert.equal(result.ok, scenario === 'question' || scenario === 'reopened');
    assert.equal(closed, 0, scenario);
    assert.equal(f.c.chessBoard.isOpen, true);
  }
});
