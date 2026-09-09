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
  const played = [], stopped = [], oscillators = [];
  return { played, stopped, oscillators, currentTime: 0, destination: {}, resume() {}, close() {},
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; },
    createOscillator() {
      const oscillator = { ended: false, frequency: { setValueAtTime(_hertz) { played.push(_hertz); } }, connect() {}, start() {},
        stop(at) { stopped.push(at); if (at === undefined) this.finish(); }, finish() { if (!this.ended) { this.ended = true; this.onended?.(); } } };
      oscillators.push(oscillator); return oscillator;
    },
    async decodeAudioData() { return { sampleRate: 8000, getChannelData: () => new Float32Array(8000) }; },
  };
}
async function fixture(options = {}) {
  const { MusicStudio } = await studioModule; const doc = { hidden: false }, events = new Element("document", doc);
  doc.addEventListener = events.addEventListener.bind(events); doc.removeEventListener = events.removeEventListener.bind(events); doc.body = new Element("body", doc); doc.body.style.overflow = "auto"; doc.createElement = tag => new Element(tag, doc); doc.activeElement = new Element("button", doc);
  const timers = new Map(), delays = new Map(); let sequence = 0, clock = 0, closed = 0; const audio = fakeAudio();
  const studio = new MusicStudio({ document: doc, audioContextFactory: () => audio, now: () => clock,
    later(fn, ms) { const id = ++sequence; timers.set(id, fn); delays.set(id, ms); return id; }, cancelLater(id) { timers.delete(id); delays.delete(id); }, onClose: () => closed++, ...options });
  return { studio, doc, events, audio, timers, delays, closed: () => closed, setClock(value) { clock = value; }, runTimers() { while (timers.size) { const [id, fn] = timers.entries().next().value; timers.delete(id); delays.delete(id); fn(); } for (const oscillator of audio.oscillators) oscillator.finish(); } };
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

test("voice repeat uses the current piano demo and slower replaces its notes without overlap", async () => {
  const spoken = [], f = await fixture({ onSpeak: async text => { spoken.push(text); return { ok: true }; } });
  f.studio.open();
  try {
    assert.equal(f.studio.handleVoiceCommand("爸爸老师，请再示范一次。"), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...f.delays.values()], [0, 550, 1100]);
    const [firstId, firstTone] = f.timers.entries().next().value;
    f.timers.delete(firstId); f.delays.delete(firstId); firstTone();
    assert.equal(f.audio.played.length, 1); assert.match(f.studio.keys.get("C4").className, /is-playing/);
    assert.equal(f.studio.handleVoiceCommand("爸爸老师慢一点"), true);
    assert.equal(f.audio.stopped.filter(at => at === undefined).length, 1);
    assert.doesNotMatch(f.studio.keys.get("C4").className, /is-playing/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...f.delays.values()], [0, 800, 1600]);
    assert.match(spoken.at(-1), /慢慢弹三个音：哆、来、咪/);
    f.runTimers(); assert.deepEqual(f.audio.played, [261.63, 261.63, 293.66, 329.63]);
    assert.equal(f.studio.demoActive, false);
  } finally { f.studio.destroy(); }
});

test("voice next group changes both audible demonstration and the child's expected note order", async () => {
  const spoken = [], f = await fixture({ onSpeak: async text => { spoken.push(text); return { ok: true }; } }); f.studio.open();
  try {
    assert.equal(f.studio.handleVoiceCommand("换一组"), true);
    await new Promise(resolve => setImmediate(resolve)); f.runTimers();
    assert.match(spoken[0], /咪、来、哆/); assert.deepEqual(f.audio.played, [329.63, 293.66, 261.63]);
    for (const [index, id] of ["E4", "D4", "C4"].entries()) { f.setClock(index * 550); f.studio.keys.get(id).dispatch("click"); }
    assert.match(f.studio.feedback.textContent, /顺序：对啦/);
    assert.equal(f.studio.handleVoiceCommand("爸爸老師再示範一次"), true);
    await new Promise(resolve => setImmediate(resolve)); f.runTimers();
    assert.match(spoken.at(-1), /咪、来、哆/); assert.deepEqual(f.audio.played.slice(-3), [329.63, 293.66, 261.63]);
  } finally { f.studio.destroy(); }
});

test("music commands ignore closed views, negation, quotations, ordinary questions and image requests", async () => {
  let spoken = 0; const f = await fixture({ onSpeak: async () => { spoken++; } });
  try {
    assert.equal(f.studio.handleVoiceCommand("再示范一次"), false); f.studio.open();
    const generation = f.studio.generation;
    for (const text of ["不要再示范", "我不想弹钢琴", "爸爸老师别换一组", "他说爸爸老师再示范一次", "‘慢一点’是什么意思", "为什么要跟着唱", "再示范一次？", "你能再示范一次吗", "再看图片", "把图片再打开", "弹钢琴还是画画"]) {
      assert.equal(f.studio.handleVoiceCommand(text), false, text);
    }
    assert.equal(spoken, 0); assert.equal(f.studio.generation, generation); assert.equal(f.timers.size, 0);
    f.studio.destroy(); assert.equal(f.studio.handleVoiceCommand("换一组"), false);
  } finally { if (!f.studio.destroyed) f.studio.destroy(); }
});

test("voice mode commands demonstrate the chosen mode without starting a microphone recording", async () => {
  let acquisitions = 0; const f = await fixture({ acquireMicrophone: async () => { acquisitions++; return {}; } }); f.studio.open();
  try {
    assert.equal(f.studio.handleVoiceCommand("我想跟着唱"), true); assert.equal(f.studio.mode, "sing");
    await new Promise(resolve => setImmediate(resolve)); f.runTimers();
    assert.equal(acquisitions, 0); assert.equal(f.studio.recording, null); assert.match(f.studio.feedback.textContent, /参考音/);
    assert.equal(f.studio.handleVoiceCommand("爸爸老师弹钢琴"), true); assert.equal(f.studio.mode, "piano");
    await new Promise(resolve => setImmediate(resolve)); f.runTimers(); assert.equal(acquisitions, 0);
  } finally { f.studio.destroy(); }
});

test("a voice command cancels a pending singing permission request before it can start recording", async () => {
  let grant, recordings = 0;
  class Recorder { constructor() { recordings++; } }
  const f = await fixture({ MediaRecorder: Recorder, acquireMicrophone: () => new Promise(resolve => { grant = resolve; }) });
  f.studio.open(); f.studio.setMode("sing");
  try {
    const pending = f.studio.startSinging();
    assert.equal(f.studio.handleVoiceCommand("爸爸老师弹钢琴"), true);
    grant({}); await pending;
    assert.equal(recordings, 0); assert.equal(f.studio.recording, null); assert.equal(f.studio.mode, "piano");
  } finally { f.studio.destroy(); }
});

test("exported voice parser classifies commands without opening a view or performing audio", async () => {
  const { parseMusicVoiceCommand } = await studioModule;
  assert.equal(parseMusicVoiceCommand("爸爸老師請再示範一次"), "demo");
  assert.equal(parseMusicVoiceCommand("慢一点"), "slower");
  assert.equal(parseMusicVoiceCommand("换一组"), "next");
  assert.equal(parseMusicVoiceCommand("不要换一组"), "");
  assert.equal(parseMusicVoiceCommand("再看图片"), "");
});

test("listening resumes only after the final demonstration oscillator has ended", async () => {
  const changes = [], f = await fixture({ onListeningChange: allowed => changes.push(allowed) }); f.studio.open();
  try {
    await f.studio.demo(); assert.deepEqual(changes, [true, false]);
    const notes = [...f.timers.entries()];
    for (const [id, fn] of notes) { f.timers.delete(id); f.delays.delete(id); fn(); }
    assert.equal(f.audio.played.length, 3); assert.equal(f.studio.demoActive, true);
    f.audio.oscillators[0].finish(); f.audio.oscillators[1].finish();
    assert.equal(f.studio.listeningAllowed, false); assert.deepEqual(changes, [true, false]);
    f.audio.oscillators[2].finish();
    assert.equal(f.studio.demoActive, false); assert.deepEqual(changes, [true, false, true]);
    f.studio.close(); assert.deepEqual(changes, [true, false, true, false]);
  } finally { f.studio.destroy(); }
});

test("ending a cancelled demonstration cannot enable listening during its replacement", async () => {
  const changes = [], f = await fixture({ onListeningChange: allowed => changes.push(allowed) }); f.studio.open();
  try {
    await f.studio.demo();
    const notes = [...f.timers.entries()];
    for (const [id, fn] of notes) { f.timers.delete(id); f.delays.delete(id); fn(); }
    const staleEnd = f.audio.oscillators.at(-1).onended;
    const replacement = f.studio.demo(); staleEnd();
    assert.deepEqual(changes, [true, false]); assert.equal(f.studio.demoActive, true);
    await replacement; f.runTimers(); assert.deepEqual(changes, [true, false, true]);
    await f.studio.demo(); f.studio.setMode("sing");
    assert.equal(f.studio.listeningAllowed, true); assert.equal(f.studio.demoActive, false);
    f.studio.close(); staleEnd(); assert.equal(f.studio.listeningAllowed, false);
  } finally { f.studio.destroy(); }
});

test("singing gates normal listening through permission and analysis, then restores it", async () => {
  class Recorder {
    constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; this.handlers = new Map(); }
    addEventListener(type, fn) { this.handlers.set(type, fn); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.handlers.get("stop")?.(); }
  }
  let grant, finishTranscript; const changes = [];
  const f = await fixture({ MediaRecorder: Recorder, onListeningChange: allowed => changes.push(allowed),
    acquireMicrophone: () => new Promise(resolve => { grant = resolve; }),
    transcribe: () => new Promise(resolve => { finishTranscript = resolve; }) });
  f.studio.open(); f.studio.setMode("sing");
  try {
    const start = f.studio.startSinging(); assert.deepEqual(changes, [true, false]);
    grant({}); await start; f.studio._finishRecording();
    assert.equal(f.studio.listeningAllowed, false);
    finishTranscript("啦"); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(changes, [true, false, true]);
    const again = f.studio.startSinging(); grant({}); await again; f.studio._finishRecording();
    f.studio.close(); finishTranscript("旧结果"); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.studio.listeningAllowed, false); assert.deepEqual(changes, [true, false, true, false]);
  } finally { f.studio.destroy(); }
});

test("denied permission and a recorder start error do not leave ordinary listening disabled", async () => {
  const denied = await fixture({ MediaRecorder: class {}, acquireMicrophone: async () => null }); denied.studio.open(); denied.studio.setMode("sing");
  try { await denied.studio.startSinging(); assert.equal(denied.studio.listeningAllowed, true); }
  finally { denied.studio.destroy(); }
  class FailingRecorder { constructor() { this.state = "inactive"; } start() { throw new Error("device lost"); } }
  const failed = await fixture({ MediaRecorder: FailingRecorder, acquireMicrophone: async () => ({}) }); failed.studio.open(); failed.studio.setMode("sing");
  try { await failed.studio.startSinging(); assert.equal(failed.studio.listeningAllowed, true); assert.equal(failed.studio.recording, null); }
  finally { failed.studio.destroy(); }
});
