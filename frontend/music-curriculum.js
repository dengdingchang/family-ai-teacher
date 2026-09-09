// Original five-finger exercises, then a public-domain Beethoven melody.
// No recordings, lyrics, sheet images, child identity or storage are included.
const lesson = (id, title, notes, skill, durations = notes.map(() => 1), source = "爸爸老师原创练习") =>
  Object.freeze({ id, title, notes: Object.freeze(notes), durations: Object.freeze(durations), skill, source });

export const MUSIC_LESSONS = Object.freeze([
  lesson("steps-up", "三个小脚印", ["C4", "D4", "E4"], "听见音一步步变高"),
  lesson("steps-down", "一起下山", ["E4", "D4", "C4"], "听见音一步步变低"),
  lesson("come-home", "走回来啦", ["C4", "D4", "E4", "C4"], "走三步，再回到哆"),
  lesson("five-friends", "五个好朋友", ["C4", "D4", "E4", "F4", "G4"], "认识五颗琴键"),
  lesson("swing", "小小秋千", ["C4", "E4", "G4", "G4", "E4", "C4"], "跳过一颗键，再慢慢回来"),
  lesson("train", "积木小火车", ["C4", "C4", "D4", "D4", "E4", "E4", "C4", "C4"], "同一个音也能接连弹两次"),
  lesson("picnic", "去郊游", ["C4", "D4", "E4", "G4", "G4", "E4", "F4", "E4", "D4", "D4", "C4", "C4"], "把三段短句接起来"),
  // Opening phrase, transposed to C major and simplified to one finger per note.
  // Source edition explicitly says Public Domain: https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=528
  lesson("ode-to-joy", "欢乐颂 · 第一小段", ["E4", "E4", "F4", "G4", "G4", "F4", "E4", "D4", "C4", "C4", "D4", "E4", "E4", "D4", "D4"],
    "把学会的五个音连成一段旋律", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, .5, 2],
    "贝多芬《欢乐颂》，公版旋律，五指简化编排"),
]);

export const MUSIC_THEMES = Object.freeze([
  Object.freeze({ id: "animals", title: "动物朋友", symbols: ["🐱", "🐶", "🐰", "🐻", "🐼"] }),
  Object.freeze({ id: "toys", title: "玩具伙伴", symbols: ["🧸", "🪁", "🚗", "🚂", "🎈"] }),
  Object.freeze({ id: "blocks", title: "磁力积木", symbols: ["●", "▲", "■", "◆", "⬟"] }),
  // Named previews are opt-in. Art is supplied by the host, never bundled or fetched here.
  // A home-use theme selection is not a claim of rights for public/commercial release.
  ...[
    ["ultraman", "奥特曼"], ["nailong", "奶龙"], ["plants-zombies", "植物大战僵尸"],
    ["minecraft", "Minecraft"], ["mini-force", "迷你特工队"],
  ].map(([id, title]) => Object.freeze({ id, title, subject: title, symbols: ["●", "▲", "■", "◆", "⬟"] })),
]);

export function compareMusicPhrase(played, reference, durations = reference.map(() => 1)) {
  const orderCorrect = played.length === reference.length && played.every((note, index) => note.id === reference[index]);
  if (played.length < reference.length) return { orderCorrect: false, rhythmKnown: false, rhythmEven: false };
  const gaps = played.slice(1).map((note, index) => (Number(note.at) - Number(played[index].at)) / durations[index]);
  const rhythmKnown = gaps.length > 0 && gaps.every(gap => Number.isFinite(gap) && gap >= 90 && gap <= 2200);
  const sorted = [...gaps].sort((a, b) => a - b), middle = sorted[Math.floor(sorted.length / 2)];
  const rhythmEven = rhythmKnown && gaps.every(gap => Math.abs(gap - middle) <= Math.max(180, middle * .5));
  return { orderCorrect, rhythmKnown, rhythmEven };
}

export const MUSIC_PROGRESS_KEY = "family-ai-teacher.music-practice.v1";

// Interface practice state only. Never a family assessment or a mastery record.
export function decodeMusicProgress(raw, lessons = MUSIC_LESSONS) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const value = JSON.parse(raw), keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
    if (keys.join(",") !== "completedLessonIds,currentLessonId,version" || value.version !== 1) return null;
    const known = new Set(lessons.map(item => item.id)), completed = value.completedLessonIds;
    if (!known.has(value.currentLessonId) || !Array.isArray(completed) || completed.length > lessons.length
        || completed.some(id => typeof id !== "string" || !known.has(id)) || new Set(completed).size !== completed.length) return null;
    return { version: 1, currentLessonId: value.currentLessonId, completedLessonIds: [...completed] };
  } catch (_) { return null; }
}

export class MusicJourney {
  constructor(lessons = MUSIC_LESSONS) {
    this.lessons = lessons; this.index = 0; this.completed = new Set(); this.resetAttempt();
  }
  get lesson() { return this.lessons[this.index]; }
  get isLast() { return this.index === this.lessons.length - 1; }
  snapshot() { return { version: 1, currentLessonId: this.lesson.id, completedLessonIds: [...this.completed] }; }
  restoreProgress(raw) {
    const value = decodeMusicProgress(raw, this.lessons); if (!value) return false;
    this.index = this.lessons.findIndex(lesson => lesson.id === value.currentLessonId); this.completed = new Set(value.completedLessonIds);
    // A just-finished phrase resumes at the next exercise after a page refresh.
    while (!this.isLast && this.completed.has(this.lesson.id)) this.index++;
    this.resetAttempt(); return true;
  }
  resetProgress() { this.index = 0; this.completed.clear(); this.resetAttempt(); }
  resetAttempt() { this.played = []; this.mistakes = 0; this.finished = false; }
  next() {
    if (this.isLast) return false;
    this.index++; this.resetAttempt(); return true;
  }
  markComplete() { this.completed.add(this.lesson.id); this.finished = true; }
  play(id, at) {
    if (this.finished) return { kind: "finished" };
    const expected = this.lesson.notes[this.played.length];
    if (id !== expected) { this.mistakes++; return { kind: "retry", expected, index: this.played.length }; }
    this.played.push({ id, at });
    if (this.played.length < this.lesson.notes.length) return { kind: "progress", index: this.played.length };
    const result = compareMusicPhrase(this.played, this.lesson.notes, this.lesson.durations);
    this.markComplete();
    return { kind: "complete", ...result, mistakes: this.mistakes };
  }
}
