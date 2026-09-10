const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const boardModule = import(pathToFileURL(path.join(__dirname, "../frontend/chess-board.js")).href);
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.handlers = new Map();
    this.style = {}; this.dataset = {}; this.attributes = {}; this.hidden = false; this.disabled = false;
    this.tabIndex = 0; this.isConnected = true; this.textContent = "";
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, listener) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(listener); }
  removeEventListener(type, listener) { this.handlers.set(type, (this.handlers.get(type) || []).filter(item => item !== listener)); }
  dispatch(type, values = {}) {
    const event = { preventDefault() {}, stopPropagation() {}, ...values };
    for (const listener of this.handlers.get(type) || []) listener(event);
  }
  focus() { this.doc.activeElement = this; }
  querySelectorAll(tag) { return this.children.flatMap(node => [...(node.tagName === tag.toUpperCase() ? [node] : []), ...node.querySelectorAll(tag)]); }
  remove() { this.isConnected = false; }
}

async function fixture(options = {}) {
  const { ChessBoard } = await boardModule;
  const doc = { hidden: false, fullscreenElement: null }, events = new Element("document", doc);
  doc.addEventListener = events.addEventListener.bind(events); doc.removeEventListener = events.removeEventListener.bind(events);
  doc.body = new Element("body", doc); doc.body.style.overflow = "auto";
  doc.createElement = tag => new Element(tag, doc);
  const initialFocus = doc.activeElement = new Element("button", doc);
  const speech = [], timers = new Map(), cancelled = [];
  let serial = 0, closed = 0;
  const board = new ChessBoard({ document: doc, nativeFullscreen: false,
    onSpeak: text => { speech.push(text); return { ok: true }; }, onClose: () => closed++, random: () => 0,
    later(fn) { const id = ++serial; timers.set(id, fn); return id; },
    cancelLater(id) { cancelled.push(id); timers.delete(id); }, ...options });
  return { board, doc, events, initialFocus, speech, timers, cancelled, closed: () => closed,
    click(square) { board.cells.get(square).cell.dispatch("click"); },
    runAi() { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); } };
}
function point(square) {
  return { x: (square.charCodeAt(0) - 97) * 100 + 50, y: (8 - Number(square[1])) * 100 + 50 };
}

test("completion dialog keeps click and voice advancement idempotent and final restart explicit", async () => {
  const f = await fixture(); f.board.open();
  try {
    f.click("e2"); f.click("e3");
    assert.equal(f.board.celebration.hidden, false);
    assert.equal(f.doc.activeElement, f.board.continueButton);
    const count = f.speech.length;
    f.click("e3"); assert.equal(f.speech.length, count);
    f.board.continueButton.dispatch("click"); f.board.continueButton.dispatch("click");
    f.board.handleVoiceCommand("下一课");
    assert.equal(f.board.lessonIndex, 1); assert.equal(f.board.celebration.hidden, true);
    f.click("d4"); f.click("d7"); f.board.handleVoiceCommand("下一课");
    f.click("d4"); f.click("f5");
    assert.match(f.board.continueButton.textContent, /再学一遍/);
    assert.match(f.board.successText.textContent, /三课都完成/);
    f.board.close(); f.board.open();
    assert.equal(f.board.celebration.hidden, false);
    assert.equal(f.board.confetti, null);
    f.board.continueButton.dispatch("click"); f.board.continueButton.dispatch("click");
    assert.equal(f.board.lessonIndex, 0); assert.equal(f.board.lessonComplete, false);
  } finally { f.board.destroy(); }
});
function assertVisiblePath(board, move) {
  const from = point(move.from), to = point(move.to);
  assert.equal(board.guidancePhase, "path");
  assert.match(board.cells.get(move.from).cell.className, /is-guidance-source/);
  assert.match(board.cells.get(move.to).cell.className, /is-guidance-target/);
  assert.equal(board.guideLine.hidden, false);
  assert.equal(board.guideLine.getAttribute("x1"), String(from.x)); assert.equal(board.guideLine.getAttribute("y1"), String(from.y));
  assert.equal(board.guideLine.getAttribute("x2"), String(to.x)); assert.equal(board.guideLine.getAttribute("y2"), String(to.y));
}
test("three lessons require the stated legal target and explain wrong moves without changing the board", async () => {
  const f = await fixture(); f.board.open();
  try {
    assert.match(f.speech.at(-1), /e2.*e3/);
    const initial = f.board.game.fen();
    f.click("e2"); assert.match(f.board.cells.get("e3").cell.className, /is-legal/);
    f.click("e5"); assert.equal(f.board.game.fen(), initial); assert.match(f.speech.at(-1), /不能走/);
    f.click("e4"); assert.equal(f.board.game.fen(), initial); assert.match(f.speech.at(-1), /可以走.*这一课.*e3/);
    f.click("e3"); assert.equal(f.board.lessonComplete, true); assert.equal(f.board.game.get("e3").type, "p");
    assert.equal(f.timers.size, 0, "lessons never start an opponent move");
    f.board.nextLesson(); f.click("d4"); f.click("d7"); assert.equal(f.board.lessonComplete, true);
    f.board.nextLesson(); f.click("d4"); f.click("f5"); assert.equal(f.board.lessonComplete, true);
    assert.equal(f.board.game.get("f5").type, "n");
    f.board.reset(); assert.equal(f.board.lessonComplete, false); assert.equal(f.board.game.get("d4").type, "n");
  } finally { f.board.destroy(); }
});

test("the first lesson uses visible source, path and target guidance without relying on its star", async () => {
  const f = await fixture(); f.board.open();
  try {
    assert.equal(f.board.guidancePhase, "source");
    assert.match(f.board.cells.get("e2").cell.className, /is-guidance-source/);
    assert.doesNotMatch(f.board.cells.get("e3").cell.className, /is-guidance-target/);
    assert.equal(f.board.guideLine.hidden, true);
    f.click("e2");
    assertVisiblePath(f.board, { from: "e2", to: "e3" });
    f.click("e3");
    assert.equal(f.board.guidancePhase, "complete");
    assert.doesNotMatch(f.board.cells.get("e2").cell.className, /is-guidance-source/);
    assert.doesNotMatch(f.board.cells.get("e3").cell.className, /is-guidance-target/);
    assert.equal(f.board.guideLine.hidden, true);
  } finally { f.board.destroy(); }
});

test("each completed lesson speaks concrete praise, marks its destination and waits for the child to continue", async () => {
  const f = await fixture(); f.board.open();
  try {
    const lessons = [
      ["e2", "e3", /白兵向前走了一格.*e2.*e3/, /白兵向前一步/],
      ["d4", "d7", /白车沿着直线走了三格.*d4.*d7/, /白车沿直线/],
      ["d4", "f5", /白马向右两格、再向上一格.*d4.*f5/, /白马拐个弯/],
    ];
    for (let index = 0; index < lessons.length; index++) {
      const [from, to, praise, visible] = lessons[index];
      f.click(from); f.click(to);
      const speech = f.speech.at(-1);
      assert.match(speech, praise, "the real onSpeak callback receives action-specific success text");
      assert.match(speech, index < 2 ? /说‘下一课’/ : /再学一遍.*和爸爸下棋/);
      assert.ok(speech.length <= 200, "host TTS accepts the complete explanation");
      assert.match(f.board.cells.get(to).cell.className, /is-complete/);
      assert.equal(f.board.cells.get(to).target.textContent, "✓");
      assert.equal(f.board.cells.get(to).target.hidden, false);
      assert.match(f.board.cells.get(to).cell.getAttribute("aria-label"), /这一步完成了/);
      assert.match(f.board.boardHint.textContent, visible);
      assert.match(f.board.boardHint.className, /is-success/);
      const count = f.speech.length, position = f.board.game.fen();
      f.click(to); f.click(from); f.click(to);
      await settle();
      assert.equal(f.speech.length, count, "extra taps cannot interrupt success narration");
      assert.equal(f.board.game.fen(), position);
      assert.equal(f.board.lessonIndex, index, "completion never forces the next lesson");
      assert.equal(f.timers.size, 0);
      if (index < 2) {
        assert.equal(f.board.handleVoiceCommand("爸爸老师，下一课"), true);
        assert.doesNotMatch(f.board.boardHint.className, /is-success/);
        assert.equal([...f.board.cells.values()].some(({ cell }) => /is-complete/.test(cell.className)), false);
      }
    }
    assert.equal(f.board.handleVoiceCommand("再学一遍"), true);
    assert.equal(f.board.lessonIndex, 0); assert.equal(f.board.lessonComplete, false);
  } finally { f.board.destroy(); }
});

test("chess voice controls reject unrelated speech and never skip an unfinished lesson", async () => {
  const { ChessBoard } = await boardModule;
  for (const [text, expected] of [["爸爸老师，下一课吧", "next"], ["下一課", "next"], ["给我提示一下", "hint"], ["再听一遍", "repeat"], ["重来这一步", "reset"], ["再学一遍", "learn"], ["和爸爸下棋", "play"], ["悔棋", "undo"], ["退出棋盘", "close"]]) {
    assert.equal(ChessBoard.parseVoiceCommand(text), expected, text);
  }
  for (const text of ["不要下一课", "我不想悔棋", "爸爸刚才说下一课", "小兔子重新开始跑了", "我想听一个故事", "下一课讲什么", "把图片关闭", "a".repeat(81), null]) {
    assert.equal(ChessBoard.parseVoiceCommand(text), null, String(text));
  }
  const f = await fixture();
  try {
    assert.equal(f.board.handleVoiceCommand("下一课"), false);
    f.board.open(); const initial = f.board.game.fen();
    assert.equal(f.board.handleVoiceCommand("下一课"), true);
    assert.equal(f.board.lessonIndex, 0); assert.equal(f.board.game.fen(), initial);
    assert.match(f.speech.at(-1), /先完成这一步/);
    f.board.handleVoiceCommand("提示一下"); assert.equal(f.board.guidancePhase, "path");
    const hint = f.speech.at(-1); f.board.handleVoiceCommand("再听一遍"); assert.equal(f.speech.at(-1), hint);
    f.board.handleVoiceCommand("和爸爸下棋"); assert.equal(f.board.mode, "play");
    f.click("e2"); f.click("e4");
    f.board.handleVoiceCommand("悔棋"); assert.equal(f.board.game.history().length, 0);
    f.board.handleVoiceCommand("退出棋盘"); assert.equal(f.board.isOpen, false);
    assert.equal(f.board.handleVoiceCommand("再学一遍"), false);
  } finally { f.board.destroy(); }
});

test("late success narration cannot overwrite a voice-requested next lesson or resume after closing", async () => {
  const pending = [];
  const f = await fixture({ onSpeak: text => new Promise(resolve => pending.push({ text, resolve })) }); f.board.open();
  try {
    f.click("e2"); f.click("e3");
    const success = pending.at(-1);
    assert.match(success.text, /对啦.*白兵/);
    f.click("e3"); assert.equal(pending.at(-1), success);
    f.board.handleVoiceCommand("下一课");
    const next = pending.at(-1), current = f.board.speechStatus.textContent;
    assert.match(next.text, /认识白车/);
    success.resolve({ ok: false, error: "stale synthetic result" }); await settle();
    assert.equal(f.board.speechStatus.textContent, current);
    assert.equal(f.board.speaking, true); assert.equal(f.board.lessonIndex, 1);
    f.board.handleVoiceCommand("下一课"); assert.equal(f.board.lessonIndex, 1, "duplicate commands cannot skip an incomplete lesson");
    f.board.close();
    for (const request of pending) request.resolve({ ok: true });
    await settle(); assert.equal(f.timers.size, 0); assert.equal(f.board.speaking, false);
  } finally { f.board.destroy(); }
});

test("the second and third lessons compute their own source, target and arrow coordinates", async () => {
  const f = await fixture(); f.board.open();
  try {
    f.board.lessonIndex = 1; f.board.reset();
    assert.equal(f.board.guidancePhase, "source"); assert.match(f.board.cells.get("d4").cell.className, /is-guidance-source/);
    f.click("d4"); assertVisiblePath(f.board, { from: "d4", to: "d7" });
    f.board.lessonIndex = 2; f.board.reset();
    assert.equal(f.board.guidancePhase, "source"); assert.match(f.board.cells.get("d4").cell.className, /is-guidance-source/);
    f.click("d4"); assertVisiblePath(f.board, { from: "d4", to: "f5" });
  } finally { f.board.destroy(); }
});

test("hint and repeat preserve their lesson visual guidance while narration is still playing", async () => {
  const pending = [];
  const f = await fixture({ onSpeak: () => new Promise(resolve => pending.push(resolve)) }); f.board.open();
  try {
    assert.equal(f.board.guidancePhase, "source");
    f.board.repeatButton.dispatch("click");
    assert.equal(f.board.guidancePhase, "source");
    assert.match(f.board.cells.get("e2").cell.className, /is-guidance-source/);
    f.board.hint();
    assert.equal(f.board.guidancePhase, "path");
    assert.match(f.board.cells.get("e3").cell.className, /is-guidance-target/);
    assert.equal(f.board.guideLine.hidden, false);
    pending.at(-1)({ ok: true }); await settle();
    assert.equal(f.board.guidancePhase, "path", "the current spoken hint keeps its source and target visible");
  } finally { f.board.destroy(); }
});

test("chess guidance is static when reduced motion is requested", () => {
  const css = fs.readFileSync(path.join(__dirname, "../frontend/chess-board.css"), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation: none !important/);
  assert.match(css, /transition: none !important/);
});

test("a standard game rejects blocked moves and the opponent makes exactly one legal move", async () => {
  const f = await fixture(); f.board.open(); f.board.startMode("play");
  try {
    const initial = f.board.game.fen(); assert.equal(f.board.game.moves().length, 20);
    f.click("a1"); f.click("a3"); assert.equal(f.board.game.fen(), initial, "a rook cannot jump its pawn");
    f.click("e2"); f.click("e4"); await settle(); assert.equal(f.board.game.turn(), "b"); assert.equal(f.timers.size, 1);
    const blackLegal = f.board.game.moves({ verbose: true }).map(move => move.lan);
    f.click("d2"); await settle(); assert.equal(f.board.game.history().length, 1, "a child cannot move again on black's turn");
    f.runAi(); assert.equal(f.board.game.history().length, 2); assert.equal(f.board.game.turn(), "w");
    assert.ok(blackLegal.includes(f.board.game.history({ verbose: true }).at(-1).lan));
    f.board.undo(); assert.equal(f.board.game.fen(), initial, "undo retracts both sides of the round");
    f.click("e2"); f.click("e4"); f.board.undo(); assert.equal(f.board.game.fen(), initial); assert.equal(f.timers.size, 0);
    f.board.reset(); assert.equal(f.board.game.fen(), initial);
  } finally { f.board.destroy(); }
});

test("a play hint gives its recommended source and target a path, then clears it on every new board state", async () => {
  const f = await fixture(); f.board.open(); f.board.startMode("play");
  try {
    assert.equal(f.board.guidancePhase, "none");
    f.board.hint(); const firstHint = f.board.hintMove;
    assertVisiblePath(f.board, firstHint);
    f.click("b2");
    assert.equal(f.board.guidancePhase, "none"); assert.equal(f.board.hintMove, null); assert.equal(f.board.guideLine.hidden, true);
    f.board.hint(); const recommended = f.board.hintMove;
    assertVisiblePath(f.board, recommended);
    f.click(recommended.to);
    assert.equal(f.board.guidancePhase, "none"); assert.equal(f.board.hintMove, null); assert.equal(f.board.guideLine.hidden, true);
    await settle(); f.runAi();
    assert.equal(f.board.guidancePhase, "none", "the opponent turn cannot retain the child's old recommendation");
    f.board.undo(); assert.equal(f.board.guidancePhase, "none");
    f.board.reset(); assert.equal(f.board.guidancePhase, "none");
    f.board.startMode("learn"); assert.equal(f.board.guidancePhase, "source");
    f.board.startMode("play"); assert.equal(f.board.guidancePhase, "none");
  } finally { f.board.destroy(); }
});

test("being in check rejects an unrelated pawn move and hints select only a legal escape", async () => {
  const f = await fixture(); f.board.open(); f.board.startMode("play");
  try {
    f.board.game.load("4r2k/8/8/8/8/8/P7/4K3 w - - 0 1"); f.board._render();
    assert.equal(f.board.game.isCheck(), true);
    const before = f.board.game.fen(); f.click("a2"); f.click("a3");
    assert.equal(f.board.game.fen(), before); assert.match(f.speech.at(-1), /将军.*保护/);
    f.board.hint(); const hint = f.board.hintMove;
    assert.ok(f.board.game.moves({ verbose: true }).some(move => move.from === hint.from && move.to === hint.to));
    f.click(hint.to); assert.equal(f.board.game.turn(), "b"); assert.equal(f.board.game.get("e1"), undefined);
  } finally { f.board.destroy(); }
});

test("castling, en passant and promotion use the vendored legal rules with truthful explanations", async () => {
  const f = await fixture(); f.board.open(); f.board.startMode("play");
  try {
    f.board.game.load("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    f.click("e1"); f.click("g1"); assert.equal(f.board.game.get("f1").type, "r"); assert.match(f.speech.at(-1), /王车易位/);
    f.board.reset(); f.board.game.load("7k/8/8/3pP3/8/8/8/K7 w - d6 0 2");
    f.click("e5"); f.click("d6"); assert.equal(f.board.game.get("d5"), undefined); assert.match(f.speech.at(-1), /过路兵/);
    f.board.reset(); f.board.game.load("7k/P7/8/8/8/8/8/K7 w - - 0 1");
    f.click("a7"); f.click("a8"); assert.equal(f.board.game.get("a8").type, "q"); assert.match(f.speech.at(-1), /自动升成后/);
  } finally { f.board.destroy(); }
});

test("the opponent also promotes to a queen and checkmate or stalemate stops further moves", async () => {
  const f = await fixture({ random: () => 0.999 }); f.board.open(); f.board.startMode("play");
  try {
    f.board.game.load("7k/8/8/8/8/8/p7/7K b - - 0 1"); await settle(); f.board._scheduleAi(); f.runAi();
    // If the simple opponent chooses promotion, it must agree with its explanation.
    const last = f.board.game.history({ verbose: true }).at(-1);
    assert.equal(last.promotion, "q"); assert.equal(f.board.game.get("a1").type, "q");
    f.board.reset(); f.board.game.load("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1"); f.board._render();
    assert.equal(f.board.game.isCheckmate(), true); assert.match(f.board.turnLabel.textContent, /将死.*白棋赢/);
    const mate = f.board.game.fen(); f.board._scheduleAi(); f.click("g7"); assert.equal(f.timers.size, 0); assert.equal(f.board.game.fen(), mate);
    f.board.game.load("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"); f.board._render();
    assert.equal(f.board.game.isStalemate(), true); assert.match(f.board.turnLabel.textContent, /逼和.*平局/);
  } finally { f.board.destroy(); }
});

test("close, restart and undo invalidate already-queued opponent callbacks, and reopening resumes only the current turn", async () => {
  for (const stop of ["close", "reset", "undo", "learn", "hidden"]) {
    const f = await fixture(); f.board.open(); f.board.startMode("play");
    try {
      f.click("e2"); f.click("e4"); await settle(); const stale = f.timers.values().next().value;
      if (stop === "learn") f.board.startMode("learn");
      else if (stop === "hidden") { f.doc.hidden = true; f.events.dispatch("visibilitychange"); }
      else f.board[stop]();
      const before = f.board.game.fen(), speechCount = f.speech.length;
      stale(); assert.equal(f.board.game.fen(), before); assert.equal(f.speech.length, speechCount); assert.equal(f.timers.size, 0);
      if (stop === "close") { f.board.open(); await settle(); assert.equal(f.timers.size, 1); stale(); assert.equal(f.board.game.fen(), before); f.runAi(); assert.equal(f.board.game.turn(), "w"); }
    } finally { f.board.destroy(); }
  }
});

test("Escape restores focus and scroll, keyboard arrows select focus, and old speech results cannot overwrite a new explanation", async () => {
  const pending = [];
  const f = await fixture({ onSpeak: () => new Promise(resolve => pending.push(resolve)) });
  f.board.open(); const firstSpeech = pending[0];
  try {
    f.board.cells.get("e2").cell.dispatch("keydown", { key: "ArrowRight" });
    assert.equal(f.doc.activeElement, f.board.cells.get("f2").cell);
    f.board.hint(); f.board.setSpeechError("当前声音暂不可用"); const facts = f.board.feedback.textContent;
    firstSpeech({ ok: false, error: "上一段错误" }); await Promise.resolve();
    assert.equal(f.board.speechStatus.textContent, "当前声音暂不可用"); assert.equal(f.board.feedback.textContent, facts);
    f.events.dispatch("keydown", { key: "Escape" });
    assert.equal(f.board.isOpen, false); assert.equal(f.closed(), 1); assert.equal(f.doc.activeElement, f.initialFocus);
    assert.equal(f.doc.body.style.overflow, "auto"); assert.equal(f.board.element.hidden, true);
    pending.at(-1)({ ok: false, error: "关闭后错误" }); await Promise.resolve();
    assert.notEqual(f.board.speechStatus.textContent, "关闭后错误");
  } finally { f.board.destroy(); }
});

test("native fullscreen rejection still leaves a usable board without granting any media or storage capability", async () => {
  const f = await fixture({ nativeFullscreen: true });
  f.board.element.requestFullscreen = () => Promise.reject(new Error("not permitted"));
  f.board.open(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.board.isOpen, true); assert.equal(f.board.element.hidden, false);
  f.board.destroy(); assert.equal(f.board.element.isConnected, false);
});

test("closing cancels host narration before restoring focus to its temporarily disabled entry button", async () => {
  let f;
  f = await fixture({ onClose: () => { f.initialFocus.disabled = false; } });
  f.initialFocus.focus = function () { if (!this.disabled) f.doc.activeElement = this; };
  f.board.open(); f.initialFocus.disabled = true;
  f.board.close(); assert.equal(f.doc.activeElement, f.initialFocus);
  f.board.destroy();
});

test("the opponent waits for the current explanation, continues after voice failure and ignores speech settled after close", async () => {
  const pending = [];
  const f = await fixture({ onSpeak: () => new Promise(resolve => pending.push(resolve)) });
  f.board.open(); f.board.startMode("play"); f.click("e2"); f.click("e4");
  try {
    assert.equal(f.timers.size, 0); const explanation = pending.at(-1);
    f.board.hint(); const replacement = pending.at(-1);
    explanation({ ok: true }); await settle(); assert.equal(f.timers.size, 0, "a superseded explanation cannot start the opponent");
    replacement({ ok: false, error: "synthetic voice failure" }); await settle(); assert.equal(f.timers.size, 1);
    f.runAi(); assert.equal(f.board.game.turn(), "w");
    const late = pending.at(-1), before = f.board.game.fen(); f.board.close();
    late({ ok: true }); await settle(); assert.equal(f.timers.size, 0); assert.equal(f.board.game.fen(), before);
  } finally { f.board.destroy(); }
});

test("conversation context is a read-only lesson snapshot and disappears when the board closes", async () => {
  const f = await fixture();
  try {
    assert.equal(f.board.getConversationContext(), "");
    f.board.open(); f.click("e2");
    const before = { fen: f.board.game.fen(), history: f.board.game.history(), selected: f.board.selected,
      speech: f.speech.length, timers: f.timers.size, explanation: f.board.lastExplanation };
    const context = f.board.getConversationContext();
    assert.match(context, /玩法：跟爸爸学/); assert.match(context, /课堂目标：白兵 e2→e3/);
    assert.match(context, /当前选中：白兵 e2/); assert.match(context, /当前棋子位置：.*白兵 e2/);
    assert.match(context, /轮到：孩子的白棋/); assert.match(context, /刚才的讲解：/);
    assert.deepEqual({ fen: f.board.game.fen(), history: f.board.game.history(), selected: f.board.selected,
      speech: f.speech.length, timers: f.timers.size, explanation: f.board.lastExplanation }, before);
    f.click("e3"); assert.match(f.board.getConversationContext(), /课堂目标：已完成/);
    f.board.close(); assert.equal(f.board.getConversationContext(), "");
  } finally { f.board.destroy(); }
});

test("conversation context lists only current legal moves, honors selection and explains bounded truncation", async () => {
  const f = await fixture(); f.board.open(); f.board.startMode("play");
  const listed = text => [...text.split("合法走法：")[1].split("\n")[0].matchAll(/([a-h][1-8])→([a-h][1-8])/g)].map(match => match[1] + match[2]);
  try {
    f.board.game.load("4r2k/8/8/8/8/8/P7/4K3 w - - 0 1"); f.board.selected = "a2";
    assert.match(f.board.getConversationContext(), /白王正在被将军/);
    assert.deepEqual(listed(f.board.getConversationContext()), [], "a pinned/non-escaping pawn gets no invented move");
    f.board.selected = "e1";
    assert.deepEqual(listed(f.board.getConversationContext()), f.board.game.moves({ square: "e1", verbose: true }).map(move => move.from + move.to));
    f.board.game.load("7k/8/8/8/3Q4/8/8/K7 w - - 0 1"); f.board.selected = null;
    const all = f.board.game.moves({ verbose: true }).map(move => move.from + move.to), context = f.board.getConversationContext();
    assert.ok(all.length > 24); assert.equal(listed(context).length, 24); assert.match(context, /仅列出前24条/);
    assert.ok(listed(context).every(move => all.includes(move)));
    f.board.selected = "a1";
    assert.ok(listed(f.board.getConversationContext()).every(move => move.startsWith("a1")));
  } finally { f.board.destroy(); }
});

test("conversation context reflects black turn, automatic promotion, terminal state and a bounded explanation", async () => {
  const f = await fixture(); f.board.open(); f.board.startMode("play");
  try {
    f.board.game.move("e4"); assert.match(f.board.getConversationContext(), /轮到：爸爸的黑棋/);
    f.board.game.load("7k/P7/8/8/8/8/8/K7 w - - 0 1"); f.board.selected = "a7";
    const promotion = f.board.getConversationContext();
    assert.match(promotion, /a7→a8（自动升后）/); assert.doesNotMatch(promotion, /升车|升马|升象/);
    f.board.game.load("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1"); f.board.selected = null;
    f.board.lastExplanation = "合成的长讲解".repeat(1000);
    const ending = f.board.getConversationContext();
    assert.match(ending, /黑王被将死了.*白棋赢/); assert.match(ending, /合法走法：无/);
    assert.ok(ending.length <= 3000); assert.doesNotMatch(ending, /建议尝试：[a-h]/);
  } finally { f.board.destroy(); }
});
