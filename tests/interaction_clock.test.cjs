const assert = require("node:assert/strict");
const { test } = require("node:test");
const { InteractionClock } = require("../frontend/interaction-clock.js");

function fixture(send) {
  let mono = 0, wall = Date.parse("2026-09-06T01:00:00Z"), ids = 0;
  const receipts = [];
  const clock = new InteractionClock({now: () => mono, wallNow: () => wall,
    makeId: () => `session-${++ids}`, send: send || (p => receipts.push(p))});
  const advance = (ms, tick = true) => {
    if (!tick) { mono += ms; wall += ms; return; }
    for (let left = ms; left > 0;) {
      const step = Math.min(left, 1000); mono += step; wall += step; left -= step; clock.tick();
    }
  };
  return {clock, receipts, advance, shiftWall: ms => {wall += ms;},
    seconds: () => receipts.reduce((sum, p) => sum + (Date.parse(p.end_at) - Date.parse(p.start_at)) / 1000, 0)};
}

test("an open microphone and playback alone do not create interaction time", () => {
  const f = fixture(), id = f.clock.begin();
  f.advance(600000); f.clock.playbackEnded(id); f.advance(70000); f.clock.end();
  assert.equal(f.seconds(), 0);
});

test("recognized interaction includes short waits but stops at sixty idle seconds", () => {
  const f = fixture(), id = f.clock.begin();
  f.clock.confirmInput(id); f.advance(120000); f.clock.end();
  assert.equal(f.seconds(), 60);
  assert.equal(f.receipts.length, 4);
  assert.deepEqual(f.receipts.map(p => p.sequence), [1, 2, 3, 4]);
});

test("real playback extends an active conversation and ending flushes its short tail", () => {
  const f = fixture(), id = f.clock.begin();
  f.clock.confirmInput(id); f.advance(40000); f.clock.playbackEnded(id);
  f.advance(23000); f.clock.end();
  assert.equal(f.seconds(), 63);
  assert.ok(f.receipts.every(p => Date.parse(p.end_at) - Date.parse(p.start_at) <= 15000));
});

test("hidden time is excluded and returning requires fresh confirmed input", () => {
  const f = fixture(), id = f.clock.begin();
  f.clock.confirmInput(id); f.advance(7000); f.clock.setVisible(false);
  f.advance(300000); f.clock.confirmInput(id); f.clock.setVisible(true);
  f.clock.playbackEnded(id); f.advance(10000);
  f.clock.confirmInput(id); f.advance(3000); f.clock.end();
  assert.equal(f.seconds(), 10);
});

test("a sleeping or throttled browser cannot backfill a long unobserved interval", () => {
  const f = fixture(), id = f.clock.begin();
  f.clock.confirmInput(id); f.advance(7000); f.advance(120000, false); f.clock.tick();
  f.clock.playbackEnded(id); f.advance(10000);
  f.clock.confirmInput(id); f.advance(2000); f.clock.end();
  assert.equal(f.seconds(), 9);
});

test("late callbacks cannot reopen a stopped session or affect a new one", () => {
  const f = fixture(), first = f.clock.begin();
  f.clock.confirmInput(first); f.advance(4000); f.clock.end(first);
  f.clock.confirmInput(first); f.advance(3000);
  const second = f.clock.begin();
  f.clock.confirmInput(first); f.clock.playbackEnded(first); f.clock.end(first); f.advance(5000);
  f.clock.confirmInput(second); f.advance(2000); f.clock.end(second);
  assert.equal(f.seconds(), 6);
  assert.deepEqual(f.receipts.map(p => p.session_id), [first, second]);
});

test("a wall clock change never becomes an hour of recorded conversation", () => {
  const f = fixture(), id = f.clock.begin();
  f.clock.confirmInput(id); f.advance(4000); f.shiftWall(3600000); f.clock.tick();
  f.advance(3000); f.clock.confirmInput(id); f.advance(2000); f.clock.end();
  assert.equal(f.seconds(), 6);
  assert.ok(f.receipts.every(p => Date.parse(p.end_at) - Date.parse(p.start_at) <= 15000));
});

test("unavailable interval storage cannot interrupt the conversation", async () => {
  for (const send of [() => {throw new Error("offline");}, () => Promise.reject(new Error("offline"))]) {
    const f = fixture(send), id = f.clock.begin();
    f.clock.confirmInput(id); f.advance(16000); f.clock.end();
    assert.equal(f.clock.enabled, false);
  }
  await new Promise(resolve => setImmediate(resolve));
});
