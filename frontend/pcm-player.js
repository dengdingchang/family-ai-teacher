(function exposePcmPlayer(root) {
  "use strict";

  /** A single response owns one player. Decoding never waits for playback. */
  class StreamingPcmPlayer {
    constructor(
      context,
      {
        startGate = Promise.resolve(),
        onDecoded = () => {},
        onEvent = () => {},
      } = {},
    ) {
      this.context = context;
      this.onDecoded = onDecoded;
      this.onEvent = onEvent;
      this.sources = new Set();
      this.buffers = [];
      this.waiters = [];
      this.decodeTail = Promise.resolve();
      this.pendingDecodes = 0;
      this.nextStart = 0;
      this.timeline = [];
      this.gateOpen = false;
      this.cancelled = false;
      this.error = null;
      this.epoch = 0;
      this.stats = {
        segments: 0,
        seconds: 0,
        underrunSeconds: 0,
        firstStart: null,
      };
      Promise.resolve(startGate)
        .then(() => {
          if (this.cancelled || this.error) return;
          this.gateOpen = true;
          this.schedule();
        })
        .catch((error) => this.fail(error));
    }

    enqueue(wavBytes) {
      if (this.cancelled || this.error) return;
      const epoch = this.epoch;
      this.pendingDecodes += 1;
      // Retain wire order even if a browser decodes one small WAV more slowly.
      this.decodeTail = this.decodeTail
        .then(async () => {
          if (epoch !== this.epoch || this.cancelled || this.error) return;
          const buffer = await this.context.decodeAudioData(wavBytes.slice(0));
          if (epoch !== this.epoch || this.cancelled || this.error) return;
          if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
            throw new Error(
              "The audio stream contains an empty or invalid segment",
            );
          }
          this.buffers.push(buffer);
          this.onDecoded(buffer);
          this.pendingDecodes -= 1;
          this.schedule();
        })
        .catch((error) => {
          if (epoch === this.epoch && !this.cancelled) this.fail(error);
        });
    }

    schedule() {
      if (!this.gateOpen || this.cancelled || this.error) return;
      try {
        while (this.buffers.length) {
          const buffer = this.buffers.shift();
          const source = this.context.createBufferSource();
          source.buffer = buffer;
          source.connect(this.context.destination);
          const earliest = this.context.currentTime + 0.02;
          const start = Math.max(earliest, this.nextStart);
          if (this.nextStart && earliest > this.nextStart) {
            this.stats.underrunSeconds += earliest - this.nextStart;
          }
          this.nextStart = start + buffer.duration;
          const segment = this.stats.segments + 1;
          this.sources.add(source);
          source.onended = () => {
            source.onended = null;
            source.disconnect();
            this.sources.delete(source);
            this.report("ended", {
              segment,
              contextStartTime: start,
              duration: buffer.duration,
            });
            this.settle();
          };
          source.start(start);
          this.timeline.push({ start, duration: buffer.duration, offset: this.stats.seconds });
          if (this.stats.firstStart === null) this.stats.firstStart = start;
          this.stats.segments += 1;
          this.stats.seconds += buffer.duration;
          this.report("scheduled", {
            segment,
            contextStartTime: start,
            duration: buffer.duration,
          });
        }
        this.settle();
      } catch (error) {
        this.fail(error);
      }
    }

    playbackPositionSeconds() {
      if (this.cancelled || this.error || !this.timeline.length || !this.sources.size) return null;
      const output = this.context.getOutputTimestamp?.();
      const now = output?.contextTime > 0 ? output.contextTime : this.context.currentTime;
      for (let index = this.timeline.length - 1; index >= 0; index--) {
        const segment = this.timeline[index];
        if (now >= segment.start) {
          return segment.offset + Math.min(segment.duration, now - segment.start);
        }
      }
      return 0;
    }

    drain() {
      return new Promise((resolve, reject) => {
        this.waiters.push({ resolve, reject });
        this.settle();
      });
    }

    settle() {
      if (
        !this.cancelled &&
        !this.error &&
        (this.pendingDecodes || this.buffers.length || this.sources.size)
      )
        return;
      const waiters = this.waiters.splice(0);
      for (const waiter of waiters) {
        if (this.error) waiter.reject(this.error);
        else waiter.resolve({ cancelled: this.cancelled, ...this.stats });
      }
    }

    stopSources() {
      for (const source of this.sources) {
        source.onended = null;
        try {
          source.stop();
        } catch (_) {
          /* Already ended. */
        }
        try {
          source.disconnect();
        } catch (_) {
          /* Already disconnected. */
        }
      }
      this.sources.clear();
      this.buffers = [];
      this.pendingDecodes = 0;
    }

    report(type, detail = {}) {
      try {
        this.onEvent({
          type,
          contextTime: this.context.currentTime,
          performanceTime:
            typeof performance !== "undefined" ? performance.now() : null,
          outputTimestamp: this.context.getOutputTimestamp?.() || null,
          ...detail,
        });
      } catch (_) {
        /* Observers must never affect audio or completion. */
      }
    }

    fail(error) {
      if (this.cancelled || this.error) return;
      this.error = error instanceof Error ? error : new Error(String(error));
      this.epoch += 1;
      this.stopSources();
      this.report("error", { message: "Audio stream playback failed" });
      this.settle();
    }

    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      this.epoch += 1;
      this.stopSources();
      this.report("cancelled");
      this.settle();
    }
  }

  root.StreamingPcmPlayer = StreamingPcmPlayer;
  if (typeof module !== "undefined" && module.exports)
    module.exports = { StreamingPcmPlayer };
})(globalThis);
