const assert = require("node:assert/strict");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const curriculum = import(pathToFileURL(path.join(__dirname, "../frontend/music-curriculum.js")).href);
const rhythm = import(pathToFileURL(path.join(__dirname, "../frontend/music-rhythm.js")).href);

test("all eight growing lessons can be completed on five keys, with honest completion separate from visiting", async () => {
  const { MUSIC_LESSONS, MusicJourney } = await curriculum;
  assert.deepEqual(MUSIC_LESSONS.map(lesson => lesson.notes.length), [3, 3, 4, 5, 6, 8, 12, 15]);
  const visited = new MusicJourney(); visited.next(); assert.equal(visited.completed.size, 0);
  const journey = new MusicJourney();
  for (const lesson of MUSIC_LESSONS) {
    assert.equal(journey.lesson.id, lesson.id); assert.equal(lesson.durations.length, lesson.notes.length);
    assert.ok(lesson.notes.every(id => ["C4", "D4", "E4", "F4", "G4"].includes(id)));
    let at = 0, result;
    for (const [index, id] of lesson.notes.entries()) { result = journey.play(id, at); at += lesson.durations[index] * 600; }
    assert.equal(result.kind, "complete"); assert.equal(result.orderCorrect, true); assert.equal(result.rhythmEven, true);
    assert.ok(journey.completed.has(lesson.id)); journey.next();
  }
  assert.equal(journey.completed.size, 8); assert.equal(journey.isLast, true); assert.equal(journey.next(), false);
});

test("a wrong note preserves correct notes and points to the exact next key without false completion", async () => {
  const { MusicJourney } = await curriculum; const journey = new MusicJourney();
  assert.equal(journey.play("C4", 0).kind, "progress");
  assert.deepEqual(journey.play("G4", 400), { kind: "retry", expected: "D4", index: 1 });
  assert.deepEqual(journey.played.map(note => note.id), ["C4"]); assert.equal(journey.completed.size, 0);
  journey.play("D4", 800); const finish = journey.play("E4", 1200);
  assert.equal(finish.kind, "complete"); assert.equal(finish.mistakes, 1); assert.equal(journey.completed.size, 1);
  journey.resetAttempt(); assert.equal(journey.played.length, 0); assert.equal(journey.completed.size, 1);
});

test("rhythm accuracy uses the whole phrase and written beat lengths, not only the first three notes", async () => {
  const { compareMusicPhrase } = await curriculum;
  const reference = ["C4", "D4", "E4", "G4"], durations = [1, 1.5, .5, 1];
  assert.equal(compareMusicPhrase([0, 500, 1250, 1500].map((at, index) => ({ at, id: reference[index] })), reference, durations).rhythmEven, true);
  assert.equal(compareMusicPhrase([0, 500, 1250, 9000].map((at, index) => ({ at, id: reference[index] })), reference, durations).rhythmKnown, false);
});

test("rhythm waits for a missed target, shifts remaining notes, and distinguishes help from on-beat hits", async () => {
  const { MUSIC_LESSONS } = await curriculum, { MusicRhythmRound } = await rhythm;
  const round = new MusicRhythmRound(MUSIC_LESSONS[0], { beatMs: 900 }).start(1000);
  assert.equal(round.hit("C4", 1500).kind, "early"); assert.equal(round.index, 0);
  assert.equal(round.hit("G4", 3700).kind, "retry"); assert.equal(round.index, 0);
  assert.equal(round.hit("C4", 3700).assisted, false);
  assert.equal(round.update(9000), true); assert.equal(round.waiting, true);
  const held = round.positions(15000).find(note => note.current); assert.equal(held.progress, 1);
  assert.equal(round.hit("D4", 15000).assisted, true); assert.equal(round.dueAt, 15900);
  assert.equal(round.hit("E4", 15900).kind, "complete");
  assert.deepEqual(round.summary(), { caught: 3, total: 3, onTime: 2, assisted: 1 });
  assert.equal(round.hit("E4", 17000).kind, "inactive");
});

test("every lesson is playable in rhythm mode; stopped rounds cannot accept late input", async () => {
  const { MUSIC_LESSONS } = await curriculum, { MusicRhythmRound } = await rhythm;
  for (const lesson of MUSIC_LESSONS) {
    const round = new MusicRhythmRound(lesson, { beatMs: 1200 }).start(0);
    for (const id of lesson.notes) round.hit(id, round.dueAt);
    assert.equal(round.done, true); assert.equal(round.summary().onTime, lesson.notes.length);
  }
  const stopped = new MusicRhythmRound(MUSIC_LESSONS[0]).start(0); stopped.stop();
  assert.equal(stopped.hit("C4", 2700).kind, "inactive"); assert.equal(stopped.index, 0);
});

test("stored practice has an exact versioned shape and rejects unknown or oversized data", async () => {
  const { decodeMusicProgress } = await curriculum;
  const valid = { version: 1, currentLessonId: "come-home", completedLessonIds: ["steps-up"] };
  assert.deepEqual(decodeMusicProgress(JSON.stringify(valid)), valid);
  for (const invalid of [null, [], true, { ...valid, version: 2 }, { ...valid, nickname: "not-part-of-practice" },
    { ...valid, currentLessonId: "not-a-lesson" }, { ...valid, completedLessonIds: ["steps-up", "steps-up"] },
    { ...valid, completedLessonIds: ["unknown"] }, { ...valid, completedLessonIds: [1] }, { ...valid, completedLessonIds: "steps-up" },
    { ...valid, completedLessonIds: Array(10).fill("steps-up") }]) assert.equal(decodeMusicProgress(JSON.stringify(invalid)), null);
  assert.equal(decodeMusicProgress("broken-json"), null); assert.equal(decodeMusicProgress(" ".repeat(2049)), null);
});

test("a refresh resumes after a just-completed exercise and reset clears only practice progression", async () => {
  const { MusicJourney } = await curriculum; const first = new MusicJourney();
  for (const [index, id] of first.lesson.notes.entries()) first.play(id, index * 600);
  const restored = new MusicJourney(); assert.equal(restored.restoreProgress(JSON.stringify(first.snapshot())), true);
  assert.equal(restored.index, 1); assert.deepEqual([...restored.completed], ["steps-up"]); assert.equal(restored.finished, false);
  assert.equal(restored.restoreProgress("bad"), false); assert.equal(restored.index, 1);
  restored.resetProgress(); assert.deepEqual(restored.snapshot(), { version: 1, currentLessonId: "steps-up", completedLessonIds: [] });
});
