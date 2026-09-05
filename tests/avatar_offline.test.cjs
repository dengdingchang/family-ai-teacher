const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');

test('offline avatars never add a remote audio lead or accept stale frames', () => {
  const fn = source.slice(source.indexOf('function cueAvatar('), source.indexOf('function resolveQueueWaiters('));
  for (const [ready, state] of [[false, 1], [true, 3], [false, 3]]) {
    const c = vm.createContext({ avatarReady: ready, avatarSocket: {readyState: state},
      WebSocket: {OPEN: 1}, avatarAcceptFrames: true, avatarAudioLeadMs: 900 });
    vm.runInContext(fn, c);
    assert.equal(vm.runInContext('cueAvatar({avatar_cued:true, avatar_audio_lead_ms:900})', c), 0);
    assert.equal(c.avatarAcceptFrames, false);
    assert.equal(vm.runInContext('cueAvatar({avatar_pcm_base64:"audio"})', c), 0);
  }
});

test('healthy remote avatar keeps the configured synchronization lead', () => {
  const fn = source.slice(source.indexOf('function cueAvatar('), source.indexOf('function resolveQueueWaiters('));
  const c = vm.createContext({avatarReady: true, avatarSocket: {readyState: 1},
    WebSocket: {OPEN: 1}, avatarAcceptFrames: false, avatarAudioLeadMs: 900});
  vm.runInContext(fn, c);
  assert.equal(vm.runInContext('cueAvatar({avatar_cued:true, avatar_audio_lead_ms:700})', c), 700);
  assert.equal(c.avatarAcceptFrames, true);
});

test('renderer error releases frame wait immediately and reconnects via close cleanup', () => {
  const fn = source.slice(source.indexOf('function connectAvatar()'), source.indexOf('function sendAvatarEvent('));
  const handlers = {};
  let cancelled = 0, reconnected = 0, reset = 0;
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 1;
    addEventListener(name, fn) { handlers[name] = fn; }
    close() { this.readyState = 3; handlers.close(); }
  }
  const c = vm.createContext({avatarSocket: null, WebSocket: Socket, Blob,
    avatarReady: false, avatarAcceptFrames: true, avatarFrameGeneration: 0,
    avatarEncodedQueue: [1], avatarNeedsKeyframe: false, avatarPumpTimer: null,
    avatarDecoder: {state:'configured', reset(){ reset++; }},
    avatarReconnectDelayMs: 1200, avatarWebSocketUrl: () => 'ws://localhost/test',
    setAvatarState(){}, syncAvatarIdle(){}, cancelAvatarFrameWaiters(){ cancelled++; },
    scheduleAvatarReconnect(){ reconnected++; }, receiveAvatarBinary(){},
  });
  vm.runInContext(fn, c);
  vm.runInContext('connectAvatar()', c);
  handlers.message({data: JSON.stringify({type:'ready'})});
  assert.equal(c.avatarReady, true);
  handlers.message({data: JSON.stringify({type:'error'})});
  assert.equal(c.avatarReady, false);
  assert.equal(c.avatarAcceptFrames, false);
  assert.equal(c.avatarSocket, null);
  assert.ok(cancelled >= 1);
  assert.equal(reconnected, 1);
  assert.equal(reset, 1);
  assert.equal(c.avatarEncodedQueue.length, 0);
});
