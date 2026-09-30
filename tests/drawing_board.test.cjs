const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createDrawingBoard, DrawingObservationQueue } = require("../frontend/drawing-board.js");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("default browser timers retain the Window receiver when called through the queue", () => {
  const context = vm.createContext({ module: { exports: {} }, AbortController });
  vm.runInContext(`
    globalThis.timerCalls = [];
    globalThis.setTimeout = function (callback, delay) {
      "use strict";
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      timerCalls.push(["set", delay]); return 23;
    };
    globalThis.clearTimeout = function (handle) {
      "use strict";
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      timerCalls.push(["clear", handle]);
    };
  `, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/drawing-board.js"), "utf8"), context);
  vm.runInContext(`
    const queue = new module.exports.DrawingObservationQueue({ now: () => 0, snapshot: async () => null, observe: async () => {} });
    queue.setActive(true); queue.changed(1, true); queue.changed(2, true); queue.setActive(false);
  `, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.timerCalls)), [["set", 1200], ["clear", 23], ["set", 1200], ["clear", 23]]);
});

function observationFixture(observe, snapshot = async () => new Blob(["synthetic-drawing"], { type: "image/png" })) {
  let now = 0, serial = 0;
  const timers = new Map(), results = [], states = [];
  const queue = new DrawingObservationQueue({ snapshot, observe, now: () => now,
    later(fn, delay) { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    cancelLater(id) { timers.delete(id); }, onResult: value => results.push(value), onState: value => states.push(value) });
  return { queue, results, states, timers, now: () => now,
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, task]) => task.at <= end);
        if (!next) break;
        const [id, task] = next; timers.delete(id); now = task.at; task.fn(); await tick();
      }
      now = end; await tick();
    },
  };
}

test("a brief pause observes nonblank drawing; start times stay five seconds apart", async () => {
  const calls = [];
  const f = observationFixture(async (_, revision) => { calls.push({ revision, at: f.now() }); return "看到了"; });
  f.queue.setActive(true);
  await f.advance(2000); assert.equal(calls.length, 0);
  f.queue.changed(1, true); await f.advance(900); f.queue.changed(2, true);
  await f.advance(1199); assert.equal(calls.length, 0);
  await f.advance(1); assert.deepEqual(calls, [{ revision: 2, at: 4100 }]);
  f.queue.changed(3, true); await f.advance(4999); assert.equal(calls.length, 1);
  await f.advance(1); assert.deepEqual(calls[1], { revision: 3, at: 9100 });
  f.queue.changed(4, false); await f.advance(10000); assert.equal(calls.length, 2);
});

test("continuous drawing observes progress every five seconds instead of waiting forever for a pause", async () => {
  const calls = [];
  const f = observationFixture(async (_, revision) => { calls.push({ revision, at: f.now() }); return "看到了"; });
  f.queue.setActive(true);
  for (let revision = 1; revision <= 24; revision++) {
    f.queue.changed(revision, true); await f.advance(500);
  }
  assert.deepEqual(calls, [{ revision: 10, at: 5000 }, { revision: 20, at: 10000 }]);
  assert.equal(f.queue.busy, false);
  f.queue.setActive(false);
});

test("new strokes during PNG encoding keep the same session snapshot usable without displaying stale feedback", async () => {
  let finish; const calls = [];
  const f = observationFixture(async (_, revision, meta) => {
    calls.push({ revision, current: meta.isCurrent(), active: meta.isActive() }); return "older frame";
  }, () => new Promise(resolve => { finish = resolve; }));
  f.queue.setActive(true); f.queue.changed(1, true); await f.advance(1200);
  f.queue.changed(2, true);
  finish(new Blob(["synthetic-revision-1"])); await tick();
  assert.deepEqual(calls, [{ revision: 1, current: false, active: true }]);
  assert.deepEqual(f.results, []);
  f.queue.setActive(false);
});

test("pausing a continuously changing drawing discards its old maximum wait deadline", async () => {
  const calls = [];
  const f = observationFixture(async (_, revision) => { calls.push({ revision, at: f.now() }); });
  f.queue.setActive(true);
  for (let revision = 1; revision <= 8; revision++) { f.queue.changed(revision, true); await f.advance(500); }
  f.queue.setEnabled(false); await f.advance(10000);
  assert.deepEqual(calls, []);
  f.queue.setEnabled(true);
  for (let revision = 9; revision <= 18; revision++) { f.queue.changed(revision, true); await f.advance(500); }
  assert.deepEqual(calls, [{ revision: 18, at: 19000 }]);
  f.queue.setActive(false);
});

test("busy work combines edits into the newest revision, without concurrency or interrupting current speech", async () => {
  const calls = []; let finish;
  const f = observationFixture((_, revision, meta) => {
    calls.push({ revision, meta });
    return calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve("new");
  });
  f.queue.setActive(true); f.queue.changed(1, true); await f.advance(1200);
  f.queue.changed(2, true); f.queue.changed(3, true); await f.advance(10000);
  assert.equal(calls.length, 1); assert.equal(calls[0].meta.signal.aborted, false);
  assert.equal(calls[0].meta.isCurrent(), false);
  finish("stale"); await tick(); await f.advance(0);
  assert.deepEqual(calls.map(call => call.revision), [1, 3]);
  assert.deepEqual(f.results, ["new"]);
});

for (const stop of ["close", "hide", "pause"]) {
  test(`${stop} aborts pending observation and discards a late result after reopening`, async () => {
    let finish, meta;
    const f = observationFixture((_, revision, context) => { meta = context; return new Promise(resolve => { finish = resolve; }); });
    f.queue.setActive(true); f.queue.changed(1, true); await f.advance(1200);
    if (stop === "close") { f.queue.setActive(false); f.queue.setActive(true); }
    if (stop === "hide") { f.queue.setVisible(false); f.queue.setVisible(true); }
    if (stop === "pause") { f.queue.setEnabled(false); f.queue.setEnabled(true); }
    assert.equal(meta.signal.aborted, true); assert.equal(meta.isCurrent(), false);
    finish("late"); await tick(); assert.deepEqual(f.results, []);
    f.queue.setActive(false);
  });
}

test("deferred voice retries after one second and preserves the last real request interval", async () => {
  const calls = []; let defer = true;
  const f = observationFixture(async (_, revision) => {
    calls.push({ at: f.now(), revision }); return defer ? { deferred: true } : "ready";
  });
  f.queue.setActive(true); f.queue.changed(1, true); await f.advance(1200);
  await f.advance(999); assert.equal(calls.length, 1);
  defer = false; await f.advance(1); assert.deepEqual(calls.map(x => x.at), [1200, 2200]);
  f.queue.changed(2, true); await f.advance(4999); assert.equal(calls.length, 2);
  await f.advance(1); assert.deepEqual(calls[2], { at: 7200, revision: 2 });
});

test("an erased blank snapshot or a snapshot invalidated while encoding never reaches Vision", async () => {
  let calls = 0, finish;
  const blank = observationFixture(async () => { calls++; }, async () => null);
  blank.queue.setActive(true); blank.queue.changed(1, true); await blank.advance(2000);
  assert.equal(calls, 0);
  const pending = observationFixture(async () => { calls++; }, () => new Promise(resolve => { finish = resolve; }));
  pending.queue.setActive(true); pending.queue.changed(1, true); await pending.advance(1200);
  pending.queue.setActive(false); finish(new Blob(["not-to-send"])); await tick();
  assert.equal(calls, 0);
});

// Minimal DOM/canvas doubles exercise input and lifecycle without browser,
// microphone, storage, service, or image/model execution.
class FakeElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.handlers = new Map();
    this.attributes = {}; this.style = { setProperty(name, value) { this[name] = value; } };
    this.hidden = false; this.disabled = false; this.isConnected = true; this.textContent = "";
    this.width = 300; this.height = 150; this.capture = null;
    this.ink = false;
    this.context = { fillStyle: "#fff", strokeStyle: "#fff", beginPath() {}, arc() {}, moveTo() {}, lineTo() {},
      fill: () => { this.ink = this.context.fillStyle !== "#fff"; },
      stroke: () => { this.ink = this.context.strokeStyle !== "#fff"; },
      fillRect: () => { this.ink = this.context.fillStyle !== "#fff"; },
      drawImage: source => { this.ink = source.ink; },
      getImageData: () => ({ data: Uint8Array.from(this.ink ? [30, 80, 60, 255] : [255, 255, 255, 255]) }) };
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(fn); }
  removeEventListener(type, fn) { this.handlers.set(type, (this.handlers.get(type) || []).filter(value => value !== fn)); }
  dispatch(type, overrides = {}) {
    const event = { pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true,
      clientX: 50, clientY: 50, preventDefault() {}, stopPropagation() {}, ...overrides };
    for (const fn of this.handlers.get(type) || []) fn(event);
  }
  focus() { this.doc.activeElement = this; }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0, width: parseFloat(this.style.width) || this.doc.bounds.width,
    height: parseFloat(this.style.height) || this.doc.bounds.height }; }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  toBlob(callback, type) { callback(new Blob(["synthetic-canvas"], { type })); }
  querySelectorAll(tag) { return this.children.flatMap(node => [ ...(node.tagName === tag.toUpperCase() ? [node] : []), ...node.querySelectorAll(tag) ]); }
  remove() { this.isConnected = false; }
}
function boardFixture(options = {}) {
  const doc = { bounds: { width: 1000, height: 600 }, viewportWidth: 1000, hidden: false, fullscreenElement: null };
  const events = new FakeElement("document", doc), windowEvents = new FakeElement("window", doc);
  doc.addEventListener = events.addEventListener.bind(events); doc.removeEventListener = events.removeEventListener.bind(events);
  doc.defaultView = { addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    matchMedia: () => ({ matches: doc.viewportWidth <= 480 }) };
  doc.body = new FakeElement("body", doc); doc.body.style.overflow = "auto";
  doc.activeElement = new FakeElement("button", doc); const initialFocus = doc.activeElement;
  const made = []; doc.createElement = tag => { const el = new FakeElement(tag, doc); made.push(el); return el; };
  const board = createDrawingBoard({ document: doc, nativeFullscreen: false, ...options });
  const byText = text => made.find(node => node.textContent === text);
  const canvas = made.find(node => node.tagName === "CANVAS");
  return { board, doc, canvas, made, byText, events, windowEvents, initialFocus };
}

test("drag drawing, mouse hover mode, touch input, undo and clear stay in memory; resize keeps the canvas", async () => {
  const f = boardFixture(); f.board.open();
  try {
    assert.equal(await f.board.getSnapshot(), null);
    f.canvas.dispatch("pointermove"); assert.equal(f.board.revision, 0);
    f.canvas.dispatch("pointerdown");
    const firstPoint = f.board.revision;
    f.canvas.dispatch("pointermove", { clientX: 90, getCoalescedEvents: () => [] });
    assert.ok(f.board.revision > firstPoint, "empty coalesced events still draw the pointer event");
    f.canvas.dispatch("pointerup");
    assert.equal((await f.board.getSnapshot()).type, "image/png");
    const revision = f.board.revision, width = f.canvas.width, height = f.canvas.height;
    f.doc.bounds = { width: 450, height: 800 }; f.windowEvents.dispatch("resize");
    assert.equal(f.board.revision, revision); assert.equal(f.canvas.width, width); assert.equal(f.canvas.height, height);
    f.byText("↶ 撤销").dispatch("click"); assert.equal(await f.board.getSnapshot(), null);
    f.byText("移动就画：关").dispatch("click"); f.canvas.dispatch("pointermove", { clientX: 80 });
    assert.ok(await f.board.getSnapshot());
    f.byText("清空").dispatch("click"); assert.equal(await f.board.getSnapshot(), null);
    f.byText("↶ 撤销").dispatch("click"); assert.ok(await f.board.getSnapshot());
    f.byText("清空").dispatch("click");
    const beforeTouch = f.board.revision;
    f.canvas.dispatch("pointermove", { pointerType: "touch" }); assert.equal(f.board.revision, beforeTouch);
    f.canvas.dispatch("pointerdown", { pointerType: "touch" }); f.canvas.dispatch("pointerup", { pointerType: "touch" });
    assert.ok(await f.board.getSnapshot());
    const snapshot = f.made.filter(node => node.tagName === "CANVAS").at(-1);
    assert.ok(Math.max(snapshot.width, snapshot.height) <= 1024);
  } finally { f.board.destroy(); }
});

test("Escape restores focus and scrolling; feedback is rejected after close, pause, hide or session change", () => {
  let closed = 0;
  const f = boardFixture({ onClose: () => closed++ }); f.board.open();
  const firstSession = f.board.sessionId;
  f.canvas.dispatch("pointerdown"); f.canvas.dispatch("pointerup");
  assert.equal(f.board.setFeedback("现在的画", f.board.revision, firstSession), true);
  f.byText("暂停观察").dispatch("click"); assert.equal(f.board.setFeedback("迟到", f.board.revision, firstSession), false);
  f.byText("继续观察").dispatch("click");
  f.doc.hidden = true; f.events.dispatch("visibilitychange"); assert.equal(f.board.setFeedback("隐藏时迟到"), false);
  f.doc.hidden = false; f.events.dispatch("visibilitychange");
  f.events.dispatch("keydown", { key: "Escape" });
  assert.equal(f.board.isOpen, false); assert.equal(closed, 1); assert.equal(f.doc.body.style.overflow, "auto");
  assert.equal(f.doc.activeElement, f.initialFocus); assert.equal(f.board.setFeedback("关闭后迟到"), false);
  f.board.open(); assert.equal(f.board.setFeedback("上一轮迟到", f.board.revision, firstSession), false);
  f.board.destroy();
});

test("closing during PNG encoding cannot return a manual voice snapshot from the old board session", async () => {
  const f=boardFixture();f.board.open();
  try {
    f.canvas.dispatch('pointerdown');f.canvas.dispatch('pointerup');
    const create=f.doc.createElement;let finish;
    f.doc.createElement=tag=>{const node=create(tag);if(tag==='canvas')node.toBlob=callback=>{finish=callback;};return node;};
    const snapshot=f.board.getSnapshot();
    f.board.close();f.board.open();
    finish(new Blob(['old-session-drawing'],{type:'image/png'}));
    assert.equal(await snapshot,null);
  }finally{f.board.destroy();}
});

test("native fullscreen rejection keeps a usable overlay, and talk uses only the supplied callback", async () => {
  let talked = 0;
  const f = boardFixture({ nativeFullscreen: true, onTalk: () => talked++ });
  const overlay = f.doc.body.children[0]; overlay.requestFullscreen = () => Promise.reject(new Error("not allowed"));
  f.board.open(); await tick(); assert.equal(f.board.isOpen, true); assert.equal(overlay.hidden, false);
  f.byText("和爸爸说话").dispatch("click"); await tick(); assert.equal(talked, 1);
  f.board.setVoiceState("listening"); assert.equal(f.byText("暂停说话").getAttribute("aria-pressed"), "true");
  f.board.destroy();
});

test("touch drags cannot scroll away from the board, and touch devices stay in the overlay", async () => {
  const f = boardFixture({ nativeFullscreen: true });
  const overlay = f.doc.body.children[0];
  let fullscreenRequests = 0, prevented = 0;
  overlay.requestFullscreen = () => { fullscreenRequests++; return Promise.resolve(); };
  f.doc.defaultView.navigator = { maxTouchPoints: 5 };
  overlay.dispatch("touchmove", { cancelable: true, preventDefault() { prevented++; } });
  f.board.open(); await tick();
  try {
    assert.equal(fullscreenRequests, 0, "touch devices use the fixed overlay");
    overlay.dispatch("touchmove", { cancelable: true, preventDefault() { prevented++; } });
    assert.equal(prevented, 1, "a downward drag cannot scroll the page behind the board");
    f.canvas.dispatch("pointerdown", { pointerType: "touch", clientY: 300 });
    f.canvas.dispatch("pointermove", { pointerType: "touch", clientY: 100 });
    f.canvas.dispatch("pointerup", { pointerType: "touch" });
    assert.equal(f.board.isOpen, true);
    assert.ok(await f.board.getSnapshot(), "the stroke remains on the board");
  } finally { f.board.destroy(); }
  overlay.dispatch("touchmove", { cancelable: true, preventDefault() { prevented++; } });
  assert.equal(prevented, 1, "normal page scrolling resumes after closing");
});

test("leaving native fullscreen preserves the fixed drawing overlay", async () => {
  const f = boardFixture({ nativeFullscreen: true });
  const overlay = f.doc.body.children[0];
  overlay.requestFullscreen = () => { f.doc.fullscreenElement = overlay; return Promise.resolve(); };
  f.doc.exitFullscreen = () => { f.doc.fullscreenElement = null; return Promise.resolve(); };
  f.board.open(); await tick();
  try {
    f.canvas.dispatch("pointerdown"); f.canvas.dispatch("pointerup");
    f.doc.fullscreenElement = null;
    f.events.dispatch("fullscreenchange");
    assert.equal(f.board.isOpen, true);
    assert.equal(overlay.hidden, false);
    assert.ok(await f.board.getSnapshot());
  } finally { f.board.destroy(); }
});

test("small screens expand and fold brush tools without changing the drawing; desktop tools stay directly available", async () => {
  const f = boardFixture(); f.doc.viewportWidth = 320; f.board.open();
  const panel = f.made.find(node => node.className === "drawing-board__advanced-tools");
  const toggle = f.byText("画笔工具 ▾");
  try {
    assert.equal(toggle.hidden, false); assert.equal(panel.hidden, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(f.made.filter(node => node.className?.includes("drawing-board__swatch")).length, 6);
    assert.equal(f.byText("移动就画：关").hidden, false);
    f.canvas.dispatch("pointerdown"); f.canvas.dispatch("pointerup");
    const revision = f.board.revision, width = f.canvas.width, height = f.canvas.height;
    toggle.dispatch("click"); assert.equal(panel.hidden, false); assert.equal(toggle.getAttribute("aria-expanded"), "true");
    f.byText("粗").dispatch("click"); assert.equal(f.byText("粗").getAttribute("aria-pressed"), "true");
    toggle.dispatch("click"); assert.equal(panel.hidden, true);
    assert.equal(f.board.revision, revision); assert.equal(f.canvas.width, width); assert.equal(f.canvas.height, height);
    assert.ok(await f.board.getSnapshot());
    toggle.focus(); f.events.dispatch("keydown", { key: "Tab" });
    assert.equal(f.doc.activeElement, f.byText("← 返回"));
    f.doc.viewportWidth = 1400; f.windowEvents.dispatch("resize");
    assert.equal(toggle.hidden, true); assert.equal(panel.hidden, false);
    f.byText("粗").focus(); f.doc.viewportWidth = 320; f.windowEvents.dispatch("resize");
    assert.equal(panel.hidden, true); assert.equal(f.doc.activeElement, toggle, "shrinking does not leave focus inside hidden tools");
    toggle.dispatch("click"); f.board.close(); f.board.open();
    assert.equal(panel.hidden, true, "a new visit starts with more room for the drawing");
    assert.equal(f.board.revision, revision); assert.ok(await f.board.getSnapshot());
  } finally { f.board.destroy(); }
});
