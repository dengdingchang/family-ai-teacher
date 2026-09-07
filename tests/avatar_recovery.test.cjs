const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');

function setup() {
  let writes = 0;
  let label = '声音先开始，动作稍后恢复';
  const c = vm.createContext({
    avatarCanvas: { hidden: true, getContext: () => ({ drawImage() {} }) },
    avatarImage: {}, avatarFrameGeneration: 1, avatarAcceptFrames: true, avatarDrawing: false,
    avatarFrameSerial: 0, avatarFrameWaiters: [],
    avatarStateText: { get textContent() { return label; }, set textContent(value) { writes++; label = value; } },
    window: { createImageBitmap: true }, createImageBitmap: async () => ({ close() {} }),
    syncAvatarIdle() {}, clearTimeout,
  });
  for (const [start, end] of [
    ['function setAvatarState(', 'function waitForAvatarFrame('],
    ['async function drawAvatarFrame(', 'function ensureAvatarDecoder('],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), c);
  return { c, writes: () => writes };
}

for (const transport of ['JPEG', 'H264']) {
  test(`the first successful visible ${transport} frame clears stale fallback text without repeated DOM writes`, async () => {
    const { c, writes } = setup();
    let ready = false;
    c.avatarFrameWaiters.push({ afterSerial: 0, timer: null, resolve() { ready = true; } });
    const render = () => transport === 'JPEG'
      ? c.drawAvatarFrame({}) : c.showDecodedAvatarFrame({ close() {} });
    await render();
    assert.equal(c.avatarStateText.textContent, '准备好啦，可以一起说话');
    assert.equal(ready, true, 'frame readiness must retain its existing behavior');
    await render();
    assert.equal(writes(), 1, 'following frames must not rewrite the same label');
  });
}

test('failed, cancelled, or hidden frames do not claim that visible motion recovered', async () => {
  const { c, writes } = setup();
  c.createImageBitmap = async () => { throw new Error('bad frame'); };
  await c.drawAvatarFrame({});
  c.avatarAcceptFrames = false;
  c.showDecodedAvatarFrame({ close() {} });
  c.avatarAcceptFrames = true;
  c.syncAvatarIdle = () => { c.avatarCanvas.hidden = true; };
  c.showDecodedAvatarFrame({ close() {} });
  assert.equal(c.avatarStateText.textContent, '声音先开始，动作稍后恢复');
  assert.equal(writes(), 0);
});

function playbackSetup() {
  const { c } = setup();
  const timers = new Map(), events = [];
  let nextTimer = 0, started = false;
  Object.assign(c, {
    streamingAudioContext: {}, streamingPlayback: null, queueGeneration: 1,
    queuePlaybackError: null, avatarReady: true, avatarSocket: { readyState: 1 },
    WebSocket: { OPEN: 1 }, avatarAudioLeadMs: 900,
    avatarEncodedQueue: [], avatarNeedsKeyframe: true, avatarPumpTimer: null, avatarDecoder: null,
    activePlayback: null, activeAudio: null, activeAudioUrl: null,
    audioQueue: [], queueDraining: false, queueDrainWaiters: [],
    STREAM_AVATAR_FIRST_FRAME_WAIT_MS: 2000, atob, Uint8Array,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    sendAvatarEvent(event) { events.push(event.type); return true; },
    StreamingPcmPlayer: class {
      constructor(_context, options) {
        this.options = options;
        options.startGate.then(() => { if (!this.cancelled) started = true; });
      }
      enqueue() { this.options.onDecoded({ duration: 0.96 }); }
      cancel() { this.cancelled = true; }
      fail(error) { throw error; }
    },
  });
  for (const [start, end] of [
    ['function waitForAvatarFrame(', 'function avatarWebSocketUrl('],
    ['function flushAvatar(', 'async function playAudioPayload('],
    ['function enqueueStreamingAudio(', 'async function consumeSse('],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), c);
  return {
    c, events, started: () => started,
    async timeout(expectedDelay = 2000) {
      const [id, timer] = [...timers][0];
      assert.equal(timer.delay, expectedDelay, 'speech keeps the existing bounded first-frame wait');
      timers.delete(id);
      timer.callback();
      await new Promise(resolve => setImmediate(resolve));
    },
    chunk(sequence) {
      c.enqueueStreamingAudio({ sequence, audio_stream: true, audio_base64: 'AA==', avatar_pcm_base64: 'AA==' });
    },
  };
}

test('negotiated streaming keeps one begin/end around all PCM and does not end a cancelled generation', () => {
  const f = playbackSetup();
  f.c.avatarSocket.supportsAudioStream = true;
  f.chunk(1);
  f.chunk(2);
  f.c.streamingPlayback.finishInput();
  f.c.streamingPlayback.finishInput();
  assert.deepEqual(f.events, ['flush', 'audio_begin', 'audio', 'audio', 'audio_end']);
  const cancelled = playbackSetup();
  cancelled.c.avatarSocket.supportsAudioStream = true;
  cancelled.chunk(1);
  cancelled.c.queueGeneration++;
  cancelled.c.streamingPlayback.finishInput();
  assert.equal(cancelled.events.includes('audio_end'), false);
});

test('first-frame timeout starts speech, keeps later PCM flowing, and recovers visible motion until cancellation', async () => {
  const f = playbackSetup();
  f.chunk(1);
  assert.equal(f.started(), false);
  await f.timeout();
  assert.equal(f.started(), true, 'slow video must not hold speech indefinitely');
  f.chunk(2);
  assert.deepEqual(f.events, ['flush', 'audio', 'audio'], 'timeout must not cancel this turn or drop later PCM');
  assert.equal(f.c.avatarStateText.textContent, '声音先开始，动作稍后恢复');
  for (let index = 0; index < 2; index++) f.c.showDecodedAvatarFrame({ close() {} });
  assert.equal(f.c.avatarFrameSerial, 2, 'late frames must actually be drawn');
  assert.equal(f.c.avatarCanvas.hidden, false);
  assert.equal(f.c.avatarStateText.textContent, '准备好啦，可以一起说话');
  f.c.cancelPlayback();
  f.c.showDecodedAvatarFrame({ close() {} });
  assert.equal(f.c.avatarFrameSerial, 2, 'explicit cancellation must still discard late frames');
  assert.equal(f.c.avatarCanvas.hidden, true);
});

test('cancelling during the first-frame wait cannot start speech or revive the old avatar', async () => {
  const f = playbackSetup();
  f.chunk(1);
  f.c.clearResponseQueue();
  f.c.cancelPlayback();
  f.c.setAvatarState('交流已结束');
  await new Promise(resolve => setImmediate(resolve));
  f.c.showDecodedAvatarFrame({ close() {} });
  assert.equal(f.started(), false);
  assert.equal(f.c.avatarFrameSerial, 0);
  assert.equal(f.c.avatarCanvas.hidden, true);
  assert.equal(f.c.avatarStateText.textContent, '交流已结束');
});

test('complete WAV playback also accepts a late first frame without delaying or cancelling speech', async () => {
  const f = playbackSetup();
  let played = false, elapsed = 0;
  Object.assign(f.c, {
    Blob, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    performance: { now: () => elapsed },
    Audio: class extends EventTarget {
      play() { played = true; return Promise.resolve(); }
      pause() {} removeAttribute() {} load() {}
    },
  });
  vm.runInContext(source.slice(source.indexOf('async function playAudioPayload('),
    source.indexOf('async function drainResponseQueue(')), f.c);
  const pending = f.c.playAudioPayload({ audio_base64: 'AA==', avatar_pcm_base64: 'AA==' }, 1);
  assert.equal(played, false);
  elapsed = 1500;
  await f.timeout(1500);
  assert.equal(played, true);
  assert.deepEqual(f.events, ['flush', 'audio']);
  f.c.showDecodedAvatarFrame({ close() {} });
  assert.equal(f.c.avatarCanvas.hidden, false);
  assert.equal(f.c.avatarFrameSerial, 1);
  f.c.activeAudio.dispatchEvent(new Event('ended'));
  await pending;
  assert.equal(f.c.activeAudio, null);
});

test('a cancelled WAV first-frame waiter cannot hide the next turn or replace its status', async () => {
  const f = playbackSetup();
  Object.assign(f.c, {
    Blob, URL: { createObjectURL: () => 'blob:old', revokeObjectURL() {} },
    performance: { now: () => 0 }, avatarAudioLeadMs: 0,
    Audio: class extends EventTarget {
      play() { throw new Error('cancelled audio must not start'); }
      pause() {} removeAttribute() {} load() {}
    },
  });
  vm.runInContext(source.slice(source.indexOf('async function playAudioPayload('),
    source.indexOf('async function drainResponseQueue(')), f.c);
  const old = f.c.playAudioPayload({ audio_base64: 'AA==', avatar_pcm_base64: 'AA==' }, 1);
  f.c.clearResponseQueue();
  f.c.cancelPlayback();
  const nextAudio = {};
  f.c.activeAudio = nextAudio;
  f.c.avatarAcceptFrames = true;
  f.c.showDecodedAvatarFrame({ close() {} });
  await old;
  assert.equal(f.c.activeAudio, nextAudio);
  assert.equal(f.c.avatarCanvas.hidden, false, 'old wait result must not hide the new turn');
  assert.equal(f.c.avatarStateText.textContent, '准备好啦，可以一起说话');
});
