const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BargeInGate } = require("../frontend/voice-activity.js");

test("barge-in accepts ordinary syllable gaps without counting quiet time", () => {
  const gate = new BargeInGate();
  assert.deepEqual([0.11, 0.12, 0.055, 0.16, 0.11, 0.10, 0.04, 0.12].map((rms, i) => gate.update(rms, i * 40)),
    [false, false, false, false, false, false, false, true]);
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
  assert.deepEqual([0, 40, 80, 120, 160, 200].map((t) => gate.update(0.1, t)), [false, false, false, false, false, true]);
  gate.reset();
  assert.equal(gate.update(0.1, 0), false);
  assert.equal(gate.update(0.1, 5000), false);
});

test("recorded synthetic syllables tolerate detector phase without lowering the RMS threshold", () => {
  const { runs } = require("./fixtures/synthetic-barge-rms.json");
  function replay(samples, config) {
    const triggers = [];
    for (let phase = 0; phase < config.sampleMs; phase++) {
      const gate = new BargeInGate(config);
      for (let at = phase; at <= samples.at(-1).at; at += config.sampleMs) {
        // Diagnostic trace is sampled at about 40 ms. This is a phase stress
        // test, not a reconstruction of physical audio or real timer jitter.
        const closest = samples.reduce((best, sample) =>
          Math.abs(sample.at - at) < Math.abs(best.at - at) ? sample : best, samples[0]);
        if (gate.update(closest.level, at)) { triggers.push(at); break; }
      }
    }
    return triggers;
  }
  for (const { samples } of runs) {
    const legacy = replay(samples, {voicedMs: 260, sampleMs: 80});
    assert.ok(legacy.length < 80, "the preserved trace must expose the previous phase sensitivity");
    const current = new BargeInGate();
    assert.equal(current.threshold, 0.075);
    assert.equal(replay(samples, current).length, current.sampleMs);
  }
});

test("more frequent polling still rejects taps, sparse bursts and low room noise", () => {
  const patterns = [
    i => i === 3 ? 0.4 : 0.02,
    i => i % 8 === 0 ? 0.4 : 0.02,
    i => i % 12 < 2 ? 0.2 : 0.03,
    () => 0.07,
  ];
  for (const level of patterns) {
    const gate = new BargeInGate();
    for (let i = 0; i < 250; i++) assert.equal(gate.update(level(i), i * 40), false);
  }
});

test("a new listening generation does not inherit earlier speech evidence", () => {
  const gate = new BargeInGate();
  [0, 80, 160].forEach((t) => assert.equal(gate.update(0.1, t), false));
  gate.reset();
  assert.equal(gate.update(0.1, 240), false);
  assert.equal(gate.update(0.1, 240), false);
  assert.equal(gate.update(NaN, 320), false);
});
