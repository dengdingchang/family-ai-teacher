// Local music activity: only a small UI-practice record is stored, never family assessments or media.
import { MusicJourney, MUSIC_THEMES, MUSIC_PROGRESS_KEY } from "./music-curriculum.js?v=20260910-journey2";
import { MusicRhythmRound } from "./music-rhythm.js?v=20260910-journey2";

const NOTES = [
  { id: "C4", label: "哆", key: "a", frequency: 261.63 },
  { id: "D4", label: "来", key: "s", frequency: 293.66 },
  { id: "E4", label: "咪", key: "d", frequency: 329.63 },
  { id: "F4", label: "发", key: "f", frequency: 349.23 },
  { id: "G4", label: "索", key: "g", frequency: 392.0 },
];
const DEMO = ["C4", "D4", "E4"];
const DEMO_GROUPS = [DEMO, ["E4", "D4", "C4"], ["C4", "E4", "G4"], ["D4", "F4", "E4"]];
const KEY_NOTES = new Map(NOTES.map(note => [note.key, note]));

export function parseMusicVoiceCommand(text) {
  // Whole commands only: do not turn a question, quotation, or negation into an action.
  const phrase = String(text || "").normalize("NFKC")
    .replace(/[\s，,。！!、]/gu, "")
    .replace(/老師/g, "老师").replace(/示範/g, "示范").replace(/一點/g, "一点")
    .replace(/換/g, "换").replace(/組/g, "组").replace(/彈/g, "弹").replace(/鋼/g, "钢").replace(/著/g, "着")
    .replace(/請/g, "请").replace(/幫/g, "帮").replace(/給/g, "给").replace(/聽/g, "听")
    .replace(/關/g, "关").replace(/來/g, "来").replace(/題/g, "题").replace(/節/g, "节").replace(/積/g, "积").replace(/動/g, "动")
    .replace(/從/g, "从").replace(/頭/g, "头").replace(/練/g, "练");
  const command = phrase.replace(/^(?:爸爸老师|爸爸)?(?:请你|请|帮我|给我|我要|我想)?/u, "").replace(/[吧呀啊啦]$/u, "");
  if (/^(?:再(?:示范|演示|弹)(?:一遍|一次)?|示范(?:一遍|一次)?|再听一遍|再来(?:一遍|一次)?|重来|开始)$/u.test(command)) return "demo";
  if (/^(?:慢一点|再慢一点|弹慢一点|示范慢一点)$/u.test(command)) return "slower";
  if (/^(?:换一组|换一组三个音|换三个音|换一组音符|下一关|进入下一关|继续闯关)$/u.test(command)) return "next";
  if (/^(?:从头练|从头练琴|从第一关开始|重新从第一关开始)$/u.test(command)) return "reset";
  if (/^(?:弹钢琴|玩钢琴|切换到钢琴)$/u.test(command)) return "piano";
  if (/^(?:跟着唱|跟唱|切换到跟唱)$/u.test(command)) return "sing";
  if (/^(?:接音符|玩接音符|玩节奏|节奏游戏|切换到接音符)$/u.test(command)) return "rhythm";
  if (/^(?:换主题|换一个主题)$/u.test(command)) return "theme";
  if (/^(?:换成|换|用)?(?:动物|动物朋友)(?:主题)?$/u.test(command)) return "theme:animals";
  if (/^(?:换成|换|用)?(?:玩具|玩具伙伴)(?:主题)?$/u.test(command)) return "theme:toys";
  if (/^(?:换成|换|用)?(?:磁力块|磁力积木)(?:主题)?$/u.test(command)) return "theme:blocks";
  const named = command.match(/^(?:换成|换|用)?(奥特曼|奧特曼|奶龙|奶龍|植物大战僵尸|植物大戰殭屍|我的世界|minecraft|迷你特工队|迷你特工隊)(?:主题)?$/iu);
  if (named) {
    const title = named[1].toLowerCase();
    if (/奥特曼|奧特曼/u.test(title)) return "theme:ultraman";
    if (/奶龙|奶龍/u.test(title)) return "theme:nailong";
    if (/植物/u.test(title)) return "theme:plants-zombies";
    if (/我的世界|minecraft/u.test(title)) return "theme:minecraft";
    return "theme:mini-force";
  }
  return "";
}

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
   * onListeningChange(allowed) gates the host's ordinary speech recognition.
   */
  constructor({ onSpeak = () => ({ ok: true }), acquireMicrophone = async () => null,
    transcribe = async () => "", onClose = () => {}, onListeningChange = () => {}, onThemeRequest = null, document: doc = globalThis.document,
    audioContextFactory, MediaRecorder: Recorder = globalThis.MediaRecorder, storage,
    later, cancelLater, now = () => globalThis.performance?.now?.() || Date.now(), recordingMs = 4500 } = {}) {
    if (!doc?.body) throw new Error("Music studio needs a document body");
    this.doc = doc; this.win = doc.defaultView || globalThis;
    this.onSpeak = onSpeak; this.acquireMicrophone = acquireMicrophone; this.transcribe = transcribe; this.onClose = onClose;
    this.onListeningChange = onListeningChange; this.listeningAllowed = null;
    this.onThemeRequest = onThemeRequest; this.themeGeneration = 0; this.themeArtwork = new Map();
    this.audioContextFactory = audioContextFactory || (() => new (this.win.AudioContext || this.win.webkitAudioContext)());
    this.Recorder = Recorder; this.later = later || ((fn, ms) => this.win.setTimeout(fn, ms));
    this.cancelLater = cancelLater || (handle => this.win.clearTimeout(handle)); this.now = now; this.recordingMs = recordingMs;
    this.opened = false; this.destroyed = false; this.mode = "piano"; this.context = null; this.demoTimers = []; this.demoActive = false;
    this.journey = new MusicJourney(); this.practiceStorage = null;
    try { this.practiceStorage = storage === undefined ? this.win.localStorage : storage; this.journey.restoreProgress(this.practiceStorage?.getItem(MUSIC_PROGRESS_KEY)); }
    catch (_) { /* A private/restricted browser still has a complete in-memory game. */ }
    this.demoGroup = 0; this.reference = this.journey.lesson.notes; this.demoStepMs = 550; this.tones = new Set();
    this.themeIndex = 0; this.rhythmRound = null; this.rhythmTimer = null; this.pendingPraise = null; this.narrationActive = false;
    this.performance = []; this.recording = null; this.recordingTimer = null; this.generation = 0;
    this._build();
    this._keydown = event => this._onKeydown(event);
    doc.addEventListener("keydown", this._keydown, true);
    this._visibility = () => {
      if (!this.opened) return;
      if (doc.hidden) { this.generation++; this._clearDemo(); this._cancelRecording(); this.feedback.textContent = "先休息一下，回来点开始，我们接着玩。"; this._setListeningAllowed(false); }
      else this._setListeningAllowed(true);
    };
    doc.addEventListener("visibilitychange", this._visibility);
  }

  _node(tag, className = "", text = "") { const node = this.doc.createElement(tag); node.className = className; node.textContent = text; return node; }
  _button(text, action, className = "") { const node = this._node("button", `music-studio__button ${className}`, text); node.type = "button"; node.addEventListener("click", action); return node; }
  _build() {
    this.element = this._node("section", "music-studio"); this.element.hidden = true;
    this.element.setAttribute("role", "dialog"); this.element.setAttribute("aria-modal", "true"); this.element.setAttribute("aria-label", "和爸爸玩音乐");
    const header = this._node("header", "music-studio__header"); this.back = this._button("← 返回", () => this.close(), "music-studio__back");
    const heading = this._node("div", "music-studio__heading"); heading.append(this._node("h2", "", "小小音乐屋"), this._node("p", "", "一小段一小段，弹出自己的旋律")); header.append(this.back, heading);
    const modes = this._node("nav", "music-studio__modes"); this.pianoButton = this._button("弹钢琴", () => { this.setMode("piano"); void this.demo(); });
    this.rhythmButton = this._button("接音符", () => { this.setMode("rhythm"); void this.demo(); });
    this.singButton = this._button("跟着唱", () => this.setMode("sing")); modes.append(this.pianoButton, this.rhythmButton, this.singButton);
    const content = this._node("div", "music-studio__content"); this.instruction = this._node("p", "music-studio__instruction"); this.instruction.setAttribute("role", "status");
    this.lessonHeading = this._node("div", "music-studio__lesson"); this.lessonTitle = this._node("strong"); this.journeyProgress = this._node("span");
    this.resetButton = this._button("从头练", () => this.resetPractice(), "music-studio__reset");
    this.resetButton.setAttribute("aria-label", "从第一关重新练习，仅重置音乐界面的练习进度");
    this.lessonHeading.append(this.lessonTitle, this.journeyProgress, this.resetButton);
    this.beatTrack = this._node("div", "music-studio__beats"); this.beats = [];
    this.rhythmStage = this._node("div", "music-studio__rhythm"); this.rhythmStage.setAttribute("aria-label", "音符沿五条路落向琴键，慢了会等你");
    this.lanes = [];
    for (const note of NOTES) { const lane = this._node("div", "music-studio__lane"); lane.dataset.note = note.id; this.lanes.push(lane); this.rhythmStage.append(lane); }
    this.landing = this._node("span", "music-studio__landing", "到这里，按同一个朋友"); this.rhythmStage.append(this.landing); this.tokens = [];
    this.keyboard = this._node("div", "music-studio__keys"); this.keyboard.setAttribute("role", "group"); this.keyboard.setAttribute("aria-label", "五个钢琴键"); this.keys = new Map();
    for (const note of NOTES) {
      const key = this._button(`${note.label}\n${note.key.toUpperCase()}`, () => this.playChildNote(note), "music-studio__key");
      key.dataset.note = note.id; key.setAttribute("aria-label", `${note.label}，电脑键 ${note.key.toUpperCase()}`); this.keys.set(note.id, key); this.keyboard.append(key);
    }
    const controls = this._node("div", "music-studio__controls"); this.demoButton = this._button("爸爸示范", () => void this.demo(), "music-studio__demo");
    this.nextButton = this._button("下一关 →", () => this.nextLesson(), "music-studio__next");
    this.slowButton = this._button("慢一点", () => this.handleVoiceCommand("慢一点"));
    this.themeButton = this._button("换主题", () => {
      this.themeChoices.hidden = !this.themeChoices.hidden; this.themeButton.setAttribute("aria-expanded", String(!this.themeChoices.hidden));
    });
    this.themeButton.setAttribute("aria-expanded", "false");
    this.themeChoices = this._node("div", "music-studio__themes"); this.themeChoices.hidden = true;
    this.themeChoices.setAttribute("role", "group"); this.themeChoices.setAttribute("aria-label", "选一个音乐主题");
    this.themeControls = MUSIC_THEMES.map(theme => { const control = this._button(theme.subject ? `${theme.title} · 预览` : theme.title, () => this.changeTheme(theme.id)); this.themeChoices.append(control); return control; });
    this.turnButton = this._button("轮到我唱", () => void this.startSinging(), "music-studio__turn"); controls.append(this.demoButton, this.nextButton, this.slowButton, this.themeButton, this.turnButton);
    this.feedback = this._node("p", "music-studio__feedback"); this.feedback.setAttribute("aria-live", "polite");
    this.privacy = this._node("p", "music-studio__privacy", "跟唱只在点“轮到我唱”后短暂使用麦克风，声音不保存。");
    content.append(this.lessonHeading, this.instruction, controls, this.themeChoices, this.beatTrack, this.rhythmStage, this.keyboard, this.feedback, this.privacy); this.element.append(header, modes, content); this.doc.body.append(this.element); this._syncReference(); this._render();
  }
  open() { if (this.destroyed || this.opened) return this; this.opened = true; this.focusBefore = this.doc.activeElement; this.overflowBefore = this.doc.body.style.overflow; this.doc.body.style.overflow = "hidden"; this.element.hidden = false; this._render(); this.back.focus({ preventScroll: true }); this._setListeningAllowed(true); return this; }
  close() { if (!this.opened) return; this.opened = false; this.generation++; this.themeGeneration++; this._clearDemo(); this._cancelRecording(); this._setListeningAllowed(false); this.element.hidden = true; this.doc.body.style.overflow = this.overflowBefore; try { this.onClose(); } finally { if (this.focusBefore?.isConnected) this.focusBefore.focus({ preventScroll: true }); } }
  destroy() { this.close(); this.destroyed = true; this.doc.removeEventListener("keydown", this._keydown, true); this.doc.removeEventListener("visibilitychange", this._visibility); this.context?.close?.(); this.element.remove(); }
  setMode(mode) { if (!this.opened || !["piano", "sing", "rhythm"].includes(mode)) return; this.generation++; this._clearDemo(); this._cancelRecording(); this.mode = mode; this.performance = []; this.journey.resetAttempt(); this.feedback.textContent = ""; this._syncReference(); this._render(); this._setListeningAllowed(true); }
  _setListeningAllowed(allowed) {
    const next = Boolean(allowed && this.opened && !this.destroyed && !this.doc.hidden);
    if (this.listeningAllowed === next) return;
    this.listeningAllowed = next; this.onListeningChange(next);
  }
  // Synchronous handled flag lets the host bypass unrelated chat/old game routing.
  // These commands never start a recording or acquire another microphone stream.
  handleVoiceCommand(text) {
    if (!this.opened || this.destroyed) return false;
    const command = parseMusicVoiceCommand(text); if (!command) return false;
    if (command === "reset") { this.resetPractice(); return true; }
    if (command.startsWith("theme")) { this.changeTheme(command.split(":")[1]); return true; }
    this.generation++; this._cancelRecording();
    if (["piano", "sing", "rhythm"].includes(command)) this.setMode(command);
    if (command === "slower") this.demoStepMs = Math.min(1100, this.demoStepMs + 250);
    if (command === "next") { this.nextLesson(); return true; }
    void this.demo();
    return true;
  }
  _syncReference() {
    this.reference = this.mode === "sing" ? DEMO_GROUPS[this.demoGroup] : this.journey.lesson.notes;
    this.beatTrack.replaceChildren(); this.beats = this.reference.map((_, index) => {
      const beat = this._node("span", "music-studio__beat"); beat.setAttribute("aria-label", `第${index + 1}个音`); this.beatTrack.append(beat); return beat;
    });
    this.beatTrack.setAttribute("aria-label", `${this.reference.length}个音的进度`); this._showBeats(0);
  }
  nextLesson() {
    if (!this.opened) return false;
    this.generation++; this._clearDemo(); this._cancelRecording();
    if (this.mode === "sing") this.demoGroup = (this.demoGroup + 1) % DEMO_GROUPS.length;
    else if (!this.journey.next()) { this.journey.resetAttempt(); }
    if (this.mode !== "sing") this._saveProgress();
    this.performance = []; this.feedback.textContent = ""; this._syncReference(); this._render(); void this.demo(); return true;
  }
  _saveProgress() {
    try { this.practiceStorage?.setItem(MUSIC_PROGRESS_KEY, JSON.stringify(this.journey.snapshot())); }
    catch (_) { /* Quota/security errors do not interrupt practice or create another store. */ }
  }
  resetPractice() {
    if (!this.opened) return false;
    this.generation++; this._clearDemo(); this._cancelRecording(); this.journey.resetProgress(); this.performance = [];
    if (this.mode === "sing") this.mode = "piano";
    this._saveProgress(); this.feedback.textContent = "从第一关慢慢练，爸爸陪你。"; this._syncReference(); this._render(); void this.demo(); return true;
  }
  changeTheme(id) {
    if (!this.opened) return;
    const index = MUSIC_THEMES.findIndex(theme => theme.id === id);
    this.themeIndex = index >= 0 ? index : (this.themeIndex + 1) % MUSIC_THEMES.length;
    const theme = MUSIC_THEMES[this.themeIndex], token = ++this.themeGeneration;
    this.themeChoices.hidden = true; this.themeButton.setAttribute("aria-expanded", "false"); this._renderTheme();
    this.feedback.textContent = `换成${theme.title}啦，琴键位置还是一样的。`;
    if (theme.subject && !this.themeArtwork.has(theme.id)) {
      this.feedback.textContent = this.onThemeRequest ? `正在准备${theme.title}主题预览，先用基础音符玩。` : `${theme.title}主题预览还没准备好，先用基础音符玩。`;
      if (this.onThemeRequest) Promise.resolve().then(() => {
        if (!this.opened || token !== this.themeGeneration) return null;
        return this.onThemeRequest(theme.subject, {
          isCurrent: () => this.opened && token === this.themeGeneration && MUSIC_THEMES[this.themeIndex].id === theme.id,
        });
      }).then(result => {
        if (token !== this.themeGeneration || !this.opened) return;
        const url = typeof result === "string" ? result : result?.url;
        if (url) this.setThemeArtwork(theme.subject, url);
      }).catch(() => {
        if (this.opened && token === this.themeGeneration) this.feedback.textContent = `${theme.title}图片这次没准备好，音乐仍然可以继续玩。`;
      });
    }
  }
  setThemeArtwork(subject, url) {
    const theme = MUSIC_THEMES[this.themeIndex]; if (!this.opened || theme.subject !== subject) return false;
    let source;
    try {
      const origin = this.win.location?.origin; if (!origin || origin === "null") return false;
      const parsed = new URL(String(url || ""), origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) return false;
      source = parsed.href;
    } catch (_) { return false; }
    this.themeArtwork.set(theme.id, source); this._renderTheme(); this.feedback.textContent = `${theme.title}主题预览准备好了，找相同形状来弹琴。`; return true;
  }
  _renderTheme() {
    const theme = MUSIC_THEMES[this.themeIndex]; this.element.dataset.theme = theme.id;
    this.themeButton.textContent = theme.subject ? `${theme.title} · 主题` : `${theme.symbols[0]} 换主题`;
    this.themeControls.forEach((control, index) => control.setAttribute("aria-pressed", String(index === this.themeIndex)));
    const artwork = this.themeArtwork.get(theme.id);
    for (const [index, note] of NOTES.entries()) {
      const key = this.keys.get(note.id); key.replaceChildren();
      if (artwork) key.append(this._themeImage(artwork, "music-studio__key-art", `${theme.title}主题预览`));
      key.append(this._node("span", "music-studio__key-label", artwork ? `${theme.symbols[index]} ${note.label}\n${note.key.toUpperCase()}` : `${theme.symbols[index]}\n${note.label}\n${note.key.toUpperCase()}`));
    }
    this.tokens.forEach((token, index) => this._renderToken(token, index));
  }
  _renderToken(token, index) {
    const theme = MUSIC_THEMES[this.themeIndex], symbol = theme.symbols[NOTES.findIndex(note => note.id === this.reference[index])];
    const artwork = this.themeArtwork.get(theme.id); token.replaceChildren();
    if (artwork) token.append(this._themeImage(artwork, "music-studio__token-art", ""));
    token.append(this._node("span", "music-studio__token-symbol", symbol));
  }
  _themeImage(source, className, alt) {
    const theme = MUSIC_THEMES[this.themeIndex], image = this._node("img", className); image.src = source; image.alt = alt;
    image.addEventListener("error", () => {
      if (this.themeArtwork.get(theme.id) !== source) return;
      this.themeArtwork.delete(theme.id);
      if (this.opened && MUSIC_THEMES[this.themeIndex].id === theme.id) { this._renderTheme(); this.feedback.textContent = `${theme.title}图片暂时打不开，先用基础音符继续玩。`; }
    }, { once: true }); return image;
  }
  _showBeats(done, active = -1) { this.beats.forEach((beat, index) => { beat.className = `music-studio__beat${index < done ? " is-done" : ""}${index === active ? " is-active" : ""}`; }); }
  _render() {
    const piano = this.mode === "piano", sing = this.mode === "sing", rhythm = this.mode === "rhythm", lesson = this.journey.lesson;
    this.element.dataset.mode = this.mode;
    this.pianoButton.setAttribute("aria-pressed", String(piano)); this.singButton.setAttribute("aria-pressed", String(sing)); this.rhythmButton.setAttribute("aria-pressed", String(rhythm));
    this.turnButton.hidden = !sing; this.slowButton.hidden = sing; this.themeButton.hidden = sing;
    this.nextButton.hidden = sing || !this.journey.finished || this.journey.isLast; this.demoButton.hidden = !this.nextButton.hidden;
    this.demoButton.textContent = sing ? "听三个参考音" : rhythm ? (this.journey.finished ? "再玩一遍" : "开始接音符") : this.journey.finished ? "再弹一次" : "爸爸示范";
    this.lessonHeading.hidden = sing; this.rhythmStage.hidden = !rhythm;
    this.lessonTitle.textContent = `第 ${this.journey.index + 1} 关 · ${lesson.title}`;
    this.journeyProgress.textContent = `已完成 ${this.journey.completed.size}/${this.journey.lessons.length}`;
    this.resetButton.hidden = this.journey.index === 0 && this.journey.completed.size === 0;
    this.instruction.textContent = piano ? `${lesson.skill}，跟着亮起的键试一试。` : rhythm ? "等朋友落到琴键上，按同一个朋友。" : "先听三个参考音，再点话筒轮到你。爸爸现在不能唱歌。";
    this.privacy.hidden = !sing;
    if (!this.feedback.textContent) this.feedback.textContent = sing ? "准备好后，点“轮到我唱”。" : rhythm ? "慢了也没关系，小伙伴会等你。" : "先听一遍，再从亮着的琴键开始。";
    this._renderTheme(); this._highlightExpected();
  }
  _onKeydown(event) {
    if (!this.opened || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
    if (this.recording) return;
    if (event.repeat) return; const note = KEY_NOTES.get(String(event.key || "").toLowerCase());
    if (note) { event.preventDefault(); this.playChildNote(note); }
  }
  _audio() { if (!this.context) this.context = this.audioContextFactory(); this.context.resume?.(); return this.context; }
  _tone(note, onEnded, durationMs = 780) {
    try {
      const context = this._audio(), start = context.currentTime || 0, gain = context.createGain(), oscillator = context.createOscillator();
      const duration = Math.max(.28, Math.min(2.5, durationMs / 1000));
      oscillator.type = "triangle"; oscillator.frequency.setValueAtTime(note.frequency, start); gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.24, start + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, start + duration - .03);
      const token = this.generation;
      this.tones.add(oscillator); oscillator.onended = () => {
        this.tones.delete(oscillator); oscillator.disconnect?.(); gain.disconnect?.(); onEnded?.();
        if (token === this.generation) this._afterTones();
      };
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + duration);
      return oscillator;
    } catch (_) { this.feedback.textContent = "琴音暂时没准备好，可以再点一次。"; return null; }
  }
  _flash(id) { const key = this.keys.get(id); if (!key) return; key.className = "music-studio__button music-studio__key is-playing"; this.demoTimers.push(this.later(() => { if (key.isConnected) { key.className = "music-studio__button music-studio__key"; this._highlightExpected(); } }, 330)); }
  _highlightExpected() {
    const expected = this.mode === "piano" && !this.demoActive && !this.journey.finished ? this.reference[this.journey.played.length]
      : this.mode === "rhythm" && this.rhythmRound?.waiting ? this.reference[this.rhythmRound.index] : null;
    for (const [id, key] of this.keys) key.setAttribute("data-expected", String(id === expected));
  }
  _afterTones() {
    if (!this.opened || this.tones.size || this.demoActive || this.recording || this.narrationActive) return;
    const praise = this.pendingPraise; this.pendingPraise = null;
    if (praise && praise.token === this.generation) void this._speakFeedback(praise.text, praise.token);
    else this._setListeningAllowed(true);
  }
  async _speakFeedback(text, token = this.generation) {
    if (!this.opened || token !== this.generation) return;
    this.narrationActive = true; this._setListeningAllowed(false);
    try { await this.onSpeak(text); } catch (_) { /* Visual feedback remains usable. */ }
    finally { if (this.opened && token === this.generation) { this.narrationActive = false; this._afterTones(); } }
  }
  _queuePraise(text) { this.pendingPraise = { text, token: this.generation }; this._afterTones(); }
  playChildNote(note) {
    if (!this.opened || this.recording || this.doc.hidden) return;
    // Wait for dad's model phrase; an extra child note must not lengthen or mix it.
    if (this.demoActive) return;
    this._setListeningAllowed(false); const oscillator = this._tone(note); this._flash(note.id);
    if (this.mode === "rhythm") this._playRhythmNote(note);
    else if (this.mode === "piano") {
      const result = this.journey.play(note.id, this.now()); this.performance = this.journey.played;
      this._showBeats(this.performance.length); this._highlightExpected();
      if (result.kind === "retry") {
        const expected = NOTES.find(item => item.id === result.expected);
        this.feedback.textContent = `这颗是${note.label}，接下来找亮着的${expected.label}。已经弹好的留着，我们接着来。`;
      } else if (result.kind === "progress") this.feedback.textContent = `接上了！再找${NOTES.find(item => item.id === this.reference[result.index]).label}。`;
      else if (result.kind === "complete") {
        this._saveProgress();
        const amount = this.reference.length === 3 ? "三个音" : `${this.reference.length}个音`;
        const rhythm = result.rhythmEven && !result.mistakes ? `节奏：${amount}很整齐。` : "你把这一小段弹完整了，下次可以再试试均匀的节拍。";
        const praise = `顺序：对啦，${amount}走对了。${rhythm}${this.journey.isLast ? "已经弹出欢乐颂的一段啦，可以换接音符再玩一次。" : "准备好就说下一关，爸爸陪你继续。"}`;
        this.feedback.textContent = praise; this._render(); this._queuePraise(praise);
      }
    }
    if (!oscillator) this._afterTones();
  }
  _clearDemo() {
    for (const timer of this.demoTimers) this.cancelLater(timer); this.demoTimers = []; this.demoActive = false; this.narrationActive = false; this.pendingPraise = null;
    this._stopRhythm();
    for (const oscillator of this.tones) { try { oscillator.stop(); } catch (_) {} } this.tones.clear();
    for (const key of this.keys.values()) key.className = "music-studio__button music-studio__key";
  }
  async demo() {
    if (this.mode === "rhythm") return this._startRhythm();
    if (!this.opened || this.recording) return; const token = ++this.generation; this.performance = []; this._clearDemo(); this.demoActive = true;
    if (this.mode === "piano") this.journey.resetAttempt();
    this._render(); this._highlightExpected();
    this._setListeningAllowed(false);
    const reference = this.reference, labels = reference.map(id => NOTES.find(note => note.id === id).label).join("、");
    const amount = reference.length === 3 ? "三个音" : `${reference.length}个音`;
    const words = this.mode === "sing" ? `爸爸现在只能说口型提示，不能唱歌。跟着${labels}慢慢张嘴，再听三个参考音。` : `听爸爸${this.demoStepMs > 550 ? "慢慢" : ""}弹${amount}：${labels}。等一等，再轮到你按。`;
    this._showBeats(0, 0); this.feedback.textContent = "爸爸正在示范…";
    try { const result = await this.onSpeak(words); if (token !== this.generation || !this.opened) return; if (result?.ok === false) this.feedback.textContent = result.error || "声音没播完，钢琴示范还可以继续听。"; } catch (_) { if (token === this.generation) this.feedback.textContent = "声音没播出来，钢琴示范还可以继续听。"; }
    if (token !== this.generation || !this.opened) return;
    const finishDemo = (played = true) => {
      if (token !== this.generation || !this.opened) return;
      this.demoActive = false;
      if (played) this.feedback.textContent = this.mode === "piano" ? "轮到你啦，从亮着的琴键开始，一颗一颗来。" : "这是参考音，不是在判断你唱得准不准。";
      this._showBeats(0); this._highlightExpected(); this._afterTones();
    };
    let beatOffset = 0;
    for (const [index, id] of reference.entries()) {
      const delay = beatOffset * this.demoStepMs; beatOffset += this.mode === "sing" ? 1 : this.journey.lesson.durations[index];
      this.demoTimers.push(this.later(() => {
      if (token !== this.generation || !this.opened) return;
      const last = index === reference.length - 1, note = NOTES.find(item => item.id === id);
      // The Web Audio ended event includes the final note's complete release tail.
      const duration = this.mode === "sing" ? 780 : Math.max(780, this.journey.lesson.durations[index] * this.demoStepMs);
      const oscillator = this._tone(note, last ? () => finishDemo() : undefined, duration); this._flash(id);
      this._showBeats(index + 1, index < reference.length - 1 ? index + 1 : -1);
      if (last && !oscillator) finishDemo(false);
      }, delay));
    }
  }
  _stopRhythm() {
    if (this.rhythmTimer !== null) { this.cancelLater(this.rhythmTimer); this.rhythmTimer = null; }
    this.rhythmRound?.stop(); this.rhythmRound = null;
    for (const token of this.tokens) token.remove(); this.tokens = [];
  }
  async _startRhythm() {
    if (!this.opened || this.recording) return;
    const token = ++this.generation; this._clearDemo(); this.journey.resetAttempt(); this._render(); this._showBeats(0);
    this.demoActive = true; this._setListeningAllowed(false); this.feedback.textContent = "听爸爸说怎么玩…";
    try { await this.onSpeak(`我们接${this.reference.length}个音符。等小伙伴落到下面，按同一个小伙伴的琴键。没赶上也没关系，它会等你。`); }
    catch (_) { /* Falling symbols and the landing line still explain the move. */ }
    if (!this.opened || token !== this.generation || this.mode !== "rhythm") return;
    this.demoActive = false;
    this.rhythmRound = new MusicRhythmRound(this.journey.lesson, { beatMs: this.demoStepMs + 350 }).start(this.now());
    this.demoButton.textContent = "再来一次";
    const theme = MUSIC_THEMES[this.themeIndex];
    this.tokens = this.reference.map((id, index) => {
      const lane = NOTES.findIndex(note => note.id === id), node = this._node("span", "music-studio__token", theme.symbols[lane]);
      node.setAttribute("aria-hidden", "true"); node.dataset.index = index; this.lanes[lane].append(node); this._renderToken(node, index); return node;
    });
    this.feedback.textContent = "准备，小伙伴出发啦！"; this._setListeningAllowed(true);
    const tick = () => {
      if (!this.opened || this.doc.hidden || token !== this.generation || !this.rhythmRound?.active) return;
      const at = this.now(), beganWaiting = this.rhythmRound.update(at);
      if (beganWaiting) { this.feedback.textContent = `它在等你，按亮着的${NOTES.find(note => note.id === this.reference[this.rhythmRound.index]).label}。`; this._highlightExpected(); }
      this._renderRhythm(at);
      this.rhythmTimer = this.later(tick, 33);
    };
    tick();
  }
  _renderRhythm(at) {
    if (!this.rhythmRound) return;
    const reduced = this.win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const travel = Math.max(40, (this.rhythmStage.clientHeight || 180) - 46);
    for (const item of this.rhythmRound.positions(at)) {
      const node = this.tokens[item.index]; if (!node) continue;
      node.hidden = item.caught || item.progress < 0 || (reduced && !item.current);
      node.style.transform = `translateY(${Math.max(0, Math.min(1, reduced ? 1 : item.progress)) * travel}px)`;
      node.className = `music-studio__token${item.current ? " is-current" : ""}`;
    }
  }
  _playRhythmNote(note) {
    const round = this.rhythmRound;
    if (!round?.active) { this.feedback.textContent = this.journey.finished ? "这一关接完啦，说下一关就能继续。" : "点开始接音符，小伙伴就出发。"; return; }
    const result = round.hit(note.id, this.now()); this._showBeats(round.index); this._renderRhythm(this.now()); this._highlightExpected();
    if (result.kind === "retry") this.feedback.textContent = `找和落下来的小伙伴一样的琴键，是${NOTES.find(item => item.id === result.expected).label}。`;
    else if (result.kind === "early") this.feedback.textContent = "找对朋友啦，再等它落到下面。";
    else if (result.kind === "hit") this.feedback.textContent = result.assisted ? "接到了，我们慢慢接下一个。" : "正好接上这一个！";
    else if (result.kind === "complete") {
      const summary = round.summary(); this.journey.markComplete(); this._saveProgress();
      const praise = `你接住了全部${summary.total}个小伙伴！${summary.onTime ? `其中${summary.onTime}个跟上了节拍。` : "你找到了每一个朋友对应的琴键。"}${this.journey.isLast ? "已经能接完整段欢乐颂啦，再选一种主题玩玩吧。" : "准备好就说下一关，爸爸陪你继续。"}`;
      this.feedback.textContent = praise; this._stopRhythm(); this._render(); this._queuePraise(praise);
    }
  }
  async startSinging() {
    if (!this.opened || this.mode !== "sing" || this.recording) return;
    if (!this.Recorder) { this.feedback.textContent = "这个浏览器不能短暂录音，所以这次没听清。"; return; }
    const token = ++this.generation; this._clearDemo(); this._setListeningAllowed(false);
    let stream;
    try { stream = await this.acquireMicrophone(); } catch (_) { stream = null; }
    if (!this.opened || this.mode !== "sing" || token !== this.generation) return;
    if (!stream) { this.feedback.textContent = "麦克风暂时没准备好，可以请大人帮忙后再试。"; this._setListeningAllowed(true); return; }
    let recorder;
    try { recorder = new this.Recorder(stream); } catch (_) { this.feedback.textContent = "这次没听清，可以再试一次。"; this._setListeningAllowed(true); return; }
    const chunks = [];
    this.recording = { recorder, chunks, token }; this._showBeats(0, 0); this.feedback.textContent = "现在轮到你唱，唱完会自己停下来。";
    recorder.addEventListener?.("dataavailable", event => { if (event.data?.size) chunks.push(event.data); });
    recorder.addEventListener?.("stop", () => void this._processRecording(token, recorder, chunks));
    try { recorder.start(); this.recordingTimer = this.later(() => this._finishRecording(), this.recordingMs); }
    catch (_) { this._cancelRecording(); this.feedback.textContent = "这次没听清，可以再试一次。"; if (this.opened && token === this.generation) this._setListeningAllowed(true); }
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
    finally {
      // Stale analysis must not reopen listening during a newer demonstration or after close.
      if (this.opened && token === this.generation && this.mode === "sing") this._setListeningAllowed(true);
      /* blob and recorder chunks are released after this turn; shared stream tracks stay untouched. */
    }
  }
  async _analyseBlob(blob) {
    try { const reference = this.reference, context = this._audio(), data = await blob.arrayBuffer(), decoded = await context.decodeAudioData(data); return analyseSingingSamples(decoded.getChannelData(0), decoded.sampleRate, reference); }
    catch (_) { return { heard: false, pitch: null, rhythm: null }; }
  }
}

globalThis.MusicStudio = MusicStudio;
