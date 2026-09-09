// Pure, monotonic-time rhythm round. The host owns animation, audio and cancellation.
// A late target waits at the landing line; children never lose lives or a whole song.
export class MusicRhythmRound {
  constructor(lesson, { beatMs = 900, leadBeats = 3 } = {}) {
    this.lesson = lesson; this.beatMs = Math.max(550, Math.min(1600, beatMs));
    this.leadMs = this.beatMs * leadBeats; this.windowMs = Math.min(420, this.beatMs * .45);
    let beats = 0;
    this.offsets = lesson.notes.map((_, index) => { const offset = beats * this.beatMs; beats += lesson.durations[index]; return offset; });
    this.index = 0; this.shift = 0; this.waiting = false; this.active = false; this.hits = [];
  }
  start(at) { this.startAt = at; this.active = true; return this; }
  stop() { this.active = false; }
  get done() { return this.index >= this.lesson.notes.length; }
  get dueAt() { return this.startAt + this.leadMs + this.offsets[this.index] + this.shift; }
  update(at) {
    if (!this.active || this.done) return false;
    if (!this.waiting && at > this.dueAt + this.windowMs) { this.waiting = true; return true; }
    return false;
  }
  hit(id, at) {
    if (!this.active || this.done) return { kind: "inactive" };
    this.update(at);
    const expected = this.lesson.notes[this.index];
    if (id !== expected) return { kind: "retry", expected };
    if (!this.waiting && at < this.dueAt - this.windowMs) return { kind: "early", expected };
    const assisted = this.waiting, errorMs = at - this.dueAt;
    if (assisted) this.shift += Math.max(0, errorMs);
    this.hits.push({ id, at, assisted, errorMs }); this.index++; this.waiting = false;
    if (this.done) this.active = false;
    return { kind: this.done ? "complete" : "hit", assisted, errorMs, index: this.index };
  }
  positions(at) {
    const displayAt = this.waiting ? this.dueAt : at;
    return this.lesson.notes.map((id, index) => ({ id, index,
      progress: (displayAt - (this.startAt + this.offsets[index] + this.shift)) / this.leadMs,
      caught: index < this.index, current: index === this.index }));
  }
  summary() { return { caught: this.hits.length, total: this.lesson.notes.length, onTime: this.hits.filter(hit => !hit.assisted).length, assisted: this.hits.filter(hit => hit.assisted).length }; }
}
