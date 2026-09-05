(function (root) {
  "use strict";

  // Measures confirmed, visible conversation time, never learning or attention.
  class InteractionClock {
    constructor({ now = () => performance.now(), wallNow = () => Date.now(),
      makeId = () => crypto.randomUUID(), send = () => {}, idleMs = 60000,
      chunkMs = 15000, maxTickGapMs = 5000 } = {}) {
      Object.assign(this, { now, wallNow, makeId, send, idleMs, chunkMs, maxTickGapMs });
      this.enabled = false;
      this.visible = true;
      this.sessionId = null;
      this.sequence = 0;
      this.lastActivity = -Infinity;
      this.needsInput = true;
      this.pending = null;
      this.reanchor();
    }

    reanchor() {
      this.anchorMono = this.now();
      this.anchorWall = this.wallNow();
      this.lastTick = this.anchorMono;
    }

    begin() {
      if (this.enabled) return this.sessionId;
      this.reanchor();
      this.enabled = true;
      this.sessionId = this.makeId();
      this.sequence = 0;
      this.lastActivity = -Infinity;
      this.needsInput = true;
      return this.sessionId;
    }

    confirmInput(sessionId) {
      if (!this.enabled || !this.visible || sessionId !== this.sessionId) return;
      this.tick();
      this.needsInput = false;
      this.lastActivity = this.now();
    }

    playbackEnded(sessionId) {
      if (!this.enabled || !this.visible || sessionId !== this.sessionId) return;
      this.tick();
      // Delayed playback callbacks cannot restart an ended/hidden/frozen session.
      if (!this.needsInput) this.lastActivity = this.now();
    }

    tick() {
      const now = this.now();
      const gap = now - this.lastTick;
      const drift = this.wallNow() - (this.anchorWall + now - this.anchorMono);
      if (gap < 0 || gap > this.maxTickGapMs || Math.abs(drift) > this.maxTickGapMs) {
        this.flush();
        this.reanchor();
        this.lastActivity = -Infinity;
        this.needsInput = true;
        return;
      }
      const end = Math.min(now, this.lastActivity + this.idleMs);
      if (this.enabled && this.visible && !this.needsInput && end > this.lastTick) {
        this.append(this.lastTick, end);
      }
      this.lastTick = now;
      if (end < now) this.flush();
    }

    append(start, end) {
      while (start < end) {
        if (this.pending && Math.abs(this.pending.end - start) > 0.01) this.flush();
        if (!this.pending) this.pending = { start, end: start };
        const cut = Math.min(end, this.pending.start + this.chunkMs);
        this.pending.end = cut;
        start = cut;
        if (this.pending.end - this.pending.start >= this.chunkMs) this.flush();
      }
    }

    flush() {
      const interval = this.pending;
      this.pending = null;
      if (!interval || interval.end <= interval.start) return;
      const timestamp = (mono) => new Date(this.anchorWall + mono - this.anchorMono).toISOString();
      const startAt = timestamp(interval.start), endAt = timestamp(interval.end);
      if (startAt === endAt) return;
      const payload = {
        session_id: this.sessionId,
        sequence: ++this.sequence,
        start_at: startAt,
        end_at: endAt,
      };
      try {
        Promise.resolve(this.send(payload)).catch(() => {});
      } catch (_) {
        // Missing telemetry must never block conversation or invent elapsed time.
      }
    }

    setVisible(visible) {
      if (this.visible === visible) return;
      this.tick();
      this.flush();
      this.visible = visible;
      this.needsInput = true;
      this.lastActivity = -Infinity;
    }

    end(sessionId = this.sessionId) {
      if (!this.enabled || sessionId !== this.sessionId) return;
      this.tick();
      this.flush();
      this.enabled = false;
      this.needsInput = true;
      this.lastActivity = -Infinity;
    }
  }

  root.InteractionClock = InteractionClock;
  if (typeof module !== "undefined" && module.exports) module.exports = { InteractionClock };
})(globalThis);
