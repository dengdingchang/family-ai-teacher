const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const studioModule = import(pathToFileURL(path.join(__dirname, "../frontend/music-studio.js")).href);

class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.handlers = new Map(); this.style = {}; this.dataset = {}; this.attributes = {}; this.hidden = false; this.isConnected = true; this.textContent = ""; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, fn) { this.handlers.set(type, [...(this.handlers.get(type) || []), fn]); }
  removeEventListener(type, fn) { this.handlers.set(type, (this.handlers.get(type) || []).filter(item => item !== fn)); }
  dispatch(type, values = {}) { for (const fn of this.handlers.get(type) || []) fn({ preventDefault() {}, ...values }); }
  focus() { this.doc.activeElement = this; }
  remove() { this.isConnected = false; }
}
function fakeAudio() {
  const played = [];
  return { played, currentTime: 0, destination: {}, resume() {}, close() {},
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; },
    createOscillator() { return { frequency: { setValueAtTime(_hertz) { played.push(_hertz); } }, connect() {}, start() {}, stop() {} }; },
    async decodeAudioData() { return { sampleRate: 8000, getChannelData: () => new Float32Array(8000) }; },
  };
}
async function fixture(options = {}) {
  const { MusicStudio } = await studioModule; const doc = { hidden: false }, events = new Element("document", doc);
  doc.addEventListener = events.addEventListener.bind(events); doc.removeEventListener = events.removeEventListener.bind(events); doc.body = new Element("body", doc); doc.body.style.overflow = "auto"; doc.createElement = tag => new Element(tag, doc); doc.activeElement = new Element("button", doc);
  const timers = new Map(); let sequence = 0, clock = 0, closed = 0; const audio = fakeAudio();
  const studio = new MusicStudio({ document: doc, audioContextFactory: () => audio, now: () => clock,
    later(fn) { const id = ++sequence; timers.set(id, fn); return id; }, cancelLater(id) { timers.delete(id); }, onClose: () => closed++, ...options });
  return { studio, doc, events, audio, timers, closed: () => closed, setClock(value) { clock = value; }, runTimers() { while (timers.size) { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } } };
}

test("piano uses browser audio, keyboard/touch notes, and separates order from rhythm feedback", async () => {
  const f = await fixture(); f.studio.open();
  try {
    f.events.dispatch("keydown", { key: "a" }); f.setClock(420); f.events.dispatch("keydown", { key: "s" }); f.setClock(840); f.events.dispatch("keydown", { key: "d" });
    assert.equal(f.audio.played.length, 3); assert.match(f.studio.feedback.textContent, /顺序：对啦/); assert.match(f.studio.feedback.textContent, /节奏：三个音很整齐/);
    f.studio.keys.get("C4").dispatch("click"); assert.equal(f.audio.played.length, 4);
  } finally { f.studio.destroy(); }
});

test("demo narrates a truthful singing boundary then highlights and plays three reference notes", async () => {
  const spoken = []; const f = await fixture({ onSpeak: async text => { spoken.push(text); return { ok: true }; } }); f.studio.open(); f.studio.setMode("sing");
  try { await f.studio.demo(); f.runTimers(); assert.match(spoken[0], /不能唱歌/); assert.equal(f.audio.played.length, 3); assert.match(f.studio.feedback.textContent, /参考音/); }
  finally { f.studio.destroy(); }
});

test("singing records only after a click, uses the shared stream, and transcription never becomes pitch praise", async () => {
  class Recorder {
    constructor(stream) { this.stream = stream; this.state = "inactive"; this.mimeType = "audio/webm"; this.handlers = new Map(); }
    addEventListener(type, fn) { this.handlers.set(type, fn); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.handlers.get("dataavailable")?.({ data: new Blob(["voice"]) }); this.handlers.get("stop")?.(); }
  }
  const stream = { getTracks() { throw new Error("shared tracks must not be stopped"); } }; const f = await fixture({ MediaRecorder: Recorder, acquireMicrophone: async () => stream, transcribe: async () => ({ text: "啦啦啦" }) }); f.studio.open(); f.studio.setMode("sing");
  try { await f.studio.startSinging(); assert.equal(f.studio.recording.recorder.stream, stream); f.studio._finishRecording(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.studio.recording, null); assert.match(f.studio.feedback.textContent, /音高：这次没听清/); assert.match(f.studio.feedback.textContent, /听到的歌词：“啦啦啦”/); assert.match(f.studio.feedback.textContent, /发音这次没有评估/); assert.doesNotMatch(f.studio.feedback.textContent, /唱准|真棒/); }
  finally { f.studio.destroy(); }
});

test("closing or switching mode before recorder stop never transcribes a stale singing turn", async () => {
  const scheduled = [];
  class Recorder {
    constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; this.handlers = new Map(); }
    addEventListener(type, fn) { this.handlers.set(type, fn); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; scheduled.push(() => {
      this.handlers.get("dataavailable")?.({ data: new Blob(["voice"]) }); this.handlers.get("stop")?.();
    }); }
  }
  let transcriptions = 0;
  const options = { MediaRecorder: Recorder, acquireMicrophone: async () => ({}),
    transcribe: async () => { transcriptions += 1; return "啦"; } };
  const closed = await fixture(options); closed.studio.open(); closed.studio.setMode("sing");
  await closed.studio.startSinging(); closed.studio.close(); scheduled.shift()?.(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(transcriptions, 0);

  const switched = await fixture(options); switched.studio.open(); switched.studio.setMode("sing");
  await switched.studio.startSinging(); switched.studio.setMode("piano"); scheduled.shift()?.(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(transcriptions, 0); assert.equal(switched.studio.mode, "piano"); assert.equal(switched.studio.recording, null);
  switched.studio.destroy();
});

test("pure comparison and local sample analysis reject thin evidence", async () => {
  const { compareThreeNotes, analyseSingingSamples } = await studioModule;
  assert.match(compareThreeNotes([{ id: "D4", at: 0 }, { id: "C4", at: 300 }, { id: "E4", at: 600 }]).message, /顺序：这次/);
  assert.deepEqual(analyseSingingSamples(new Float32Array(800), 8000), { heard: false, pitch: null, rhythm: null });
});

test("local singing analysis only returns a contour after it finds voiced notes and three onsets", async () => {
  const { analyseSingingSamples } = await studioModule; const rate = 8000, frequencies = [261.63, 293.66, 329.63], samples = new Float32Array(rate * 1.2);
  for (let group = 0; group < 3; group++) for (let index = 0; index < 1800; index++) {
    const offset = group * 3200 + 500 + index; samples[offset] = Math.sin(2 * Math.PI * frequencies[group] * index / rate) * 0.3;
  }
  const result = analyseSingingSamples(samples, rate);
  assert.equal(result.heard, true); assert.equal(result.pitch, true); assert.equal(result.rhythm, true); assert.equal(result.onsetTimes.length, 3);
});

test("music styles keep controls large and suppress motion when requested", () => {
  const css = fs.readFileSync(path.join(__dirname, "../frontend/music-studio.css"), "utf8");
  assert.match(css, /min-width: 48px/); assert.match(css, /min-height: 48px/); assert.match(css, /@media \(prefers-reduced-motion: reduce\)/); assert.match(css, /animation: none !important/);
});
