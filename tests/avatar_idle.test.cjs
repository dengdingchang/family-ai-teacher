const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }

function setup(available = true) {
  const events = {}, documentEvents = {}, motionEvents = {};
  const video = { hidden: true, paused: true, currentTime: 1, readyState: 0, loads: 0,
    addEventListener(name, fn) { events[name] = fn; },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    load() { this.loads++; }, removeAttribute(name) { delete this[name]; },
  };
  const c = vm.createContext({
    avatarIdle: video, avatarIdleReady: false, avatarIdleFailed: false, avatarIdleConfigured: false,
    avatarCanvas: { hidden: true, getContext: () => ({ drawImage() {} }) },
    avatarImage: { hidden: false }, avatarStage: { dataset: { state: 'idle' } },
    avatarAcceptFrames: false, avatarFrameGeneration: 0, avatarEncodedQueue: [],
    avatarNeedsKeyframe: false, avatarDecoder: null,
    avatarReducedMotion: { matches: false, addEventListener(name, fn) { motionEvents[name] = fn; } },
    document: { hidden: false, addEventListener(name, fn) { documentEvents[name] = fn; } },
    window: { addEventListener() {} }, statusText: {}, dot: { classList: { toggle() {} } },
    sendAvatarEvent() {}, markAvatarFrame() {},
  });
  vm.runInContext(extract('function setStatus(', 'function setBusy('), c);
  vm.runInContext(extract('function showDecodedAvatarFrame(', 'function ensureAvatarDecoder('), c);
  vm.runInContext(extract('function flushAvatar()', 'function cueAvatar('), c);
  c.initializeAvatarIdle();
  if (available) c.setAvatarIdleAvailable(true);
  return { c, events, documentEvents, motionEvents, video };
}

test('photo covers loading, idle states loop, real speaking frames replace it and cancellation restores idle', () => {
  const { c, events, video } = setup();
  assert.equal(c.avatarImage.hidden, false);
  events.loadeddata();
  for (const state of ['idle', 'listening', 'thinking']) {
    c.setStatus('', state);
    assert.equal(video.hidden, false);
    assert.equal(video.paused, false);
    assert.equal(c.avatarCanvas.hidden, true);
    assert.equal(c.avatarImage.hidden, true);
  }
  c.setStatus('', 'speaking');
  assert.equal(video.hidden, true);
  assert.equal(video.paused, true);
  assert.equal(c.avatarImage.hidden, false);
  c.avatarAcceptFrames = true;
  let closed = 0;
  c.showDecodedAvatarFrame({ close() { closed++; } });
  assert.equal(closed, 1);
  assert.equal(c.avatarCanvas.hidden, false);
  c.setStatus('later text arriving', 'thinking');
  assert.equal(c.avatarCanvas.hidden, false);
  assert.equal(video.hidden, true);
  c.flushAvatar();
  assert.equal(c.avatarCanvas.hidden, true);
  assert.equal(video.hidden, false);
  assert.equal(video.paused, false);
  c.setStatus('', 'listening');
  assert.equal(video.hidden, false);
  c.showDecodedAvatarFrame({ close() { closed++; } });
  assert.equal(c.avatarCanvas.hidden, true);
  assert.equal(closed, 2);
});

test('old or unconfigured health leaves src unset; configuration changes load once and can recover', () => {
  const { c, events, video } = setup(false);
  c.setAvatarIdleAvailable(false);
  assert.equal(video.src, undefined);
  assert.equal(video.loads, 0);
  c.setAvatarIdleAvailable(true);
  c.setAvatarIdleAvailable(true);
  assert.equal(video.src, '/api/avatar/idle');
  assert.equal(video.loads, 1);
  events.error();
  assert.equal(c.avatarIdleFailed, true);
  c.setAvatarIdleAvailable(false);
  events.loadeddata();
  assert.equal(c.avatarIdleReady, false);
  assert.equal(video.src, undefined);
  c.setAvatarIdleAvailable(true);
  events.loadeddata();
  assert.equal(c.avatarIdleFailed, false);
  assert.equal(video.hidden, false);
});

test('reduced motion pauses on the open-eye first frame; hidden pages pause and visible pages resume', () => {
  const { c, events, documentEvents, motionEvents, video } = setup();
  events.loadeddata();
  c.avatarReducedMotion.matches = true;
  motionEvents.change();
  assert.equal(video.hidden, false);
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 0);
  c.avatarReducedMotion.matches = false;
  motionEvents.change();
  assert.equal(video.paused, false);
  c.document.hidden = true;
  documentEvents.visibilitychange();
  assert.equal(video.paused, true);
  c.document.hidden = false;
  documentEvents.visibilitychange();
  assert.equal(video.paused, false);
});

test('missing or corrupt video and rejected playback preserve the photograph', async () => {
  const missing = setup();
  missing.events.error();
  missing.c.setStatus('', 'listening');
  assert.equal(missing.video.hidden, true);
  assert.equal(missing.c.avatarImage.hidden, false);
  const blocked = setup();
  blocked.video.play = () => Promise.reject({ name: 'NotAllowedError' });
  blocked.events.loadeddata();
  await Promise.resolve();
  assert.equal(blocked.video.hidden, true);
  assert.equal(blocked.c.avatarImage.hidden, false);
  assert.equal(blocked.video.paused, true);
});

test('a handoff-aborted play promise does not permanently disable the loop', async () => {
  const { c, events, video } = setup();
  video.play = () => Promise.reject({ name: 'AbortError' });
  events.loadeddata();
  c.setStatus('', 'speaking');
  await Promise.resolve();
  assert.equal(c.avatarIdleFailed, false);
  video.play = function () { this.paused = false; return Promise.resolve(); };
  c.setStatus('', 'idle');
  assert.equal(video.hidden, false);
  assert.equal(video.paused, false);
});
