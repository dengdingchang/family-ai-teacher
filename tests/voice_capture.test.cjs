const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { BargeInGate } = require("../frontend/voice-activity.js");
const source = fs.readFileSync(path.join(__dirname, "../frontend/app.js"), "utf8");
const captureStart = source.indexOf("inputProcessor.onaudioprocess = (event) => {");
const captureSource = source.slice(captureStart, source.indexOf("\n    };", captureStart) + 7);
const voiceSource = source.slice(source.indexOf("function stopVadLoop()"), source.indexOf("function releaseInputStream()"));

function fixture(sampleRate, barge = false) {
  let now = 100, level = 0;
  const sent = [], calls = [];
  const context = vm.createContext({
    Float32Array, Uint8Array, ArrayBuffer, DataView, Blob,
    conversationActive: true, recordingStream: {}, inputAnalyser: {}, inputProcessor: {},
    inputSampleRate: sampleRate, segmentPcmChunks: [], segmentRecording: !barge,
    segmentShouldSend: false, speechStartedAt: 0, lastVoiceAt: 0, loudSince: 0,
    bargeInMonitoring: barge, bargeInPcmChunks: [], bargeInTimer: null, vadTimer: null,
    bargeInGate: new BargeInGate(), BARGE_IN_PREROLL_CHUNKS: 6, PCM_PREROLL_SECONDS: 1,
    VAD_START_RMS: 0.045, VAD_STOP_RMS: 0.028, VAD_START_HOLD_MS: 140,
    VAD_SILENCE_MS: 850, VAD_MAX_SEGMENT_MS: 12000,
    recordHint: { textContent: "" }, activeTurnId: "synthetic-capture-turn",
    activeRequestController: { abort() { calls.push("abort"); } }, interruptedRequestController: null,
    performance: { now: () => now }, clearTimeout() {},
    resetListeningLevel() {}, updateListeningLevel() {}, setStatus() {},
    clearResponseQueue() {}, cancelPlayback() {}, cancelConversationTurn() {},
    sendAudio(blob, continuous) { sent.push({ blob, continuous }); },
    readLevel: () => level,
  });
  vm.runInContext(voiceSource + "\n" + captureSource, context);
  vm.runInContext("inputRms = readLevel; scheduleVad = () => {}; scheduleBargeInCheck = () => {};", context);
  return {
    context, sent, calls,
    capture(chunk) { context.inputProcessor.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } }); },
    tick(at, rms, expression = "checkVoiceActivity()") {
      now = at; level = rms; return vm.runInContext(expression, context);
    },
    finish() { vm.runInContext("finishContinuousSegment()", context); },
  };
}

for (const rate of [44100, 48000]) {
  test(`first syllable survives the idle rollover and confirmed speech stays complete at ${rate} Hz`, async () => {
    const f = fixture(rate);
    for (let i = 0; i < 120; i++) f.capture(new Float32Array(4096));
    const firstWord = new Float32Array(4096); firstWord[512] = 0.5;
    f.capture(firstWord);
    f.tick(100, 0.06);
    assert.ok(f.context.segmentPcmChunks.some(chunk => chunk.includes(0.5)),
      "the first syllable must not be erased before the 140 ms start confirmation");
    assert.equal(f.context.segmentPcmChunks.reduce((n, chunk) => n + chunk.length, 0), rate,
      "unconfirmed input retains one second at the actual sample rate");
    f.capture(new Float32Array(4096)); f.tick(180, 0.06);
    f.capture(new Float32Array(4096)); f.tick(260, 0.06);
    assert.ok(f.context.speechStartedAt > 0);
    const confirmedSamples = f.context.segmentPcmChunks.reduce((n, chunk) => n + chunk.length, 0);
    const continuation = new Float32Array(rate * 2); continuation[continuation.length - 1] = 0.75;
    f.capture(continuation); f.finish();
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].continuous, true);
    const bytes = await f.sent[0].blob.arrayBuffer(), wav = new DataView(bytes);
    assert.equal(wav.getUint32(24, true), rate);
    assert.equal(wav.getUint32(40, true) / 2, confirmedSamples + continuation.length);
    const pcm = new Int16Array(bytes, 44);
    assert.ok(pcm.includes(16383), "the submitted WAV still contains the first word marker");
    assert.equal(pcm.at(-1), 24575, "the confirmed sentence is not trimmed to the idle window");
  });
}

for (const rate of [44100, 48000, 16000]) {
  test(`a 600 ms syllabic interruption retains its first word at ${rate} Hz`, () => {
    const f = fixture(rate, true);
    let nextBlockAt = 0, block = 0;
    for (let at = 0; at <= 600; at += 40) {
      while (nextBlockAt <= at) {
        const chunk = new Float32Array(4096);
        if (block === 0) chunk[512] = 0.5;
        f.capture(chunk); block++; nextBlockAt += 4096 / rate * 1000;
      }
      f.tick(1000 + at, at % 120 === 0 ? 0.1 : 0, "checkBargeIn()");
    }
    assert.deepEqual(f.calls, ["abort"]);
    assert.equal(f.context.segmentRecording, true);
    assert.equal(f.context.bargeInMonitoring, false);
    assert.ok(f.context.segmentPcmChunks.some(chunk => chunk.includes(0.5)),
      "valid speech spread across 600 ms must retain the initial syllable when interruption starts");
  });
}

test("long idle capture stays bounded and a single click never becomes an interruption", () => {
  const f = fixture(48000, true);
  for (let at = 0; at < 4000; at += 40) {
    f.capture(new Float32Array(1920));
    f.tick(1000 + at, at === 120 ? 0.3 : 0.02, "checkBargeIn()");
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.context.segmentRecording, false);
  assert.equal(f.context.bargeInPcmChunks.reduce((n, chunk) => n + chunk.length, 0), 48000);
  f.context.conversationActive = false;
  const before = f.context.bargeInPcmChunks.length;
  f.capture(new Float32Array(4096));
  assert.equal(f.context.bargeInPcmChunks.length, before, "stopped capture accepts no further PCM");
});
