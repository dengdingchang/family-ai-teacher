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
