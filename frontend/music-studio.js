// Local-only music activity. It owns no family data, network calls, or microphone tracks.

const NOTES = [
  { id: "C4", label: "哆", key: "a", frequency: 261.63 },
  { id: "D4", label: "来", key: "s", frequency: 293.66 },
  { id: "E4", label: "咪", key: "d", frequency: 329.63 },
  { id: "F4", label: "发", key: "f", frequency: 349.23 },
  { id: "G4", label: "索", key: "g", frequency: 392.0 },
];
const DEMO = ["C4", "D4", "E4"];
const KEY_NOTES = new Map(NOTES.map(note => [note.key, note]));

export function compareThreeNotes(notes, reference = DEMO) {
  const played = notes.slice(0, reference.length);
  const orderCorrect = played.length === reference.length && played.every((note, index) => note.id === reference[index]);
  if (played.length !== reference.length) return { orderCorrect: false, rhythmKnown: false, message: "还差几颗琴键，我们再听一遍三声音。" };
  const times = played.map(note => Number(note.at));
  const gaps = [times[1] - times[0], times[2] - times[1]];
  const rhythmKnown = gaps.every(value => Number.isFinite(value) && value >= 90 && value <= 1600);
  const rhythmEven = rhythmKnown && Math.abs(gaps[0] - gaps[1]) <= Math.max(160, Math.max(gaps[0], gaps[1]) * 0.45);
  const order = orderCorrect ? "顺序：对啦，三个音走对了。" : "顺序：这次和示范不一样，我们慢慢再听一次。";
  const rhythm = !rhythmKnown ? "节奏：这次没听清，我们再慢慢按一次。"
    : rhythmEven ? "节奏：三个音很整齐。" : "节奏：顺序听到了，试试把三个音按得更均匀。";
  return { orderCorrect, rhythmKnown, rhythmEven, message: `${order}${rhythm}` };
}

function rms(samples) {
  if (!samples?.length) return 0;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.sqrt(total / samples.length);
}

function estimatePitch(samples, sampleRate) {
  if (!samples?.length || rms(samples) < 0.012) return null;
  const minLag = Math.floor(sampleRate / 550), maxLag = Math.min(Math.floor(sampleRate / 160), Math.floor(samples.length / 2));
  let bestLag = 0, bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0, energyA = 0, energyB = 0;
    for (let index = 0; index < samples.length - lag; index++) {
      const a = samples[index], b = samples[index + lag]; dot += a * b; energyA += a * a; energyB += b * b;
    }
    const score = dot / Math.sqrt(energyA * energyB || 1);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  return bestScore >= 0.55 && bestLag ? { hertz: sampleRate / bestLag, confidence: bestScore } : null;
}

export function analyseSingingSamples(samples, sampleRate, reference = DEMO) {
  if (!samples?.length || !sampleRate) return { heard: false, pitch: null, rhythm: null };
  const windowSize = Math.max(256, Math.floor(samples.length / 3));
  const pitches = [0, 1, 2].map(index => estimatePitch(samples.subarray(index * windowSize, Math.min(samples.length, (index + 1) * windowSize)), sampleRate));
  const voiced = pitches.filter(Boolean);
  if (voiced.length < 2) return { heard: false, pitch: null, rhythm: null };
  const expected = reference.slice(0, pitches.length).map(id => NOTES.find(note => note.id === id)?.frequency);
  const pitch = pitches.every((item, index) => item && Math.abs(12 * Math.log2(item.hertz / expected[index])) <= 2.5);
  // A tiny local onset detector: it only claims rhythm when three clear energy
  // starts exist. Continuous or noisy recordings remain honestly unknown.
  const frame = Math.max(128, Math.floor(sampleRate * 0.025)), energies = [];
  for (let offset = 0; offset + frame <= samples.length; offset += frame) energies.push(rms(samples.subarray(offset, offset + frame)));
  const threshold = Math.max(0.025, Math.max(...energies) * 0.35), onsets = [];
  for (let index = 1; index < energies.length; index++) {
    if (energies[index - 1] < threshold && energies[index] >= threshold
        && (!onsets.length || (index - onsets.at(-1)) * frame / sampleRate >= 0.16)) onsets.push(index);
  }
  const onsetTimes = onsets.slice(0, 3).map(index => index * frame / sampleRate);
  const rhythm = onsetTimes.length === 3
    ? Math.abs((onsetTimes[1] - onsetTimes[0]) - (onsetTimes[2] - onsetTimes[1])) <= 0.24 : null;
  return { heard: true, pitch, rhythm, pitches, onsetTimes };
}

export class MusicStudio {
  /**
   * Host contract: onSpeak(text) returns Promise<{ok?: boolean, error?: string}>;
   * acquireMicrophone() returns the application's existing MediaStream;
   * transcribe(blob) returns a string or {text}; onClose() releases host narration.
   */
  constructor({ onSpeak = () => ({ ok: true }), acquireMicrophone = async () => null,
    transcribe = async () => "", onClose = () => {}, document: doc = globalThis.document,
    audioContextFactory, MediaRecorder: Recorder = globalThis.MediaRecorder,
    later, cancelLater, now = () => globalThis.performance?.now?.() || Date.now(), recordingMs = 4500 } = {}) {
    if (!doc?.body) throw new Error("Music studio needs a document body");
    this.doc = doc; this.win = doc.defaultView || globalThis;
    this.onSpeak = onSpeak; this.acquireMicrophone = acquireMicrophone; this.transcribe = transcribe; this.onClose = onClose;
    this.audioContextFactory = audioContextFactory || (() => new (this.win.AudioContext || this.win.webkitAudioContext)());
    this.Recorder = Recorder; this.later = later || ((fn, ms) => this.win.setTimeout(fn, ms));
    this.cancelLater = cancelLater || (handle => this.win.clearTimeout(handle)); this.now = now; this.recordingMs = recordingMs;
    this.opened = false; this.destroyed = false; this.mode = "piano"; this.context = null; this.demoTimers = []; this.demoActive = false;
    this.performance = []; this.recording = null; this.recordingTimer = null; this.generation = 0;
    this._build();
    this._keydown = event => this._onKeydown(event);
    doc.addEventListener("keydown", this._keydown, true);
  }

  _node(tag, className = "", text = "") { const node = this.doc.createElement(tag); node.className = className; node.textContent = text; return node; }
  _button(text, action, className = "") { const node = this._node("button", `music-studio__button ${className}`, text); node.type = "button"; node.addEventListener("click", action); return node; }
  _build() {
    this.element = this._node("section", "music-studio"); this.element.hidden = true;
    this.element.setAttribute("role", "dialog"); this.element.setAttribute("aria-modal", "true"); this.element.setAttribute("aria-label", "和爸爸玩音乐");
    const header = this._node("header", "music-studio__header"); this.back = this._button("← 返回", () => this.close(), "music-studio__back");
    const heading = this._node("div", "music-studio__heading"); heading.append(this._node("h2", "", "小小音乐屋"), this._node("p", "", "先听三个音，再自己试一试")); header.append(this.back, heading);
    const modes = this._node("nav", "music-studio__modes"); this.pianoButton = this._button("弹钢琴", () => this.setMode("piano")); this.singButton = this._button("跟着唱", () => this.setMode("sing")); modes.append(this.pianoButton, this.singButton);
    const content = this._node("div", "music-studio__content"); this.instruction = this._node("p", "music-studio__instruction"); this.instruction.setAttribute("role", "status");
    this.beatTrack = this._node("div", "music-studio__beats"); this.beatTrack.setAttribute("aria-label", "三个音的进度");
    this.beats = [0, 1, 2].map(index => { const beat = this._node("span", "music-studio__beat"); beat.setAttribute("aria-label", `第${index + 1}个音`); this.beatTrack.append(beat); return beat; });
    this.keyboard = this._node("div", "music-studio__keys"); this.keyboard.setAttribute("role", "group"); this.keyboard.setAttribute("aria-label", "五个钢琴键"); this.keys = new Map();
    for (const note of NOTES) {
      const key = this._button(`${note.label}\n${note.key.toUpperCase()}`, () => this.playChildNote(note), "music-studio__key");
      key.dataset.note = note.id; key.setAttribute("aria-label", `${note.label}，电脑键 ${note.key.toUpperCase()}`); this.keys.set(note.id, key); this.keyboard.append(key);
    }
    const controls = this._node("div", "music-studio__controls"); this.demoButton = this._button("爸爸示范三个音", () => void this.demo(), "music-studio__demo"); this.turnButton = this._button("轮到我唱", () => void this.startSinging(), "music-studio__turn"); controls.append(this.demoButton, this.turnButton);
    this.feedback = this._node("p", "music-studio__feedback"); this.feedback.setAttribute("aria-live", "polite");
    this.privacy = this._node("p", "music-studio__privacy", "跟唱只在点“轮到我唱”后短暂使用麦克风，声音不保存。");
    content.append(this.instruction, this.beatTrack, this.keyboard, controls, this.feedback, this.privacy); this.element.append(header, modes, content); this.doc.body.append(this.element); this._render();
  }
  open() { if (this.destroyed || this.opened) return this; this.opened = true; this.focusBefore = this.doc.activeElement; this.overflowBefore = this.doc.body.style.overflow; this.doc.body.style.overflow = "hidden"; this.element.hidden = false; this._render(); this.back.focus({ preventScroll: true }); return this; }
  close() { if (!this.opened) return; this.opened = false; this.generation++; this._clearDemo(); this._cancelRecording(); this.element.hidden = true; this.doc.body.style.overflow = this.overflowBefore; try { this.onClose(); } finally { if (this.focusBefore?.isConnected) this.focusBefore.focus({ preventScroll: true }); } }
  destroy() { this.close(); this.destroyed = true; this.doc.removeEventListener("keydown", this._keydown, true); this.context?.close?.(); this.element.remove(); }
  setMode(mode) { if (!this.opened || !["piano", "sing"].includes(mode)) return; this.generation++; this._clearDemo(); this._cancelRecording(); this.mode = mode; this.performance = []; this._showBeats(0); this._render(); }
  _showBeats(done, active = -1) { this.beats.forEach((beat, index) => { beat.className = `music-studio__beat${index < done ? " is-done" : ""}${index === active ? " is-active" : ""}`; }); }
  _render() {
    const piano = this.mode === "piano"; this.pianoButton.setAttribute("aria-pressed", String(piano)); this.singButton.setAttribute("aria-pressed", String(!piano));
    this.turnButton.hidden = piano; this.demoButton.textContent = piano ? "爸爸示范三个音" : "听三个参考音";
    this.instruction.textContent = piano ? "先看爸爸亮起三个琴键，再照着按。" : "先听三个参考音，再点话筒轮到你。爸爸现在不能唱歌。";
    this.privacy.hidden = piano; if (!this.feedback.textContent) this.feedback.textContent = piano ? "轮到你啦，试试按三个琴键。" : "准备好后，点“轮到我唱”。";
  }
  _onKeydown(event) {
    if (!this.opened || this.recording || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
    if (event.repeat) return; const note = KEY_NOTES.get(String(event.key || "").toLowerCase());
    if (note) { event.preventDefault(); this.playChildNote(note); }
  }
  _audio() { if (!this.context) this.context = this.audioContextFactory(); this.context.resume?.(); return this.context; }
  _tone(note) {
    try {
      const context = this._audio(), start = context.currentTime || 0, gain = context.createGain(), oscillator = context.createOscillator();
      oscillator.type = "triangle"; oscillator.frequency.setValueAtTime(note.frequency, start); gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.24, start + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.75);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + 0.78);
    } catch (_) { this.feedback.textContent = "琴音暂时没准备好，可以再点一次。"; }
  }
  _flash(id) { const key = this.keys.get(id); if (!key) return; key.className = "music-studio__button music-studio__key is-playing"; this.demoTimers.push(this.later(() => { if (key.isConnected) key.className = "music-studio__button music-studio__key"; }, 330)); }
  playChildNote(note) {
    if (!this.opened || this.recording) return; const demoActive = this.demoActive; this._tone(note); this._flash(note.id);
    if (this.mode !== "piano" || demoActive) return;
    this.performance.push({ id: note.id, at: this.now() });
    this._showBeats(this.performance.length);
    if (this.performance.length === DEMO.length) { const result = compareThreeNotes(this.performance); this.feedback.textContent = result.message; this.performance = []; }
  }
  _clearDemo() { for (const timer of this.demoTimers) this.cancelLater(timer); this.demoTimers = []; this.demoActive = false; }
  async demo() {
    if (!this.opened || this.recording) return; this.performance = []; this._clearDemo(); this.demoActive = true; const token = ++this.generation;
    const words = this.mode === "sing" ? "爸爸现在只能说口型提示，不能唱歌。跟着哆、来、咪慢慢张嘴，再听三个参考音。" : "听爸爸弹三个音：哆、来、咪。等一等，再轮到你按。";
    this._showBeats(0, 0); this.feedback.textContent = "爸爸正在示范…";
    try { const result = await this.onSpeak(words); if (token !== this.generation || !this.opened) return; if (result?.ok === false) this.feedback.textContent = result.error || "声音没播完，钢琴示范还可以继续听。"; } catch (_) { if (token === this.generation) this.feedback.textContent = "声音没播出来，钢琴示范还可以继续听。"; }
    if (token !== this.generation || !this.opened) return;
    for (const [index, id] of DEMO.entries()) this.demoTimers.push(this.later(() => { if (token === this.generation && this.opened) { const note = NOTES.find(item => item.id === id); this._tone(note); this._flash(id); this._showBeats(index + 1, index < DEMO.length - 1 ? index + 1 : -1); if (index === DEMO.length - 1) { this.demoTimers = []; this.demoActive = false; this.feedback.textContent = this.mode === "piano" ? "轮到你啦，照着三个亮点按。" : "这是参考音，不是在判断你唱得准不准。"; } } }, index * 550));
  }
  async startSinging() {
    if (!this.opened || this.mode !== "sing" || this.recording) return;
    if (!this.Recorder) { this.feedback.textContent = "这个浏览器不能短暂录音，所以这次没听清。"; return; }
    let stream;
    try { stream = await this.acquireMicrophone(); } catch (_) { stream = null; }
    if (!this.opened || !stream) { this.feedback.textContent = "麦克风暂时没准备好，可以请大人帮忙后再试。"; return; }
    let recorder;
    try { recorder = new this.Recorder(stream); } catch (_) { this.feedback.textContent = "这次没听清，可以再试一次。"; return; }
    const token = ++this.generation, chunks = [];
    this.recording = { recorder, chunks, token }; this._showBeats(0, 0); this.feedback.textContent = "现在轮到你唱，唱完会自己停下来。";
    recorder.addEventListener?.("dataavailable", event => { if (event.data?.size) chunks.push(event.data); });
    recorder.addEventListener?.("stop", () => void this._processRecording(token, recorder, chunks));
    recorder.start(); this.recordingTimer = this.later(() => this._finishRecording(), this.recordingMs);
  }
  _finishRecording() { if (this.recordingTimer !== null) { this.cancelLater(this.recordingTimer); this.recordingTimer = null; } const recorder = this.recording?.recorder; if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch (_) {} } }
  _cancelRecording() {
    const current = this.recording;
    if (this.recordingTimer !== null) { this.cancelLater(this.recordingTimer); this.recordingTimer = null; }
    if (!current) return;
    this.recording = null;
    current.chunks.length = 0;
    if (current.recorder?.state !== "inactive") { try { current.recorder.stop(); } catch (_) {} }
  }
  async _processRecording(token, recorder, chunks) {
    if (this.recording?.recorder !== recorder) { chunks.length = 0; return; }
    this.recording = null;
    if (!this.opened || token !== this.generation || this.mode !== "sing") { chunks.length = 0; return; }
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" }); chunks.length = 0;
    try {
      const [local, transcript] = await Promise.all([this._analyseBlob(blob), Promise.resolve(this.transcribe(blob)).catch(() => "")]);
      if (!this.opened || token !== this.generation) return;
      const pitchText = local.heard ? (local.pitch === true ? "音高：听到稳定的音高轮廓。" : "音高：这次没听清。") : "音高：这次没听清。";
      const rhythmText = local.heard && local.rhythm === true ? "节奏：起音很清楚。" : "节奏：这次没听清。";
      const text = typeof transcript === "string" ? transcript.trim() : String(transcript?.text || "").trim();
      const wordsText = text ? `听到的歌词：“${text.slice(0, 80)}”。发音这次没有评估。` : "听到的歌词：这次没听清。发音这次没有评估。";
      this.feedback.textContent = `${pitchText}${rhythmText}${wordsText}`;
    } catch (_) { if (this.opened && token === this.generation) this.feedback.textContent = "音高：这次没听清。节奏：这次没听清。听到的歌词：这次没听清。发音这次没有评估。"; }
    finally { /* blob and recorder chunks are released after this turn; shared stream tracks stay untouched. */ }
  }
  async _analyseBlob(blob) {
    try { const context = this._audio(), data = await blob.arrayBuffer(), decoded = await context.decodeAudioData(data); return analyseSingingSamples(decoded.getChannelData(0), decoded.sampleRate); }
    catch (_) { return { heard: false, pitch: null, rhythm: null }; }
  }
}

globalThis.MusicStudio = MusicStudio;
