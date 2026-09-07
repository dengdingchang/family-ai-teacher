const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { StreamingPcmPlayer } = require("../frontend/pcm-player.js");
const appSource = fs.readFileSync(
  path.join(__dirname, "../frontend/app.js"),
  "utf8",
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const bytes = (marker) => Uint8Array.of(marker).buffer;

class FakeContext {
  currentTime = 10;
  state = "running";
  destination = {};
  sources = [];
  durations = [0.64, 0.64, 0.173, 1.21];
  async decodeAudioData(data) {
    const index = new Uint8Array(data)[0];
    if (index === 255) throw new Error("decoder rejected corrupt WAV");
    return { duration: this.durations[index] };
  }
  async resume() {
    this.state = "running";
  }
  createBufferSource() {
    const source = {
      startedAt: null,
      stopped: false,
      disconnected: false,
      connect() {},
      disconnect() {
        this.disconnected = true;
      },
      start(time) {
        this.startedAt = time;
      },
      stop() {
        this.stopped = true;
      },
      end() {
        this.onended?.();
      },
    };
    this.sources.push(source);
    return source;
  }
}

test('playback position follows output time and excludes underrun silence', async () => {
  const context = new FakeContext();
  const player = new StreamingPcmPlayer(context);
  assert.equal(player.playbackPositionSeconds(), null);
  player.enqueue(bytes(0));
  await tick();
  context.currentTime = 10.34;
  assert.ok(Math.abs(player.playbackPositionSeconds() - 0.32) < 1e-9);
  context.currentTime = 12;
  assert.equal(player.playbackPositionSeconds(), 0.64);
  player.enqueue(bytes(1));
  await tick();
  context.currentTime = 12.34;
  assert.ok(Math.abs(player.playbackPositionSeconds() - 0.96) < 1e-9);
  context.getOutputTimestamp = () => ({contextTime: 12.12});
  assert.ok(Math.abs(player.playbackPositionSeconds() - 0.74) < 1e-9);
  player.cancel();
  assert.equal(player.playbackPositionSeconds(), null);
});

test("irregular WAV durations are scheduled contiguously before any ended event", async () => {
  const context = new FakeContext();
  const events = [];
  const player = new StreamingPcmPlayer(context, {
    onEvent: (event) => events.push(event),
  });
  for (const marker of [0, 2, 3]) player.enqueue(bytes(marker));
  await tick();
  assert.equal(context.sources.length, 3);
  const [first, second, third] = context.sources;
  assert.equal(first.startedAt, 10.02);
  assert.equal(second.startedAt, first.startedAt + first.buffer.duration);
  assert.equal(third.startedAt, second.startedAt + second.buffer.duration);
  assert.equal(events.filter((event) => event.type === "scheduled").length, 3);
  assert.equal(
    events.some((event) => event.type === "ended"),
    false,
  );
  assert.equal(player.stats.underrunSeconds, 0);
});

test("the receipt waits for every scheduled node to really end", async () => {
  const context = new FakeContext();
  const player = new StreamingPcmPlayer(context);
  player.enqueue(bytes(0));
  player.enqueue(bytes(1));
  await tick();
  let completed = false;
  const receipt = player.drain().then((result) => {
    completed = true;
    return result;
  });
  context.sources[0].end();
  await tick();
  assert.equal(completed, false);
  context.sources[1].end();
  assert.equal((await receipt).segments, 2);
  assert.equal(completed, true);
});

test("the startup gate permits decoding multiple chunks before playback starts", async () => {
  const context = new FakeContext();
  let release;
  const decoded = [];
  const player = new StreamingPcmPlayer(context, {
    startGate: new Promise((resolve) => {
      release = resolve;
    }),
    onDecoded: (buffer) => decoded.push(buffer.duration),
  });
  player.enqueue(bytes(0));
  player.enqueue(bytes(1));
  await tick();
  assert.deepEqual(decoded, [0.64, 0.64]);
  assert.equal(context.sources.length, 0);
  release();
  await tick();
  assert.equal(context.sources.length, 2);
});

test("cancel immediately stops all scheduled sources and releases a waiting receipt", async () => {
  const context = new FakeContext();
  const events = [];
  const player = new StreamingPcmPlayer(context, {
    onEvent: (event) => events.push(event),
  });
  for (const marker of [0, 1, 2]) player.enqueue(bytes(marker));
  await tick();
  const receipt = player.drain();
  player.cancel();
  assert.equal((await receipt).cancelled, true);
  assert.ok(
    context.sources.every(
      (source) => source.stopped && source.disconnected && !source.onended,
    ),
  );
  assert.equal(events.filter((event) => event.type === "cancelled").length, 1);
});

test("late decode after cancellation never plays, and a fresh generation can play", async () => {
  const context = new FakeContext();
  let resolveOld;
  const normalDecode = context.decodeAudioData.bind(context);
  let first = true;
  context.decodeAudioData = (data) => {
    if (first) {
      first = false;
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    }
    return normalDecode(data);
  };
  const old = new StreamingPcmPlayer(context);
  old.enqueue(bytes(0));
  await tick();
  const oldReceipt = old.drain();
  old.cancel();
  assert.equal((await oldReceipt).cancelled, true);
  const next = new StreamingPcmPlayer(context);
  next.enqueue(bytes(2));
  await tick();
  resolveOld({ duration: 4 });
  await tick();
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0].buffer.duration, 0.173);
  context.sources[0].end();
  assert.equal((await next.drain()).segments, 1);
});

test("decoder failure stops already scheduled speech and rejects the receipt", async () => {
  const context = new FakeContext();
  const player = new StreamingPcmPlayer(context);
  player.enqueue(bytes(0));
  await tick();
  player.enqueue(bytes(255));
  await assert.rejects(player.drain(), /corrupt WAV/);
  assert.equal(context.sources[0].stopped, true);
  player.enqueue(bytes(2));
  await tick();
  assert.equal(context.sources.length, 1);
});

test("a cancelled gate cannot start queued audio even when it resolves later", async () => {
  const context = new FakeContext();
  let release;
  const player = new StreamingPcmPlayer(context, {
    startGate: new Promise((resolve) => {
      release = resolve;
    }),
  });
  player.enqueue(bytes(0));
  await tick();
  player.cancel();
  release();
  await tick();
  assert.equal(context.sources.length, 0);
});

function appContext() {
  const audio = new FakeContext();
  const cues = [],
    waits = [],
    events = [];
  const context = vm.createContext({
    StreamingPcmPlayer,
    streamingAudioContext: audio,
    streamingPlayback: null,
    audioContext: null,
    queueGeneration: 1,
    queuePlaybackError: null,
    audioQueue: [],
    queueDraining: false,
    queueDrainWaiters: [],
    avatarReady: true,
    avatarSocket: { readyState: 1 },
    WebSocket: { OPEN: 1 },
    avatarFrameSerial: 2,
    avatarCanvas: { hidden: false },
    avatarImage: { hidden: true },
    cueAvatar: (payload) => cues.push(payload.sequence),
    waitForAvatarFrame: (serial, timeout) =>
      new Promise((resolve) => waits.push({ serial, timeout, resolve })),
    cancelAvatarFrameWaiters: () =>
      waits.forEach((wait) => wait.resolve(false)),
    flushAvatar() {}, sendAvatarEvent() { return true; },
    setAvatarState() {},
    drainResponseQueue() {},
    cancelPlayback() {},
    window: {
      AudioContext: FakeContext,
      dispatchEvent: (event) => events.push(event),
    },
    CustomEvent: class {
      constructor(name, options) {
        this.type = name;
        this.detail = options.detail;
      }
    },
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    Uint8Array,
  });
  const extract = (start, end) =>
    appSource.slice(appSource.indexOf(start), appSource.indexOf(end));
  vm.runInContext(appSource.match(/^const STREAM_AVATAR_FIRST_FRAME_WAIT_MS = .*;$/m)[0], context);
  vm.runInContext(
    extract("function resolveQueueWaiters()", "function cancelPlayback()"),
    context,
  );
  vm.runInContext(
    extract("function enqueueAudio(", "async function consumeSse("),
    context,
  );
  const enqueue = (sequence, marker = 0, generation = 1) =>
    context.enqueueAudio(
      {
        sequence,
        audio_stream: true,
        audio_base64: Buffer.from([marker]).toString("base64"),
        avatar_pcm_base64: "fixture",
      },
      generation,
    );
  return { context, audio, cues, waits, events, enqueue };
}

test("stream avatar receives each PCM once and waits for its first frame only once", async () => {
  const { context, audio, cues, waits, enqueue } = appContext();
  enqueue(1);
  await tick();
  assert.deepEqual(cues, [1]);
  assert.equal(waits.length, 0);
  assert.equal(audio.sources.length, 0);
  enqueue(2, 1);
  enqueue(2, 1); // Duplicate transport event is neither spoken nor animated twice.
  enqueue(3, 2);
  await tick();
  assert.deepEqual(cues, [1, 2, 3]);
  assert.equal(waits.length, 1);
  assert.equal(waits[0].timeout, 2000);
  waits[0].resolve(true);
  await tick();
  assert.equal(audio.sources.length, 3);
  const receipt = context.waitForAudioQueue();
  audio.sources.forEach((source) => source.end());
  await receipt;
  assert.equal(waits.length, 1);
});

test("a short final utterance below the avatar threshold still starts and completes", async () => {
  const { context, audio, waits, enqueue } = appContext();
  enqueue(1, 2);
  await tick();
  assert.equal(waits.length, 0);
  const receipt = context.waitForAudioQueue();
  assert.equal(waits.length, 1);
  waits[0].resolve(false);
  await tick();
  assert.equal(audio.sources.length, 1);
  assert.equal(context.avatarImage.hidden, false);
  audio.sources[0].end();
  await receipt;
});

test("missing stream segments reject completion and stale SSE generations are ignored", async () => {
  const { context, audio, cues, enqueue } = appContext();
  enqueue(1, 0, 0);
  assert.equal(context.streamingPlayback, null);
  enqueue(1);
  enqueue(3);
  await assert.rejects(context.waitForAudioQueue(), /声音没有播放成功/);
  assert.deepEqual(cues, [1]);
  assert.equal(audio.sources.length, 0);
});
