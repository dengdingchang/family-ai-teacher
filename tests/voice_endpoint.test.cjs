const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const implementation = source.slice(source.indexOf('function stopVadLoop()'),
  source.indexOf('async function startContinuousConversation()'));
const stop = source.slice(source.indexOf('function stopContinuousConversation()'),
  source.indexOf('recordButton.addEventListener('));
const configured = Object.fromEntries(['VAD_INTERVAL_MS', 'VAD_START_RMS', 'VAD_STOP_RMS',
  'VAD_START_HOLD_MS', 'VAD_SILENCE_MS', 'VAD_MAX_SEGMENT_MS'].map(name =>
  [name, Number(source.match(new RegExp(`const ${name} = ([\\d.]+);`))[1])]));
const baseline = { ...configured, VAD_INTERVAL_MS: 80, VAD_START_HOLD_MS: 140, VAD_SILENCE_MS: 850 };

function fixture(parameters = configured) {
  const origin = 1000, timers = new Map(), sent = [];
  let now = origin, nextId = 1, level = 0;
  const context = vm.createContext({
    ...parameters, Blob, ArrayBuffer, DataView, Float32Array, Uint8Array,
    conversationActive: true, recordingStream: { getTracks: () => [] }, inputAnalyser: {},
    inputProcessor: null, inputMuteGain: null, inputSource: null, inputSampleRate: 16000,
    segmentRecording: true, segmentShouldSend: false, segmentPcmChunks: [new Float32Array(256)],
    speechStartedAt: 0, loudSince: 0, lastVoiceAt: 0, vadTimer: null,
    bargeInTimer: null, bargeInMonitoring: false, bargeInPcmChunks: [], bargeInGate: { reset() {} },
    recordHint: { textContent: '' }, recordLabel: { textContent: '' },
    recordButton: { classList: { remove() {} }, setAttribute() {} },
    activeTurnId: null, activeRequestController: null,
    performance: { now: () => now }, readSyntheticLevel: () => level,
    setTimeout(callback, delay) { const id = nextId++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, resetListeningLevel() {}, updateListeningLevel() {},
    setStatus() {}, clearResponseQueue() {}, cancelPlayback() {}, cancelConversationTurn() {},
    sendAudio(blob) { sent.push({ at: now, bytes: blob.size }); },
  });
  vm.runInContext(implementation + '\n' + stop + '\ninputRms = readSyntheticLevel; scheduleVad();', context);
  return {
    context, timers, sent, origin,
    advance(signal, until) {
      for (;;) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > origin + until) break;
        const [id, timer] = entry; timers.delete(id); now = timer.at;
        level = signal(now - origin); timer.callback();
      }
      now = origin + until;
    },
    stop() { vm.runInContext('stopContinuousConversation()', context); },
  };
}

function shortWordCoverage(parameters) {
  let submitted = 0;
  for (let phase = 0; phase < parameters.VAD_INTERVAL_MS; phase++) {
    const h = fixture(parameters), start = 800 + phase;
    h.advance(at => at >= start && at < start + 180 ? 0.08 : 0.01, start + 180 + 1400);
    submitted += h.sent.length === 1;
  }
  return { phases: parameters.VAD_INTERVAL_MS, submitted, missed: parameters.VAD_INTERVAL_MS - submitted };
}

test('a 180 ms single word is submitted at every sampling phase', t => {
  const previous = shortWordCoverage(baseline), current = shortWordCoverage(configured);
  t.diagnostic(JSON.stringify({ baseline: previous, configured: current, parameters: configured }));
  assert.equal(current.missed, 0, 'a short number or syllable must not depend on its onset phase');
});

test('a 40 ms isolated click at every phase and sustained low noise never start a reply', () => {
  for (let phase = 0; phase < configured.VAD_INTERVAL_MS; phase++) {
    const h = fixture(), start = 800 + phase;
    h.advance(at => at >= start && at < start + 40 ? 0.3 : 0.01, 2800);
    assert.equal(h.sent.length, 0, `click at phase ${phase}`);
    assert.equal(h.context.speechStartedAt, 0);
  }
  for (const noise of [0.02, 0.035]) {
    const h = fixture(); h.advance(() => noise, 14000);
    assert.equal(h.sent.length, 0);
    assert.equal(h.context.speechStartedAt, 0);
  }
});

test('a 1000 ms pause inside one sentence does not submit its first half', () => {
  const h = fixture();
  const signal = at => (at >= 800 && at < 1200) || (at >= 2200 && at < 2520) ? 0.08 : 0.01;
  h.advance(signal, 2200);
  assert.equal(h.sent.length, 0);
  assert.ok(h.context.speechStartedAt > 0);
  h.advance(signal, 3800);
  assert.equal(h.sent.length, 1);
});

test('true silence submits once at 1200 ms from the last voice sample, without extending the 12-second cap', () => {
  const h = fixture(), signal = at => at >= 800 && at < 1200 ? 0.08 : 0.01;
  h.advance(signal, 1200);
  const last = h.context.lastVoiceAt - h.origin;
  h.advance(signal, last + 1199);
  assert.equal(h.sent.length, 0);
  h.advance(signal, last + 1200);
  assert.equal(h.sent.length, 1);
  h.advance(signal, last + 2000);
  assert.equal(h.sent.length, 1);

  const capped = fixture(); capped.advance(at => at >= 800 ? 0.08 : 0.01, 1200);
  const start = capped.context.speechStartedAt - capped.origin;
  capped.advance(() => 0.08, start + 11999);
  assert.equal(capped.sent.length, 0);
  capped.advance(() => 0.08, start + 12000);
  assert.equal(capped.sent.length, 1);
});

test('ending conversation cancels the pending endpoint and a late callback cannot revive it', () => {
  const h = fixture(); h.advance(at => at >= 800 ? 0.08 : 0.01, 1200);
  assert.ok(h.context.speechStartedAt > 0);
  const late = [...h.timers.values()][0].callback;
  h.stop(); late(); h.advance(() => 0.08, 16000);
  assert.equal(h.sent.length, 0);
  assert.equal(h.context.segmentRecording, false);
  assert.equal(h.context.conversationActive, false);
  assert.equal(h.timers.size, 0);
});
