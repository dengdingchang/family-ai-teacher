// Exercise the actual app functions at the host/component boundary. No real
// browser microphone, HTTP service, model, or family record is used.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/app.js"), "utf8");
function actualFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `actual app function ${name} exists`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1);
  return source.slice(start, end + 2);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const element = () => ({ disabled: false, textContent: "", hidden: false,
  classList: { add() {}, remove() {} }, setAttribute() {} });

function fixture() {
  const response = deferred(), playback = deferred(), microphone = deferred();
  let options, resumes = 0, microphoneCalls = 0, trackStops = 0, audioPlays = 0;
  const node = () => ({ connect() {}, disconnect() {} });
  const stream = { active: true, getTracks: () => [{ stop() { trackStops++; } }] };
  const c = {
    AbortController, DOMException, Promise, Float32Array, setTimeout, clearTimeout,
    pageIsLeaving: false, conversationActive: true, conversationStarting: false,
    musicConversationWasActive: true, musicStudio: null, musicSpeechController: null,
    activeRequestController: null, activeRequestSource: "", activeTurnId: null,
    queueGeneration: 0, recordingStream: stream, segmentRecording: false,
    segmentShouldSend: false, segmentPcmChunks: [], inputProcessor: null,
    inputMuteGain: null, inputSource: null, inputAnalyser: null, audioContext: null,
    chessBoard: null, drawingBoard: null, inputSampleRate: 48000,
    recordButton: element(), recordLabel: element(), recordHint: element(), playChoices: element(), playButton: element(),
    activityEnabled: () => true, stopVadLoop() {}, stopBargeInMonitor() {}, resetListeningLevel() {},
    clearResponseQueue() {}, cancelPlayback() {}, setStatus() {}, setBusy() {}, cancelChessExplanation() {},
    cancelMediaSuggestionLookup() {}, cancelConversationTurn() {},
    interruptActiveReply: async () => {}, acquireMusicMicrophone() {}, transcribeMusicRecording() {},
    beginContinuousSegment() { resumes++; c.segmentRecording = true; },
    async playAudioPayload() { audioPlays++; await playback.promise; },
    fetch(_url, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
        response.promise.then(resolve, reject);
      });
    },
    navigator: { mediaDevices: { getUserMedia() { microphoneCalls++; return microphone.promise; } } },
    window: { AudioContext: class {
      constructor() { this.sampleRate = 48000; this.destination = node(); }
      resume() { return Promise.resolve(); }
      createMediaStreamSource() { return node(); }
      createAnalyser() { return node(); }
      createScriptProcessor() { return node(); }
      createGain() { return { ...node(), gain: { value: 0 } }; }
    } },
    // A controlled producer of the documented component callbacks; real studio
    // oscillators, mode generation, and tail events have their own module tests.
    prepareMusicTheme() {}, cancelMusicTheme() {},
    MusicStudio: class {
      constructor(callbacks) { options = callbacks; this.opened = false; this.listeningAllowed = false; this.feedback = element(); }
      open() { this.opened = true; this.listeningAllowed = true; options.onListeningChange(true); }
      setMode() { this.listeningAllowed = true; options.onListeningChange(true); }
      close() { this.opened = false; this.listeningAllowed = false; options.onListeningChange(false); options.onClose(); }
      demo() { this.listeningAllowed = false; options.onListeningChange(false); }
    },
  };
  vm.createContext(c);
  vm.runInContext(["cancelMusicExplanation", "speakMusicInstruction", "getMusicStudio", "openMusicActivity",
    "releaseInputStream", "startContinuousConversation", "stopContinuousConversation"].map(actualFunction).join("\n"), c);
  return { c, response, playback, microphone, stream,
    get options() { return options; }, get resumes() { return resumes; }, get trackStops() { return trackStops; },
    get microphoneCalls() { return microphoneCalls; }, get audioPlays() { return audioPlays; },
    prepareDemo() { const studio = c.getMusicStudio(); studio.opened = true; studio.listeningAllowed = false; return studio; },
  };
}

test("closing music during its pending speech resumes the existing conversation after abort settles", async () => {
  const f = fixture(), studio = f.prepareDemo();
  const speech = f.c.speakMusicInstruction("听爸爸弹三个音");
  assert.ok(f.c.activeRequestController);
  studio.close();
  assert.equal(f.resumes, 0, "old request still owns the audio path");
  await speech;
  assert.equal(f.c.activeRequestController, null);
  assert.equal(f.c.conversationActive, true);
  assert.equal(f.resumes, 1);
});

test("mode-change listening callback waits for the cancelled old voice owner to release", async () => {
  const f = fixture(), studio = f.prepareDemo();
  const speech = f.c.speakMusicInstruction("跟着三个参考音慢慢张嘴");
  studio.setMode('piano');
  assert.equal(f.resumes, 0);
  assert.equal(f.c.activeRequestController.signal.aborted, true, 'mode callback cancels the old host speech');
  await speech;
  assert.equal(f.resumes, 1);
  assert.equal(f.c.activeRequestController, null);
});

test("spoken introduction completion does not reopen listening before the demo tail finishes", async () => {
  const f = fixture(); f.prepareDemo();
  const speech = f.c.speakMusicInstruction("听爸爸弹三个音");
  f.response.resolve({ ok: true, json: async () => ({ audio_base64: "RAM fixture" }) });
  await tick();
  assert.equal(f.audioPlays, 1);
  f.playback.resolve();
  await speech;
  assert.equal(f.c.activeRequestController, null);
  assert.equal(f.resumes, 0, "music component still owns the three-note demonstration");
  f.c.musicStudio.listeningAllowed = true;
  f.options.onListeningChange(true);
  assert.equal(f.resumes, 1, "only the component's finished-tail callback permits listening");
});

test("closing music while microphone permission is pending discards late permission and tracks", async () => {
  const f = fixture();
  f.c.conversationActive = false; f.c.recordingStream = null; f.c.musicConversationWasActive = false;
  const opening = f.c.openMusicActivity("piano");
  await tick();
  assert.equal(f.microphoneCalls, 1, "first music entry starts the shared microphone");
  assert.equal(f.c.musicStudio.opened, true);
  f.c.musicStudio.close();
  f.microphone.resolve(f.stream);
  await opening;
  assert.equal(f.c.conversationActive, false);
  assert.equal(f.c.conversationStarting, false);
  assert.equal(f.c.recordingStream, null);
  assert.equal(f.resumes, 0);
  assert.equal(f.trackStops, 1);
});

test("an old music request cannot release a newer request or restart listening over it", async () => {
  const f = fixture(); f.prepareDemo();
  const speech = f.c.speakMusicInstruction("旧音乐讲解");
  const newer = new AbortController();
  f.c.activeRequestController = newer; f.c.activeRequestSource = "new child question";
  f.c.cancelMusicExplanation();
  await speech;
  assert.equal(f.c.activeRequestController, newer);
  assert.equal(f.c.activeRequestSource, "new child question");
  assert.equal(f.resumes, 0);
});

test("closing music cancels an already playing introduction, not only its finished fetch", async () => {
  const f = fixture(), studio = f.prepareDemo();
  const speech = f.c.speakMusicInstruction("正在播放的音乐开场");
  f.response.resolve({ ok: true, json: async () => ({ audio_base64: "RAM fixture" }) });
  await tick(); assert.equal(f.audioPlays, 1);
  let cancelled = false;
  f.c.cancelPlayback = () => { cancelled = true; f.playback.resolve(); };
  studio.close();
  try { assert.equal(cancelled, true, "close must release the active audio wait"); }
  finally { f.playback.resolve(); await speech; }
  assert.equal(f.c.activeRequestController, null);
});
