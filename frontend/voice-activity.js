(function (root) {
  class BargeInGate {
    constructor({ threshold = 0.075, voicedMs = 240, sampleMs = 40, maxGapMs = 200, windowMs = 800 } = {}) {
      Object.assign(this, { threshold, voicedMs, sampleMs, maxGapMs, windowMs });
      this.reset();
    }

    reset() {
      this.lastSample = null;
      this.lastVoice = null;
      this.voiced = [];
    }

    update(level, now) {
      if (!Number.isFinite(level) || !Number.isFinite(now)) return false;
      if (this.lastSample !== null && now <= this.lastSample) return false;
      // Credit only one sample when a background tab delays its timer.
      const duration = this.lastSample === null ? this.sampleMs : Math.min(this.sampleMs, now - this.lastSample);
      this.lastSample = now;
      if (this.lastVoice !== null && now - this.lastVoice > this.maxGapMs) {
        this.voiced = [];
        this.lastVoice = null;
      }
      this.voiced = this.voiced.filter((sample) => sample.end > now - this.windowMs);
      if (level < this.threshold) return false;
      this.lastVoice = now;
      this.voiced.push({ end: now, duration });
      // Normal syllable gaps retain evidence, but never count as voiced time.
      const total = this.voiced.reduce((sum, sample) => sum + Math.min(sample.duration, sample.end - (now - this.windowMs)), 0);
      return total >= this.voicedMs;
    }
  }

  root.BargeInGate = BargeInGate;
  if (typeof module !== "undefined" && module.exports) module.exports = { BargeInGate };
})(globalThis);
