const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app.js'), 'utf8');

function setup(waiting) {
  const context = vm.createContext({avatarAcceptFrames: true,
    avatarAwaitingStreamStart: waiting, avatarEncodedQueue: [], avatarPumpTimer: 1,
    avatarNeedsKeyframe: true, pumpAvatarVideo() {}});
  vm.runInContext(source.slice(source.indexOf('function queueEncodedAvatarFrame('),
    source.indexOf('async function receiveAvatarBinary(')), context);
  return context;
}

test('a new streaming reply rejects late previous-reply deltas and periodic keyframes', () => {
  const c = setup(true);
  for (const frame of [{key:false,timestamp:1200000}, {key:true,timestamp:2000000}, {key:false,timestamp:0}]) {
    c.queueEncodedAvatarFrame(frame);
  }
  assert.equal(c.avatarEncodedQueue.length, 0);
  assert.equal(c.avatarAwaitingStreamStart, true);
  c.queueEncodedAvatarFrame({key:true,timestamp:0});
  c.queueEncodedAvatarFrame({key:false,timestamp:40000});
  assert.equal(c.avatarEncodedQueue.length, 2);
  assert.equal(c.avatarAwaitingStreamStart, false);
});

test('non-streaming recovery retains periodic keyframes and cancelled replies stay closed', () => {
  const c = setup(false);
  c.queueEncodedAvatarFrame({key:true,timestamp:2000000});
  assert.equal(c.avatarEncodedQueue.length, 1);
  c.avatarAcceptFrames = false;
  c.avatarAwaitingStreamStart = true;
  c.queueEncodedAvatarFrame({key:true,timestamp:0});
  assert.equal(c.avatarEncodedQueue.length, 1);
  assert.equal(c.avatarAwaitingStreamStart, true);
});
