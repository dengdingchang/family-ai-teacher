const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BargeInGate } = require("../frontend/voice-activity.js");

test("barge-in accepts ordinary syllable gaps without counting quiet time", () => {
  const gate = new BargeInGate();
  assert.deepEqual([0.11, 0.12, 0.055, 0.16, 0.11].map((rms, i) => gate.update(rms, i * 80)),
    [false, false, false, false, true]);
});

test("silence, an isolated click and sparse loud noises do not interrupt playback", () => {
  for (const levels of [Array(20).fill(0), [0.2, ...Array(19).fill(0)], Array.from({length: 20}, (_, i) => i % 4 ? 0 : 0.2)]) {
    const gate = new BargeInGate();
    assert.ok(levels.every((rms, i) => !gate.update(rms, i * 80)));
  }
});

test("a longer gap discards the preceding speech evidence", () => {
  const gate = new BargeInGate();
  assert.ok([0.11, 0.12, 0.055, 0.04, 0.16, 0.11].every((rms, i) => !gate.update(rms, i * 80)));
});

test("sustained speech interrupts and a delayed timer cannot manufacture voiced time", () => {
  const gate = new BargeInGate();
  assert.deepEqual([0, 80, 160, 240].map((t) => gate.update(0.1, t)), [false, false, false, true]);
  gate.reset();
  assert.equal(gate.update(0.1, 0), false);
  assert.equal(gate.update(0.1, 5000), false);
});

test("a new listening generation does not inherit earlier speech evidence", () => {
  const gate = new BargeInGate();
  [0, 80, 160].forEach((t) => assert.equal(gate.update(0.1, t), false));
  gate.reset();
  assert.equal(gate.update(0.1, 240), false);
  assert.equal(gate.update(0.1, 240), false);
  assert.equal(gate.update(NaN, 320), false);
});
