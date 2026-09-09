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
  { name: "兵，向前一步", fen: "7k/8/8/8/8/8/4P3/K7 w - - 0 1", from: "e2", to: "e3", piece: "p",
    text: "先认识白兵。点一下 e2 的白兵，再点星星 e3，让它向前走一格。" },
  { name: "车，沿直线走", fen: "7k/8/8/8/3R4/8/8/K7 w - - 0 1", from: "d4", to: "d7", piece: "r",
    text: "这次认识白车。点 d4 的白车，再点星星 d7，沿着直线向前走。" },
  { name: "马，拐个小弯", fen: "7k/8/8/8/3N4/8/8/K7 w - - 0 1", from: "d4", to: "f5", piece: "n",
    text: "白马走日字。点 d4 的白马，再点星星 f5：向右两格，再向上一格。" },
];
const pieceName = piece => `${piece.color === "w" ? "白" : "黑"}${NAMES[piece.type || piece.piece]}`;

export class ChessBoard {
  constructor({ onSpeak = () => {}, onClose = () => {}, document: doc = globalThis.document,
    later, cancelLater, random = Math.random, nativeFullscreen = true } = {}) {
    if (!doc?.body) throw new Error("Chess board needs a document body");
    this.doc = doc; this.win = doc.defaultView || globalThis;
    this.onSpeak = onSpeak; this.onClose = onClose; this.random = random; this.nativeFullscreen = nativeFullscreen;
    this.later = later || ((fn, delay) => this.win.setTimeout(fn, delay));
    this.cancelLater = cancelLater || (timer => this.win.clearTimeout(timer));
    this.isOpen = false; this.destroyed = false; this.mode = "learn"; this.lessonIndex = 0;
    this.lessonComplete = false; this.selected = null; this.focusSquare = "e2"; this.hintMove = null;
    // This small state machine is deliberately visual: a child can follow it without reading coordinates.
    this.guidancePhase = "source"; this.guidanceMove = { from: "e2", to: "e3" };
    this.timer = null; this.generation = 0; this.speechGeneration = 0; this.speaking = false;
    this.game = new Chess(LESSONS[0].fen); this.lastExplanation = LESSONS[0].text;
    this._build();
    this._keydown = event => {
      if (!this.isOpen) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); }
      else if (event.key === "Tab") {
        const controls = [...this.element.querySelectorAll("button")].filter(node => !node.disabled && !node.hidden && node.tabIndex >= 0);
        if (event.shiftKey && doc.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && doc.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    this._visibility = () => { this._cancelAi(); if (!doc.hidden) this._scheduleAi(); };
    this._fullscreen = () => { if (this.ownsFullscreen && doc.fullscreenElement !== this.element) this.close(); };
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
    modes.append(this.learnButton, this.playButton);
    const content = this._node("div", "chess-board__content"), boardArea = this._node("div", "chess-board__board-area");
    this.grid = this._node("div", "chess-board__grid"); this.grid.setAttribute("role", "grid"); this.grid.setAttribute("aria-label", "国际象棋棋盘，白棋在下方");
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
    boardArea.append(this.grid, this._node("p", "chess-board__board-hint", "先点自己的棋子，再点亮起的格子。白棋在你这边。"));
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
    content.append(boardArea, panel); this.element.append(header, modes, content); this.doc.body.append(this.element);
  }

  open() {
    if (this.destroyed || this.isOpen) return this;
    this.isOpen = true; this.focusBefore = this.doc.activeElement; this.overflowBefore = this.doc.body.style.overflow;
    this.doc.body.style.overflow = "hidden"; this.element.hidden = false; this._render(); this.back.focus({ preventScroll: true });
    if (this.nativeFullscreen && this.element.requestFullscreen && !this.doc.fullscreenElement) {
      try { Promise.resolve(this.element.requestFullscreen()).then(() => {
        this.ownsFullscreen = this.doc.fullscreenElement === this.element;
        if (!this.isOpen && this.ownsFullscreen) Promise.resolve(this.doc.exitFullscreen?.()).catch(() => {});
      }).catch(() => {}); } catch (_) { /* Full-viewport overlay remains usable. */ }
    }
    this._speak(); return this;
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false; this.speechGeneration++; this.speaking = false; this._cancelAi(); this.selected = null;
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
    this.mode = mode; if (mode === "learn") this.lessonIndex = 0; this.reset();
  }
  reset() {
    if (!this.isOpen) return;
    this._cancelAi(); this.selected = null; this.hintMove = null; this.lessonComplete = false;
    if (this.mode === "learn") this.game.load(LESSONS[this.lessonIndex].fen); else this.game.reset();
    this._setGuidance(this.mode === "learn" ? "source" : "none");
    this._say(this.mode === "learn" ? LESSONS[this.lessonIndex].text : "你拿白棋，爸爸拿黑棋。白棋先走，点一颗白棋看看它能走到哪里。兵走到底线时，我们会自动把它变成后。");
  }
  nextLesson() {
    if (!this.isOpen || this.mode !== "learn" || !this.lessonComplete) return;
    this.lessonIndex = (this.lessonIndex + 1) % LESSONS.length; this.reset();
  }
  _setGuidance(phase, move) {
    this.guidancePhase = phase;
    const lesson = LESSONS[this.lessonIndex];
    this.guidanceMove = move || ((phase === "source" || phase === "path") && this.mode === "learn"
      ? { from: lesson.from, to: lesson.to } : null);
  }
  _syncGuidanceForSpeech() {
    if (this.mode === "learn" && !this.lessonComplete) {
      const lesson = LESSONS[this.lessonIndex];
      this._setGuidance(this.selected === lesson.from ? "path" : "source", { from: lesson.from, to: lesson.to });
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
    const moves = this.game.moves({ ...(selected ? { square: this.selected } : {}), verbose: true })
      .filter(move => !move.promotion || move.promotion === "q");
    const moveText = move => `${move.from}→${move.to}${move.promotion ? "（自动升后）" : ""}`;
    const pieces = this.game.board().flat().filter(Boolean).map(piece => `${pieceName(piece)} ${piece.square}`);
    const status = (!learning && this._ending()) || (this.game.isCheck()
      ? `${this.game.turn() === "w" ? "白" : "黑"}王正在被将军，要先保护王。` : "没有被将军。");
    const lines = [
      `玩法：${learning ? "跟爸爸学" : "和爸爸下棋"}`,
      ...(learning ? [`本课：${lesson.name}`, `课堂目标：${this.lessonComplete ? "已完成，准备好可点下一课；本课不自动走黑棋。"
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
    if (this.mode === "learn" && this.lessonComplete) { this._say("这一步完成了。可以点下一课，也可以重来一次。"); return false; }
    if (this.mode === "play" && this.game.isGameOver()) { this._say(this._ending()); return false; }
    if (this.game.turn() !== "w") { this._say("现在轮到爸爸的黑棋，等他走一步。"); return false; }
    const piece = this.game.get(square);
    if (piece?.color === "w") {
      this.selected = this.selected === square ? null : square; this.focusSquare = square; this.hintMove = null;
      const legal = this.selected ? this.game.moves({ square, verbose: true }) : [];
      if (this.mode === "learn") {
        const lesson = LESSONS[this.lessonIndex];
        this._setGuidance(this.selected === lesson.from ? "path" : "source", { from: lesson.from, to: lesson.to });
      } else this._setGuidance("none");
      this._say(!this.selected ? "先选一颗白棋，我们再一起看。" : legal.length ? `${pieceName(piece)}在 ${square}。${RULES[piece.type]}可以走到亮起的格子。` : "这颗棋子现在没有合法走法，换一颗白棋试试。");
      return false;
    }
    if (!this.selected) { this._say("我们拿白棋，先点一颗白色棋子。亮起的格子会告诉你可以走到哪里。"); return false; }
    const legal = this.game.moves({ square: this.selected, verbose: true }).find(move => move.to === square && (!move.promotion || move.promotion === "q"));
    if (!legal) {
      this._say(this.game.isCheck() ? "白王正在被将军，要先保护白王。试试亮起的合法格子。" : `这一步现在不能走。${RULES[this.game.get(this.selected).type]}再看看亮起的格子。`);
      return false;
    }
    if (this.mode === "learn") {
      const lesson = LESSONS[this.lessonIndex];
      if (legal.from !== lesson.from || legal.to !== lesson.to) {
        this._say(`这步在下棋时可以走。这一课先试着把${NAMES[lesson.piece]}从 ${lesson.from} 走到星星 ${lesson.to}。`); return false;
      }
    }
    const move = this.game.move({ from: legal.from, to: legal.to, promotion: "q" });
    this.selected = null; this.hintMove = null;
    if (this.mode === "learn") { this.lessonComplete = true; this._setGuidance("complete"); this._say(`${this._moveText(move)}你完成了这一步！${this.lessonIndex < 2 ? "准备好就点下一课。" : "兵、车和马都试过了。可以再学一次，或者和爸爸下一盘。"}`); }
    else { this._setGuidance("none"); this._say(this._moveText(move) + (this._ending() || "现在轮到爸爸的黑棋。")); this._scheduleAi(); }
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
      const legal = moves[Math.min(moves.length - 1, Math.max(0, Math.floor(this.random() * moves.length)))];
      const move = this.game.move({ from: legal.from, to: legal.to, promotion: legal.promotion || "q" });
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
      if (this.lessonComplete) { this._say("这一步完成了。准备好就点下一课，或重来一次。"); return; }
      const lesson = LESSONS[this.lessonIndex]; this.selected = lesson.from; this._setGuidance("path", { from: lesson.from, to: lesson.to }); this._say(lesson.text); return;
    }
    if (this.game.isGameOver()) { this._say(this._ending()); return; }
    if (this.game.turn() !== "w") { this._say("现在轮到黑棋，等爸爸走好，再一起想白棋的下一步。"); return; }
    const moves = this.game.moves({ verbose: true }), move = moves.find(item => item.captured) || moves[0];
    if (!move) return; this.selected = move.from; this.hintMove = move; this._setGuidance("path", move);
    this._say(`一个可以试的走法：把白${NAMES[move.piece]}从 ${move.from} 走到星星 ${move.to}。先点棋子，再点目标格。`);
  }
  _render() {
    const lesson = LESSONS[this.lessonIndex], learning = this.mode === "learn";
    const legal = new Set(this.selected ? this.game.moves({ square: this.selected, verbose: true }).map(move => move.to) : []);
    const guide = this.guidanceMove;
    const showSource = this.guidancePhase === "source" || this.guidancePhase === "path";
    const showPath = this.guidancePhase === "path" && guide?.from && guide?.to;
    const targetSquare = showPath ? guide.to : this.hintMove?.to;
    for (const [square, { cell, symbol, target, dark }] of this.cells) {
      const piece = this.game.get(square);
      cell.className = `chess-board__square${dark ? " is-dark" : ""}${this.selected === square ? " is-selected" : ""}${legal.has(square) ? " is-legal" : ""}${showSource && guide?.from === square ? " is-guidance-source" : ""}${showPath && guide?.to === square ? " is-guidance-target" : ""}`;
      symbol.textContent = piece ? SYMBOLS[piece.color][piece.type] : ""; symbol.className = `chess-board__piece ${piece?.color === "w" ? "is-white" : "is-black"}`;
      target.hidden = targetSquare !== square; cell.tabIndex = this.focusSquare === square ? 0 : -1;
      cell.setAttribute("aria-selected", String(this.selected === square));
      cell.setAttribute("aria-label", `${square}，${piece ? pieceName(piece) : "空格"}${legal.has(square) ? "，合法目标" : ""}${showSource && guide?.from === square ? "，先点这里" : ""}${showPath && guide?.to === square ? "，沿箭头到这里" : ""}${targetSquare === square ? "，星星目标" : ""}`);
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
    this.lessonTitle.textContent = learning ? `第 ${this.lessonIndex + 1} / 3 步 · ${lesson.name}` : "你执白棋，爸爸执黑棋";
    this.feedback.textContent = this.lastExplanation;
    this.turnLabel.textContent = learning ? (this.lessonComplete ? "这一步完成了 ✓" : "把棋子送到星星格")
      : this._ending() || (this.game.turn() === "w" ? (this.game.isCheck() ? "白王被将军，先保护王" : "轮到你啦 · 白棋走") : "爸爸想一想 · 黑棋走");
    this.undoButton.hidden = learning; this.undoButton.disabled = this.game.history().length === 0;
    this.resetButton.textContent = learning ? "重来这一步" : "重新开局";
    this.nextButton.hidden = !learning; this.nextButton.disabled = !this.lessonComplete; this.nextButton.textContent = this.lessonIndex === 2 ? "再学一遍" : "下一课 →";
  }
}

globalThis.ChessBoard = ChessBoard;
