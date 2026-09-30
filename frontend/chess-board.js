// Rules: unchanged official npm chess.js 1.4.0 ESM distribution.
// https://registry.npmjs.org/chess.js/-/chess.js-1.4.0.tgz
// BSD-2-Clause: see vendor/LICENSE. No network, media, or storage in this module.
import { Chess } from "./vendor/chess.js";

const NAMES = { p: "兵", r: "车", n: "马", b: "象", q: "后", k: "王" };
const SYMBOLS = { w: { p: "♙", r: "♖", n: "♘", b: "♗", q: "♕", k: "♔" },
  b: { p: "♟", r: "♜", n: "♞", b: "♝", q: "♛", k: "♚" } };
const RULES = { p: "兵向前走，吃棋子时斜着走一格。", r: "车沿直线横着或竖着走，不能跳过别的棋子。",
  n: "马走一个小小的日字：先两格，再拐一格，可以跳过棋子。", b: "象沿斜线走，不能跳过别的棋子。",
  q: "后可以沿横线、竖线或斜线走，不能跳过棋子。", k: "王通常走相邻的一格，不能走到会被对方攻击的格子。" };
const LESSONS = [
  { kind: "board", name: "看看棋盘", fen: "7k/8/8/8/8/8/8/K7 w - - 0 1", to: "b4",
    text: "这是棋盘，有一格浅色、一格深色。先找找发光的深色格，轻轻点一下。",
    praise: "找到了！棋盘上的浅色和深色格子交错排队。", achievement: "我找到棋盘上的深色格啦！" },
  { kind: "pieces", name: "认识三颗棋子", fen: "7k/8/8/8/3R4/2N5/4P3/K7 w - - 0 1",
    pieces: [{ square: "e2", type: "p", name: "兵" }, { square: "d4", type: "r", name: "车" }, { square: "c3", type: "n", name: "马" }],
    text: "棋盘上有不同的棋子。先点发光的白兵，听听它叫什么。",
    praise: "你认出了兵、车和马！", achievement: "我认识兵、车和马啦！" },
  { name: "兵，向前一步", fen: "7k/8/8/8/8/8/4P3/K7 w - - 0 1", from: "e2", to: "e3", piece: "p",
    text: "轮到白兵走啦。点发光的白兵，再点前面的星星，让它向前走一格。",
    praise: "对啦！你让白兵向前走了一格，方向找对了。", achievement: "白兵向前一步，走到星星啦！" },
  { name: "车，沿直线走", fen: "7k/8/8/8/3R4/8/8/K7 w - - 0 1", from: "d4", to: "d7", piece: "r",
    text: "白车沿直线走。点发光的白车，再点星星，看看它怎样直着走。",
    praise: "对啦！你让白车沿着直线走了三格，中途没有拐弯。", achievement: "白车沿直线，走到星星啦！" },
  { name: "马，拐个小弯", fen: "7k/8/8/8/3N4/8/8/K7 w - - 0 1", from: "d4", to: "f5", piece: "n",
    text: "白马可以跳着拐弯。点发光的白马，再点星星，看看它跳到哪里。",
    praise: "对啦！你让白马向右两格、再向上一格，走出了小小的日字。", achievement: "白马拐个弯，跳到星星啦！" },
  { kind: "mate", name: "怎样赢一盘", fen: "7k/5K2/6P1/8/8/8/8/6R1 w - - 0 1", from: "g1", to: "h1", piece: "r",
    text: "把白车移到发光的星星，看看黑王还能不能逃走。王被将军又没有安全的路，就赢了。",
    praise: "黑王没有安全的路了！这叫将死，白棋赢了。", achievement: "我看到怎样赢一盘啦！" },
  { kind: "quiz", name: "换个办法认棋", fen: "7k/8/8/8/3R4/2N5/4P3/K7 w - - 0 1",
    pieces: [{ square: "d4", type: "r", name: "车", clue: "哪颗棋子沿直线走？" }, { square: "c3", type: "n", name: "马", clue: "哪颗棋子会拐弯跳？" }, { square: "e2", type: "p", name: "兵", clue: "哪颗棋子向前走？" }],
    text: "小考验来啦：哪颗棋子沿直线走？先自己找，想听提示再点按钮。",
    praise: "你按走法找到了三颗棋子。", achievement: "我试着自己认棋子啦！" },
  { kind: "free", name: "自己走一步", fen: "7k/8/8/8/3R4/2N5/4P3/K7 w - - 0 1",
    text: "现在你来选！点一颗白棋，再点一个亮起来的格子，自己走一步。",
    praise: "这一步是你自己选的！", achievement: "我自己选了一步棋！" },
];
const pieceName = piece => `${piece.color === "w" ? "白" : "黑"}${NAMES[piece.type || piece.piece]}`;

export class ChessBoard {
  static parseVoiceCommand(value) {
    if (typeof value !== "string" || value.length > 80) return null;
    const text = value.replace(/[\s，。！？、,.!?]/g, "").replace(/^(?:爸爸老师|爸爸)/, "")
      .replace(/^(?:请|帮我|给我)/, "").replace(/(?:吧|呀|啊|好吗|好不好)$/, "");
    const commands = [
      ["next", /^(?:下一[课課步关]|继续下一[课課步关]|开始下一[课課关])$/],
      ["hint", /^(?:提示(?:一下)?|给个提示|怎么走|该怎么走|这一步怎么走)$/],
      ["repeat", /^(?:再[听聽](?:一次|一遍)|再讲(?:一次|一遍)|再说(?:一次|一遍))$/],
      ["reset", /^(?:重来(?:这一步|一次)?|重新开始|重新开局)$/],
      ["restart", /^(?:再学一遍|重新学)$/],
      ["learn", /^(?:跟爸爸学)$/],
      ["play", /^(?:和爸爸下棋|和你下一盘|开始下棋)$/],
      ["undo", /^(?:悔棋|退回一步|撤回一步)$/],
      ["close", /^(?:退出(?:国际象棋|棋盘|下棋)|关闭(?:国际象棋|棋盘)|不下棋了)$/],
    ];
    return commands.find(([, pattern]) => pattern.test(text))?.[0] || null;
  }

  constructor({ onSpeak = () => {}, onClose = () => {}, onProgress = () => {}, document: doc = globalThis.document,
    later, cancelLater, random = Math.random, nativeFullscreen = true } = {}) {
    if (!doc?.body) throw new Error("Chess board needs a document body");
    this.doc = doc; this.win = doc.defaultView || globalThis;
    this.onSpeak = onSpeak; this.onClose = onClose; this.onProgress = onProgress; this.random = random; this.nativeFullscreen = nativeFullscreen;
    this.later = later || ((fn, delay) => this.win.setTimeout(fn, delay));
    this.cancelLater = cancelLater || (timer => this.win.clearTimeout(timer));
    this.isOpen = false; this.destroyed = false; this.mode = "learn"; this.lessonIndex = 0;
    this.lessonComplete = false; this.pieceStep = 0; this.quizHelp = 0; this.challengeResultSent = false;
    this.challengeLevel = "beginner"; this.unlockedLevel = "beginner";
    this.selected = null; this.focusSquare = "b4"; this.hintMove = null;
    // This small state machine is deliberately visual: a child can follow it without reading coordinates.
    this.guidancePhase = "source"; this.guidanceMove = { from: "b4" };
    this.timer = null; this.generation = 0; this.speechGeneration = 0; this.speaking = false;
    this.game = new Chess(LESSONS[0].fen); this.lastExplanation = LESSONS[0].text;
    this._build();
    this._keydown = event => {
      if (!this.isOpen) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); }
      else if (event.key === "Tab") {
        const controls = this.celebration && !this.celebration.hidden ? [this.continueButton, this.celebrationBack] : [...this.element.querySelectorAll("button")].filter(node => node !== this.continueButton && node !== this.celebrationBack && !node.disabled && !node.hidden && node.tabIndex >= 0);
        if (event.shiftKey && doc.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && doc.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    this._visibility = () => { this._cancelAi(); if (doc.hidden) this._clearConfetti(); else this._scheduleAi(); };
    this._fullscreen = () => { if (this.ownsFullscreen && doc.fullscreenElement !== this.element) this.ownsFullscreen = false; };
    doc.addEventListener("keydown", this._keydown, true);
    doc.addEventListener("visibilitychange", this._visibility);
    doc.addEventListener("fullscreenchange", this._fullscreen);
    this._render();
  }

  _node(tag, className, text = "") {
    const node = this.doc.createElement(tag); node.className = className; node.textContent = text; return node;
  }
  _button(text, action, className = "") {
    const button = this._node("button", `chess-board__button ${className}`, text);
    button.type = "button"; button.addEventListener("click", action); return button;
  }
  _build() {
    this.element = this._node("section", "chess-board"); this.element.hidden = true;
    // A second click after the modal disappears can otherwise hit a tool underneath.
    this.element.addEventListener("click", event => {
      if (event.detail > 1) { event.preventDefault(); event.stopPropagation(); }
    }, true);
    this.element.setAttribute("role", "dialog"); this.element.setAttribute("aria-modal", "true");
    this.element.setAttribute("aria-label", "和爸爸学国际象棋");
    const header = this._node("header", "chess-board__header");
    this.back = this._button("← 返回", () => this.close(), "chess-board__back");
    const heading = this._node("div", "chess-board__heading");
    heading.append(this._node("h2", "", "小小国际象棋"), this._node("p", "", "一步一步来，爸爸陪你想"));
    header.append(this.back, heading);
    const modes = this._node("nav", "chess-board__modes"); modes.setAttribute("aria-label", "选择玩法");
    this.learnButton = this._button("跟爸爸学", () => this.startMode("learn"));
    this.playButton = this._button("和爸爸下棋", () => this.startMode("play"));
    this.levelButton = this._button("初级爸爸", () => this.nextChallengeLevel());
    modes.append(this.learnButton, this.playButton, this.levelButton);
    this.stageRail = this._node("div", "chess-board__stages");
    this.stageRail.setAttribute("aria-label", "探索顺序");
    this.stageNodes = ["◩ 看棋盘", "♙ 认棋子", "↗ 试走法", "🏁 认输赢", "✦ 小考验", "♟ 自己走"].map(label => {
      const step = this._node("span", "chess-board__stage", label); this.stageRail.append(step); return step;
    });
    const content = this._node("div", "chess-board__content"), boardArea = this._node("div", "chess-board__board-area");
    this.grid = this._node("div", "chess-board__grid"); this.grid.setAttribute("role", "grid"); this.grid.setAttribute("aria-label", "国际象棋棋盘，白棋在下方");
    this.grid.addEventListener("touchmove", event => { if (this.isOpen && event.cancelable) event.preventDefault(); }, { passive: false });
    this.cells = new Map();
    for (let rank = 8; rank >= 1; rank--) for (let file = 0; file < 8; file++) {
      const square = `${String.fromCharCode(97 + file)}${rank}`;
      const cell = this._node("button", "chess-board__square"); cell.type = "button"; cell.dataset.square = square;
      cell.setAttribute("role", "gridcell");
      const symbol = this._node("span", "chess-board__piece"), coordinate = this._node("span", "chess-board__coordinate", square);
      const target = this._node("span", "chess-board__target", "★");
      symbol.setAttribute("aria-hidden", "true"); coordinate.setAttribute("aria-hidden", "true"); target.setAttribute("aria-hidden", "true");
      cell.append(symbol, coordinate, target); cell.addEventListener("click", () => this.selectSquare(square));
      cell.addEventListener("keydown", event => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
        if (!delta) return; event.preventDefault();
        const next = `${String.fromCharCode(97 + Math.max(0, Math.min(7, file + delta[0])))}${Math.max(1, Math.min(8, rank + delta[1]))}`;
        this.focusSquare = next; this._render(); this.cells.get(next).cell.focus();
      });
      this.cells.set(square, { cell, symbol, target, dark: (rank + file) % 2 === 1 }); this.grid.append(cell);
    }
    const svg = this.doc.createElementNS?.("http://www.w3.org/2000/svg", "svg") || this.doc.createElement("svg");
    svg.setAttribute("class", "chess-board__guide-path"); svg.setAttribute("viewBox", "0 0 800 800");
    svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    const defs = this.doc.createElementNS?.("http://www.w3.org/2000/svg", "defs") || this.doc.createElement("defs");
    const marker = this.doc.createElementNS?.("http://www.w3.org/2000/svg", "marker") || this.doc.createElement("marker");
    marker.setAttribute("id", "chess-guide-arrow"); marker.setAttribute("viewBox", "0 0 10 10"); marker.setAttribute("refX", "8"); marker.setAttribute("refY", "5"); marker.setAttribute("markerWidth", "6"); marker.setAttribute("markerHeight", "6"); marker.setAttribute("orient", "auto-start-reverse");
    const arrow = this.doc.createElementNS?.("http://www.w3.org/2000/svg", "path") || this.doc.createElement("path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z"); marker.append(arrow); defs.append(marker);
    this.guideLine = this.doc.createElementNS?.("http://www.w3.org/2000/svg", "line") || this.doc.createElement("line");
    this.guideLine.setAttribute("marker-end", "url(#chess-guide-arrow)"); svg.append(defs, this.guideLine); this.grid.append(svg);
    this.boardHint = this._node("p", "chess-board__board-hint");
    boardArea.append(this.grid, this.boardHint);
    const panel = this._node("aside", "chess-board__panel");
    this.lessonTitle = this._node("h3", "chess-board__lesson-title");
    this.feedback = this._node("p", "chess-board__feedback"); this.feedback.setAttribute("aria-live", "polite");
    this.turnLabel = this._node("p", "chess-board__turn"); this.turnLabel.setAttribute("role", "status");
    this.speechStatus = this._node("p", "chess-board__speech"); this.speechStatus.setAttribute("role", "status");
    const tools = this._node("div", "chess-board__tools");
    this.hintButton = this._button("给我提示", () => this.hint());
    this.repeatButton = this._button("再听一遍", () => this._speak());
    this.undoButton = this._button("悔棋一回合", () => this.undo());
    this.resetButton = this._button("重来这一步", () => this.reset());
    this.nextButton = this._button("下一课 →", () => this.nextLesson(), "chess-board__next");
    tools.append(this.hintButton, this.repeatButton, this.undoButton, this.resetButton, this.nextButton);
    panel.append(this.lessonTitle, this.turnLabel, this.feedback, tools, this.speechStatus);
    content.append(boardArea, panel); this.element.append(header, modes, this.stageRail, content); this.doc.body.append(this.element);
    this.activityParts = [header, modes, this.stageRail, content];
    this.celebration = this._node("div", "chess-board__celebration"); this.celebration.hidden = true;
    this.celebration.setAttribute("role", "dialog"); this.celebration.setAttribute("aria-modal", "true");
    this.celebration.setAttribute("aria-label", "太棒啦！过关了");
    const card = this._node("div", "chess-board__success-card");
    const trophy = this._node("div", "chess-board__trophy", "🏆"); trophy.setAttribute("aria-hidden", "true");
    this.successText = this._node("p", "chess-board__achievement");
    this.continueButton = this._button("下一课 →", () => this.mode === "play" ? this.reset() : this.nextLesson(), "chess-board__continue");
    this.celebrationBack = this._button("返回", () => this.close());
    card.append(trophy, this._node("h2", "", "太棒啦！"), this.successText, this.continueButton, this.celebrationBack);
    this.celebration.append(card); this.element.append(this.celebration);
    this.confettiAnimations = []; this.confetti = null;
  }

  _clearConfetti() {
    for (const animation of this.confettiAnimations) animation.cancel();
    this.confettiAnimations = []; this.confetti?.remove(); this.confetti = null;
  }
  _hideCelebration() {
    this._clearConfetti(); this.celebration.hidden = true;
    for (const part of this.activityParts) part.inert = false;
  }
  _showCelebration(animate = true) {
    if (!this.celebration.hidden) return;
    const last = this.lessonIndex === LESSONS.length - 1;
    this.successText.textContent = LESSONS[this.lessonIndex].achievement;
    this.continueButton.textContent = last ? "和爸爸下棋 →" : "继续探索 →";
    this.celebration.hidden = false;
    for (const part of this.activityParts) part.inert = true;
    this.continueButton.focus({ preventScroll: true });
    if (!animate || this.win.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !this.celebration.animate) return;
    const confetti = this.confetti = this._node("div", "chess-board__confetti");
    confetti.setAttribute("aria-hidden", "true"); this.celebration.append(confetti);
    // A bounded burst, transform/opacity only: no canvas, frame loop or new dependency.
    for (let i = 0; i < 20; i++) {
      const ribbon = this._node("i", "");
      ribbon.style.left = `${(i * 37) % 100}%`;
      ribbon.style.background = ["#d62929", "#e6ad20", "#205844", "#4081c3"][i % 4];
      confetti.append(ribbon);
      this.confettiAnimations.push(ribbon.animate([
        { transform: "translateY(-24px) rotate(0deg)", opacity: 1 },
        { transform: `translateY(${this.win.innerHeight + 24}px) rotate(${i % 2 ? 320 : -320}deg)`, opacity: 0 },
      ], { duration: 1500 + i % 4 * 150, delay: i % 5 * 50, easing: "ease-out" }));
    }
    Promise.allSettled(this.confettiAnimations.map(animation => animation.finished)).then(() => {
      if (this.confetti === confetti) this._clearConfetti();
    });
  }

  open() {
    if (this.destroyed || this.isOpen) return this;
    this.isOpen = true; this.focusBefore = this.doc.activeElement; this.overflowBefore = this.doc.body.style.overflow;
    this.doc.body.style.overflow = "hidden"; this.element.hidden = false; this._render(); this.back.focus({ preventScroll: true });
    const touchScreen = this.win.navigator?.maxTouchPoints > 0 || this.win.matchMedia?.("(pointer: coarse)").matches;
    if (this.nativeFullscreen && !touchScreen && this.element.requestFullscreen && !this.doc.fullscreenElement) {
      try { Promise.resolve(this.element.requestFullscreen()).then(() => {
        this.ownsFullscreen = this.doc.fullscreenElement === this.element;
        if (!this.isOpen && this.ownsFullscreen) Promise.resolve(this.doc.exitFullscreen?.()).catch(() => {});
      }).catch(() => {}); } catch (_) { /* Full-viewport overlay remains usable. */ }
    }
    this._speak();
    if (this.mode === "learn" && this.lessonComplete) this._showCelebration(false);
    return this;
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false; this.speechGeneration++; this.speaking = false; this._cancelAi(); this.selected = null;
    this._hideCelebration();
    this.element.hidden = true; this.doc.body.style.overflow = this.overflowBefore;
    if (this.doc.fullscreenElement === this.element) {
      try { Promise.resolve(this.doc.exitFullscreen?.()).catch(() => {}); } catch (_) {}
    }
    this.ownsFullscreen = false;
    // Cancelling host narration releases its busy/disabled entry button first.
    try { this.onClose(); }
    finally { if (this.focusBefore?.isConnected) this.focusBefore.focus({ preventScroll: true }); }
  }
  destroy() {
    this.close(); this.destroyed = true;
    this.doc.removeEventListener("keydown", this._keydown, true);
    this.doc.removeEventListener("visibilitychange", this._visibility);
    this.doc.removeEventListener("fullscreenchange", this._fullscreen); this.element.remove();
  }
  startMode(mode) {
    if (!this.isOpen || !["learn", "play"].includes(mode)) return;
    this.mode = mode; this.reset();
  }
  _showChallengeWin() {
    this._hideCelebration();
    this.successText.textContent = "你赢了爸爸老师！神秘礼物正在放进家长空间，等爸爸下班兑换。";
    this.continueButton.textContent = "再挑战一盘 →";
    this.celebration.hidden = false;
    for (const part of this.activityParts) part.inert = true;
    this.continueButton.focus({ preventScroll: true });
  }
  setRewardReceipt(saved) {
    if (!this.isOpen || this.mode !== "play" || !this.game.isCheckmate() || this.game.turn() !== "b") return;
    this.successText.textContent = saved
      ? "🎁 神秘礼物已放进家长空间，等爸爸下班兑换。"
      : "赢啦！礼物暂时没保存，请爸爸稍后查看。";
  }
  setUnlockedLevel(level) {
    if (!["beginner", "intermediate", "advanced"].includes(level)) return;
    this.unlockedLevel = level;
    const order = ["beginner", "intermediate", "advanced"];
    if (order.indexOf(this.challengeLevel) > order.indexOf(level)) this.challengeLevel = level;
    this._render();
  }
  nextChallengeLevel() {
    if (!this.isOpen || this.mode !== "play") return;
    const levels = ["beginner", "intermediate", "advanced"];
    const available = levels.slice(0, levels.indexOf(this.unlockedLevel) + 1);
    this.challengeLevel = available[(available.indexOf(this.challengeLevel) + 1) % available.length];
    this.reset();
  }
  _progress(kind, extra = {}) {
    try { this.onProgress({ kind, step: this.mode === "learn" ? LESSONS[this.lessonIndex].name : `${{ beginner: "初级", intermediate: "中级", advanced: "高级" }[this.challengeLevel]}爸爸`,
      ...extra }); } catch (_) { /* A failed receipt must never trap the child on the board. */ }
  }
  _finishLesson() {
    this.lessonComplete = true; this._setGuidance("complete"); this._showCelebration();
    this._progress("stage", { independent: this.quizHelp === 0 && this.lessonIndex === LESSONS.length - 2 });
  }
  _reportOutcome() {
    if (this.mode !== "play" || !this.game.isGameOver() || this.challengeResultSent) return;
    this.challengeResultSent = true;
    const result = this.game.isCheckmate() ? (this.game.turn() === "b" ? "win" : "loss") : "draw";
    this._progress("challenge", { level: this.challengeLevel, result, moves: this.game.history({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion || ""}`) });
    if (result === "win") {
      this._showChallengeWin();
    }
  }
  reset() {
    if (!this.isOpen) return;
    this._hideCelebration();
    this._cancelAi(); this.selected = null; this.hintMove = null; this.lessonComplete = false; this.pieceStep = 0; this.quizHelp = 0; this.challengeResultSent = false;
    if (this.mode === "learn") this.game.load(LESSONS[this.lessonIndex].fen); else this.game.reset();
    this._setGuidance(this.mode === "learn" && !["free", "quiz"].includes(LESSONS[this.lessonIndex].kind) ? "source" : "none");
    this._say(this.mode === "learn" ? LESSONS[this.lessonIndex].text : `挑战${{ beginner: "初级", intermediate: "中级", advanced: "高级" }[this.challengeLevel]}爸爸。你拿白棋，爸爸拿黑棋。白棋先走，点一颗白棋看看它能走到哪里。`);
  }
  nextLesson() {
    if (!this.isOpen || this.mode !== "learn" || !this.lessonComplete) return;
    if (this.lessonIndex === LESSONS.length - 1) { this.startMode("play"); return; }
    this.lessonIndex++; this.reset();
    const lesson = LESSONS[this.lessonIndex];
    this.cells.get(lesson.from || lesson.to || lesson.pieces?.[0].square || "e2").cell.focus({ preventScroll: true });
  }
  handleVoiceCommand(value) {
    if (!this.isOpen || this.destroyed) return false;
    const command = ChessBoard.parseVoiceCommand(value);
    if (!command) return false;
    if (command === "next") {
      if (this.mode === "learn" && this.lessonComplete) this.nextLesson();
      else if (this.mode === "learn") this._say(`我们先完成这一步。${LESSONS[this.lessonIndex].text}`);
      else this.hint();
    } else if (command === "hint") this.hint();
    else if (command === "repeat") this._speak();
    else if (command === "reset") this.reset();
    else if (command === "restart") { this.lessonIndex = 0; this.startMode("learn"); }
    else if (command === "learn" || command === "play") this.startMode(command);
    else if (command === "undo") {
      if (this.mode === "learn") this.reset();
      else this.undo();
    } else if (command === "close") this.close();
    return true;
  }
  _setGuidance(phase, move) {
    this.guidancePhase = phase;
    const lesson = LESSONS[this.lessonIndex];
    this.guidanceMove = move || ((phase === "source" || phase === "path") && this.mode === "learn"
      ? { from: lesson.from || lesson.pieces?.[this.pieceStep]?.square || lesson.to, to: lesson.from ? lesson.to : null } : null);
  }
  _syncGuidanceForSpeech() {
    if (this.mode === "learn" && !this.lessonComplete) {
      const lesson = LESSONS[this.lessonIndex];
      if (!["free", "quiz"].includes(lesson.kind)) this._setGuidance(this.selected === lesson.from ? "path" : "source");
    } else if (this.mode === "play" && this.guidancePhase === "path" && this.hintMove) {
      this._setGuidance("path", this.hintMove);
    }
  }
  _say(text) { this.lastExplanation = text; this._syncGuidanceForSpeech(); this._render(); this._speak(); }
  _speak() {
    if (!this.isOpen) return;
    // The host resolves onSpeak after playback or a bounded failure/cancel.
    // Finish explaining the child's move before the opponent takes its turn.
    if (this.mode === "play" && this.game.turn() === "b") this._cancelAi();
    this._syncGuidanceForSpeech(); this._render();
    const generation = ++this.speechGeneration; this.speaking = true; this.speechStatus.textContent = "爸爸老师来讲一讲…";
    const finish = () => {
      if (!this.isOpen || generation !== this.speechGeneration) return;
      this.speaking = false; this._scheduleAi();
    };
    try { Promise.resolve(this.onSpeak(this.lastExplanation)).then(result => {
      if (!this.isOpen || generation !== this.speechGeneration) return;
      this.speechStatus.textContent = result?.ok === false ? (result.error || "这次声音没播完，可以点再听一遍。") : "想再听一次，就点“再听一遍”。";
    }).catch(() => { if (this.isOpen && generation === this.speechGeneration) this.setSpeechError("声音暂时没接上，可以再听一遍。"); }).finally(finish); }
    catch (_) { this.setSpeechError("声音暂时没接上，可以再听一遍。"); finish(); }
  }
  setSpeechError(message) { if (this.isOpen) this.speechStatus.textContent = String(message || "声音暂时没接上，可以再听一遍。"); }

  getConversationContext() {
    if (!this.isOpen) return "";
    // A fresh, read-only snapshot for this question, never a saved activity.
    const learning = this.mode === "learn", lesson = LESSONS[this.lessonIndex];
    const selected = this.selected && this.game.get(this.selected);
    const intro = learning && ["board", "pieces", "quiz"].includes(lesson.kind);
    const moves = (intro ? [] : this.game.moves({ ...(selected ? { square: this.selected } : {}), verbose: true }))
      .filter(move => !move.promotion || move.promotion === "q");
    const moveText = move => `${move.from}→${move.to}${move.promotion ? "（自动升后）" : ""}`;
    const pieces = this.game.board().flat().filter(piece => piece && (!intro || (["pieces", "quiz"].includes(lesson.kind) && piece.type !== "k"))).map(piece => `${pieceName(piece)} ${piece.square}`);
    const status = (!learning && this._ending()) || (this.game.isCheck()
      ? `${this.game.turn() === "w" ? "白" : "黑"}王正在被将军，要先保护王。` : "没有被将军。");
    const lines = [
      `玩法：${learning ? "跟爸爸学" : "和爸爸下棋"}`,
      ...(learning ? [`本课：${lesson.name}`, `课堂目标：${this.lessonComplete ? "已完成，等待孩子继续；本课不自动走黑棋。"
        : lesson.kind === "board" ? "认识棋盘，点亮起的深色格。"
        : ["pieces", "quiz"].includes(lesson.kind) ? `当前问题：${lesson.pieces[Math.min(this.pieceStep, lesson.pieces.length - 1)].clue || `找白${lesson.pieces[Math.min(this.pieceStep, lesson.pieces.length - 1)].name}`}；答案 ${lesson.pieces[Math.min(this.pieceStep, lesson.pieces.length - 1)].square}。`
        : lesson.kind === "free" ? "孩子任选一颗白棋，走到任意合法亮格。"
        : `白${NAMES[lesson.piece]} ${lesson.from}→${lesson.to}；其他棋规合法走法不算完成本课目标。`}`] : []),
      `轮到：${this.game.turn() === "w" ? "孩子的白棋" : "爸爸的黑棋"}`,
      `棋局状态：${status}`,
      `当前棋子位置：${pieces.join("；")}`,
      `当前选中：${selected ? `${pieceName(selected)} ${this.selected}` : "未选中棋子"}`,
      `合法走法：${moves.slice(0, 24).map(moveText).join("；") || "无"}`,
      `走法范围：${selected ? "仅当前选中棋子" : "当前轮到的一方"}；${moves.length > 24
        ? `共${moves.length}条，仅列出前24条，未列出的走法不能据此断言非法。` : `共${moves.length}条。`}`,
      "刚才的讲解：",
    ];
    const summary = lines.join("\n");
    return summary + String(this.lastExplanation || "").slice(0, Math.max(0, 3000 - summary.length));
  }

  selectSquare(square) {
    if (!this.isOpen || !this.cells.has(square)) return false;
    // An extra tap must not interrupt the specific success explanation. The
    // child chooses next/replay/reset explicitly through a button or voice.
    if (this.mode === "learn" && this.lessonComplete) return false;
    const lesson = LESSONS[this.lessonIndex];
    if (this.mode === "learn" && lesson.kind === "board") {
      if (square !== lesson.to) { this._say("看看发光的深色格，它和旁边的浅色格不一样。再找一次。" ); return false; }
      this._finishLesson();
      this._say(`${lesson.praise}准备好就点“继续探索”，看看棋子。`); return true;
    }
    if (this.mode === "learn" && ["pieces", "quiz"].includes(lesson.kind)) {
      const target = lesson.pieces[this.pieceStep];
      if (square !== target.square) {
        if (lesson.kind === "quiz") this.quizHelp++;
        this._say(lesson.kind === "quiz" ? `这颗是${this.game.get(square) ? pieceName(this.game.get(square)) : "空格"}。再想想：${target.clue}` : `这是${this.game.get(square) ? pieceName(this.game.get(square)) : "空格"}。先找发光的白${target.name}。`); return false;
      }
      this.pieceStep++;
      if (this.pieceStep === lesson.pieces.length) {
        this._finishLesson();
        this._say(`${lesson.praise}${lesson.kind === "quiz" && this.quizHelp ? "刚才有几次需要提示，下次可以再试试。" : ""}准备好就点“继续探索”。`);
      } else {
        this._setGuidance(lesson.kind === "quiz" ? "none" : "source");
        this._say(lesson.kind === "quiz" ? `对，这是白${target.name}。接着想想：${lesson.pieces[this.pieceStep].clue}` : `对，这颗叫白${target.name}。现在找发光的白${lesson.pieces[this.pieceStep].name}。`);
      }
      return true;
    }
    if (this.mode === "play" && this.game.isGameOver()) { this._say(this._ending()); return false; }
    if (this.game.turn() !== "w") { this._say("现在轮到爸爸的黑棋，等他走一步。"); return false; }
    const piece = this.game.get(square);
    if (piece?.color === "w") {
      this.selected = this.selected === square ? null : square; this.focusSquare = square; this.hintMove = null;
      const legal = this.selected ? this.game.moves({ square, verbose: true }) : [];
      if (this.mode === "learn") {
        this._setGuidance(lesson.kind === "free" ? "none" : this.selected === lesson.from ? "path" : "source");
      } else this._setGuidance("none");
      this._say(!this.selected ? "先选一颗白棋，我们再一起看。" : legal.length ? `${pieceName(piece)}。${RULES[piece.type]}看看亮起的格子。` : "这颗棋子现在没有合法走法，换一颗白棋试试。");
      return false;
    }
    if (!this.selected) { this._say("我们拿白棋，先点一颗白色棋子。亮起的格子会告诉你可以走到哪里。"); return false; }
    const legal = this.game.moves({ square: this.selected, verbose: true }).find(move => move.to === square && (!move.promotion || move.promotion === "q"));
    if (!legal) {
      this._say(this.game.isCheck() ? "白王正在被将军，要先保护白王。试试亮起的合法格子。" : `这一步现在不能走。${RULES[this.game.get(this.selected).type]}再看看亮起的格子。`);
      return false;
    }
    if (this.mode === "learn") {
      if (lesson.kind !== "free" && (legal.from !== lesson.from || legal.to !== lesson.to)) {
        this._say(`这步在下棋时可以走。这次先把发光的白${NAMES[lesson.piece]}送到星星格。`); return false;
      }
    }
    const move = this.game.move({ from: legal.from, to: legal.to, promotion: "q" });
    this.selected = null; this.hintMove = null;
    if (this.mode === "learn") {
      this._finishLesson();
      this._say(`${lesson.praise}${lesson.kind === "free" ? `你让白${NAMES[move.piece]}走到了亮起的格子。` : this._moveText(move).replace(/从 [a-h][1-8] 走到 [a-h][1-8]/, "走到了星星格")}${this.lessonIndex < LESSONS.length - 1 ? "准备好可以点或说‘下一课’。" : "准备好就点‘和爸爸下棋’，一起玩一盘。"}`);
    }
    else { this._setGuidance("none"); this._reportOutcome(); this._say(this._moveText(move) + (this._ending() || "现在轮到爸爸的黑棋。")); this._scheduleAi(); }
    return true;
  }
  _moveText(move) {
    let text = `${move.color === "w" ? "你的白" : "爸爸的黑"}${NAMES[move.piece]}从 ${move.from} 走到 ${move.to}。`;
    if (move.captured) text += `吃掉了${move.color === "w" ? "黑" : "白"}${NAMES[move.captured]}。`;
    if (move.promotion) text += "兵到了底线，自动升成后。";
    if (move.isKingsideCastle() || move.isQueensideCastle()) text += "这一步是王车易位，王和车一起换了位置。";
    if (move.isEnPassant()) text += "这一步是吃过路兵，旁边刚走两格的兵被吃掉了。";
    return text;
  }
  _ending() {
    if (this.game.isCheckmate()) return this.game.turn() === "w" ? "白王被将死了，这盘黑棋赢了。我们可以悔一步一起看看，也可以再开一盘。" : "黑王被将死了，这盘白棋赢了！可以再开一盘。";
    if (this.game.isStalemate()) return "轮到的一方没有合法走法，王也没有被将军。这叫逼和，这盘平局。";
    if (this.game.isInsufficientMaterial()) return "剩下的棋子不足以将死对方，这盘平局。";
    if (this.game.isThreefoldRepetition()) return "同一个局面出现了三次，这盘按三次重复判为平局。";
    if (this.game.isDrawByFiftyMoves()) return "已经连续五十回合没有吃子、也没有走兵，这盘按五十回合规则判为平局。";
    return "";
  }
  _cancelAi() { this.generation++; if (this.timer !== null) this.cancelLater(this.timer); this.timer = null; }
  _scheduleAi() {
    if (!this.isOpen || this.doc.hidden || this.speaking || this.mode !== "play" || this.game.turn() !== "b" || this.game.isGameOver() || this.timer !== null) return;
    this._setGuidance("none"); this._render();
    const generation = this.generation;
    this.timer = this.later(() => {
      if (generation !== this.generation || !this.isOpen || this.doc.hidden || this.mode !== "play" || this.game.turn() !== "b") return;
      this.timer = null; const moves = this.game.moves({ verbose: true }).filter(move => !move.promotion || move.promotion === "q"); if (!moves.length) return;
      let legal = moves[Math.min(moves.length - 1, Math.max(0, Math.floor(this.random() * moves.length)))];
      if (this.challengeLevel !== "beginner") {
        const value = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
        let best = -Infinity;
        for (const candidate of moves) {
          this.game.move({ from: candidate.from, to: candidate.to, promotion: candidate.promotion || "q" });
          const score = (candidate.captured ? value[candidate.captured] * 12 : 0)
            + (this.game.isCheckmate() ? 1000 : this.game.isCheck() ? 8 : 0)
            + (this.challengeLevel === "advanced" && !this.game.isGameOver()
              ? (this.game.moves({ verbose: true }).some(reply => reply.to === candidate.to && reply.captured) ? -value[candidate.piece] * 10 : 0) : 0);
          this.game.undo();
          if (score > best) { best = score; legal = candidate; }
        }
      }
      const move = this.game.move({ from: legal.from, to: legal.to, promotion: legal.promotion || "q" });
      this._reportOutcome();
      this._say(this._moveText(move) + (this._ending() || (this.game.isCheck() ? "白王被将军了。这次要先保护白王。" : "现在轮到你的白棋。")));
    }, 650);
  }
  undo() {
    if (!this.isOpen || this.mode !== "play") return;
    this._cancelAi(); const move = this.game.undo(); if (!move) return;
    if (move.color === "b") this.game.undo();
    this.selected = null; this.hintMove = null; this._setGuidance("none");
    this._say("这一回合收回来了。轮到你的白棋，我们慢慢再想一步。");
  }
  hint() {
    if (!this.isOpen) return;
    if (this.mode === "learn") {
      if (this.lessonComplete) { this._speak(); return; }
      const lesson = LESSONS[this.lessonIndex];
      if (lesson.kind === "board" || lesson.kind === "pieces") { this._setGuidance("source"); this._say(lesson.kind === "pieces" ? `找发光的白${lesson.pieces[this.pieceStep].name}，点一下。` : lesson.text); return; }
      if (lesson.kind === "free") {
        const move = this.game.moves({ verbose: true }).find(item => item.piece !== "k");
        if (move) { this.selected = move.from; this._setGuidance("path", move); this._say(`可以试试这颗白${NAMES[move.piece]}，点星星格。也可以自己选别的亮格。`); }
        return;
      }
      if (lesson.kind === "quiz") {
        this.quizHelp++;
        this._setGuidance("source");
        this._say(`这颗是白${lesson.pieces[this.pieceStep].name}。你可以点亮起来的棋子。`);
        return;
      }
      this.selected = lesson.from; this._setGuidance("path", { from: lesson.from, to: lesson.to }); this._say(lesson.text); return;
    }
    if (this.game.isGameOver()) { this._say(this._ending()); return; }
    if (this.game.turn() !== "w") { this._say("现在轮到黑棋，等爸爸走好，再一起想白棋的下一步。"); return; }
    const moves = this.game.moves({ verbose: true }), move = moves.find(item => item.captured) || moves[0];
    if (!move) return; this.selected = move.from; this.hintMove = move; this._setGuidance("path", move);
    this._say(`一个可以试的走法：把白${NAMES[move.piece]}从 ${move.from} 走到星星 ${move.to}。先点棋子，再点目标格。`);
  }
  _render() {
    const lesson = LESSONS[this.lessonIndex], learning = this.mode === "learn";
    const intro = learning && ["board", "pieces", "quiz"].includes(lesson.kind);
    const legal = new Set(!intro && this.selected ? this.game.moves({ square: this.selected, verbose: true }).map(move => move.to) : []);
    const guide = this.guidanceMove;
    const showSource = this.guidancePhase === "source" || this.guidancePhase === "path";
    const showPath = this.guidancePhase === "path" && guide?.from && guide?.to;
    const targetSquare = showPath ? guide.to : this.hintMove?.to;
    for (const [square, { cell, symbol, target, dark }] of this.cells) {
      const piece = this.game.get(square);
      const completed = learning && this.lessonComplete && square === (lesson.to || (["pieces", "quiz"].includes(lesson.kind) ? lesson.pieces.at(-1).square : null));
      cell.className = `chess-board__square${dark ? " is-dark" : ""}${this.selected === square ? " is-selected" : ""}${legal.has(square) ? " is-legal" : ""}${showSource && guide?.from === square ? " is-guidance-source" : ""}${showPath && guide?.to === square ? " is-guidance-target" : ""}${completed ? " is-complete" : ""}`;
      symbol.textContent = piece && !(intro && (lesson.kind === "board" || piece.type === "k")) ? SYMBOLS[piece.color][piece.type] : ""; symbol.className = `chess-board__piece ${piece?.color === "w" ? "is-white" : "is-black"}`;
      target.hidden = (intro || targetSquare !== square) && !completed; target.textContent = completed ? "✓" : "★"; cell.tabIndex = this.focusSquare === square ? 0 : -1;
      cell.setAttribute("aria-selected", String(this.selected === square));
      cell.setAttribute("aria-label", `${square}，${piece ? pieceName(piece) : "空格"}${legal.has(square) ? "，合法目标" : ""}${showSource && guide?.from === square ? "，先点这里" : ""}${showPath && guide?.to === square ? "，沿箭头到这里" : ""}${targetSquare === square ? "，星星目标" : ""}${completed ? "，这一步完成了" : ""}`);
    }
    this.element.dataset.guidancePhase = this.guidancePhase;
    this.grid.dataset.guidancePhase = this.guidancePhase;
    // SVG does not consistently reflect the HTML `hidden` property, so set the
    // attribute as well as the test-friendly property.
    this.guideLine.hidden = !showPath;
    if (showPath) this.guideLine.removeAttribute?.("hidden");
    else this.guideLine.setAttribute("hidden", "");
    if (showPath) {
      const point = square => {
        const file = square.charCodeAt(0) - 97, rank = Number(square[1]);
        return { x: file * 100 + 50, y: (8 - rank) * 100 + 50 };
      };
      const from = point(guide.from), to = point(guide.to);
      this.guideLine.setAttribute("x1", String(from.x)); this.guideLine.setAttribute("y1", String(from.y));
      this.guideLine.setAttribute("x2", String(to.x)); this.guideLine.setAttribute("y2", String(to.y));
    }
    this.learnButton.setAttribute("aria-pressed", String(learning)); this.playButton.setAttribute("aria-pressed", String(!learning));
    this.element.dataset.mode = this.mode;
    this.stageRail.hidden = !learning;
    const stage = this.lessonIndex === 0 ? 0 : this.lessonIndex === 1 ? 1 : this.lessonIndex <= 4 ? 2 : this.lessonIndex === 5 ? 3 : this.lessonIndex === 6 ? 4 : 5;
    this.stageNodes.forEach((node, index) => { node.className = `chess-board__stage${index === stage ? " is-current" : ""}${index < stage ? " is-visited" : ""}`; node.setAttribute("aria-current", index === stage ? "step" : "false"); });
    this.levelButton.hidden = learning;
    this.levelButton.textContent = `${{ beginner: "初级", intermediate: "中级", advanced: "高级" }[this.challengeLevel]}爸爸 · 换级别`;
    this.lessonTitle.textContent = learning ? lesson.name : `挑战${{ beginner: "初级", intermediate: "中级", advanced: "高级" }[this.challengeLevel]}爸爸`;
    this.feedback.textContent = this.lastExplanation;
    this.boardHint.className = `chess-board__board-hint${learning && this.lessonComplete ? " is-success" : ""}`;
    this.boardHint.textContent = learning && this.lessonComplete ? `✓ ${lesson.achievement} 点“${this.lessonIndex < LESSONS.length - 1 ? "继续探索" : "和爸爸下棋"}”就能继续。` : learning && lesson.kind === "board" ? "浅色、深色交错排队。点发光的深色格。" : learning && lesson.kind === "pieces" ? `找白${lesson.pieces[this.pieceStep].name}，点发光的棋子。` : learning && lesson.kind === "quiz" ? lesson.pieces[this.pieceStep].clue : learning && lesson.kind === "free" ? "你来选一颗白棋，再点亮起来的格子。" : "先点自己的棋子，再点亮起的格子。白棋在你这边。";
    this.turnLabel.textContent = learning ? (this.lessonComplete ? "这一步完成了 ✓" : intro ? "看一看，点一下" : lesson.kind === "free" ? "自己选一步" : "把棋子送到星星格")
      : this._ending() || (this.game.turn() === "w" ? (this.game.isCheck() ? "白王被将军，先保护王" : "轮到你啦 · 白棋走") : "爸爸想一想 · 黑棋走");
    this.undoButton.hidden = learning; this.undoButton.disabled = this.game.history().length === 0;
    this.resetButton.textContent = learning ? "重来这一步" : "重新开局";
    this.nextButton.hidden = !learning; this.nextButton.disabled = !this.lessonComplete; this.nextButton.textContent = this.lessonIndex === LESSONS.length - 1 ? "和爸爸下棋 →" : "继续探索 →";
  }
}

globalThis.ChessBoard = ChessBoard;
