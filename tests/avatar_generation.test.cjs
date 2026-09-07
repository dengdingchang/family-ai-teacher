const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }

test('current-turn JPEG still renders and signals readiness', async () => {
  let drawn = 0;
  let marked = 0;
  let closed = 0;
  const context = vm.createContext({
    avatarFrameGeneration: 1, avatarAcceptFrames: true, avatarDrawing: false,
    avatarCanvas: { getContext: () => ({ drawImage() { drawn++; } }) },
    avatarImage: {}, window: { createImageBitmap: true },
    createImageBitmap: async () => ({ close() { closed++; } }),
    markAvatarFrame() { marked++; }, syncAvatarIdle() {},
  });
  vm.runInContext(extract('async function drawAvatarFrame(', 'function showDecodedAvatarFrame('), context);
  await context.drawAvatarFrame({});
  assert.equal(drawn, 1);
  assert.equal(marked, 1);
  assert.equal(closed, 1);
});

test('binary work from a flushed turn cannot enter a new turn', async () => {
  let release;
  let drawn = 0;
  const context = vm.createContext({
    avatarFrameGeneration: 1, avatarAcceptFrames: true,
    DataView, Uint8Array, drawAvatarFrame: async () => { drawn++; },
  });
  vm.runInContext(extract('async function receiveAvatarBinary(', 'function scheduleAvatarReconnect('), context);
  const pending = context.receiveAvatarBinary({ arrayBuffer: () => new Promise(resolve => { release = resolve; }) });
  context.avatarFrameGeneration++;
  release(new ArrayBuffer(0));
  await pending;
  assert.equal(drawn, 0);
});

test('an asynchronously decoded JPEG is released but never drawn after flush', async () => {
  let release;
  let drawn = 0;
  let closed = 0;
  const context = vm.createContext({
    avatarFrameGeneration: 1, avatarAcceptFrames: true, avatarDrawing: false,
    avatarCanvas: { getContext: () => ({ drawImage() { drawn++; } }) },
    avatarImage: {}, window: { createImageBitmap: true },
    createImageBitmap: () => new Promise(resolve => { release = resolve; }),
    markAvatarFrame() { throw Error('stale frame marked as ready'); }, syncAvatarIdle() {},
  });
  vm.runInContext(extract('async function drawAvatarFrame(', 'function showDecodedAvatarFrame('), context);
  const pending = context.drawAvatarFrame({});
  context.avatarFrameGeneration++;
  release({ close() { closed++; } });
  await pending;
  assert.equal(drawn, 0);
  assert.equal(closed, 1);
});

test('flush cancels the old pump so a new keyframe decodes immediately without replaying old frames', () => {
  const timers = new Map();
  let nextTimer = 1;
  const decoded = [];
  const drawn = [];
  let resets = 0;
  const context = vm.createContext({
    avatarFrameGeneration: 1, avatarAcceptFrames: true,
    avatarEncodedQueue: [], avatarNeedsKeyframe: true, avatarPumpTimer: null,
    avatarAwaitingStreamStart: false,
    avatarCanvas: { getContext: () => ({ drawImage(frame) { drawn.push(frame.timestamp); } }) },
    avatarImage: {}, syncAvatarIdle() {}, markAvatarFrame() {}, sendAvatarEvent() {},
    ensureAvatarDecoder: () => true,
    EncodedVideoChunk: class { constructor(options) { Object.assign(this, options); } },
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  context.avatarDecoder = {
    state: 'configured',
    reset() { resets++; },
    decode(chunk) {
      decoded.push(chunk.timestamp);
      context.showDecodedAvatarFrame({ timestamp: chunk.timestamp, close() {} });
    },
  };
  vm.runInContext(extract('function showDecodedAvatarFrame(', 'function ensureAvatarDecoder('), context);
  vm.runInContext(extract('function pumpAvatarVideo(', 'async function receiveAvatarBinary('), context);
  vm.runInContext(extract('function flushAvatar(', 'function cueAvatar('), context);
  const frame = (timestamp, key) => ({ timestamp, key, data: new Uint8Array([1]) });

  context.queueEncodedAvatarFrame(frame(0, true));
  const oldTimer = context.avatarPumpTimer;
  context.queueEncodedAvatarFrame(frame(40000, false));
  assert.equal(timers.has(oldTimer), true);
  assert.equal(context.avatarEncodedQueue.length, 1);

  context.flushAvatar();
  context.avatarAcceptFrames = true;
  context.queueEncodedAvatarFrame(frame(80000, true));
  assert.deepEqual(decoded, [0, 80000], 'the new keyframe must decode before any timer fires');
  assert.equal(timers.has(oldTimer), false);
  assert.equal(resets, 1);

  // Run the remaining scheduled pump: the discarded old delta must never return.
  for (const [id, callback] of [...timers]) {
    timers.delete(id);
    callback();
  }
  assert.deepEqual(decoded, [0, 80000]);
  assert.deepEqual(drawn, [0, 80000]);
  assert.equal(context.avatarEncodedQueue.length, 0);
});
