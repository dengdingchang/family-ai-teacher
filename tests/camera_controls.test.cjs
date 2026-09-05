const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(
  path.join(__dirname, "../frontend/app.js"),
  "utf8",
);

test("starting voice requests microphone only, without implicitly opening the camera", async () => {
  const fn = source.slice(
    source.indexOf("async function startContinuousConversation()"),
    source.indexOf("function stopContinuousConversation()"),
  );
  const requests = [];
  let segments = 0;
  const node = () => ({ connect() {}, gain: { value: 1 } });
  class Context {
    sampleRate = 48000;
    async resume() {}
    createMediaStreamSource() {
      return node();
    }
    createAnalyser() {
      return node();
    }
    createScriptProcessor() {
      return node();
    }
    createGain() {
      return node();
    }
  }
  const context = vm.createContext({
    navigator: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          requests.push(constraints);
          return {};
        },
      },
    },
    window: { AudioContext: Context },
    conversationStarting: false,
    conversationActive: false,
    recordButton: {
      disabled: false,
      classList: { add() {} },
      setAttribute() {},
    },
    recordLabel: { textContent: "" },
    recordingStream: null,
    audioContext: null,
    beginContinuousSegment() {
      segments++;
    },
    releaseInputStream() {},
    ensureCameraStream() {
      throw new Error("Voice start must not request a camera");
    },
  });
  vm.runInContext(fn, context);
  await vm.runInContext("startContinuousConversation()", context);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].video, false);
  assert.equal(requests[0].audio.echoCancellation, true);
  assert.equal(context.conversationActive, true);
  assert.equal(segments, 1);
});

test("a parent-disabled camera cannot request devices, including when a stale stream exists", async () => {
  const fn = source.slice(
    source.indexOf("async function ensureCameraStream()"),
    source.indexOf("cameraButton.addEventListener("),
  );
  let requested = 0;
  const context = vm.createContext({
    activityEnabled: () => false,
    cameraStream: { active: true },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          requested++;
        },
      },
    },
  });
  vm.runInContext(fn, context);
  await assert.rejects(
    vm.runInContext("ensureCameraStream()", context),
    /关闭了画面活动/,
  );
  assert.equal(requested, 0);
});

test("an explicit permitted camera action requests video only and remains local preview", async () => {
  const fn = source.slice(
    source.indexOf("async function ensureCameraStream()"),
    source.indexOf("cameraButton.addEventListener("),
  );
  const requests = [];
  const stream = { active: true };
  const states = [];
  const context = vm.createContext({
    activityEnabled: (name) => name === "vision_photo",
    cameraStream: null,
    navigator: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          requests.push(constraints);
          return stream;
        },
      },
    },
    cameraVideo: { srcObject: null, async play() {} },
    cameraStatus: { textContent: "" },
    setCameraActionState: (state) => states.push(state),
    fetch() {
      throw new Error("Opening preview must not upload frames");
    },
  });
  vm.runInContext(fn, context);
  assert.equal(await vm.runInContext("ensureCameraStream()", context), stream);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].audio, false);
  assert.ok(requests[0].video);
  assert.equal(context.cameraVideo.srcObject, stream);
  assert.deepEqual(states, [true]);
});
