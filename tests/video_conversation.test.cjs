const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const recording = source.slice(source.indexOf('function supportedVideoMimeType()'),
  source.indexOf('recordVideoButton.addEventListener('));
const interrupt = source.slice(source.indexOf('async function interruptActiveReply()'),
  source.indexOf('function getDrawingBoard()'));

function harness({ busy = false, reply = async () => ({ ok: true }) } = {}) {
  const recorders = [], requests = [], events = [];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'video/webm'; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  const context = vm.createContext({
    Blob, FormData, AbortController, MediaRecorder: Recorder, window: { MediaRecorder: Recorder },
    activityEnabled: () => true, ensureCameraStream: async () => {}, cameraStream: { active: true },
    videoRecorder: null, videoChunks: [], videoStopTimer: null, videoRecordingGeneration: 0,
    videoRequestController: null, MANUAL_VIDEO_MAX_MS: 6000,
    recordVideoButton: { classList: { remove() {}, add() {} }, setAttribute() {}, disabled: false },
    cameraStatus: { textContent: '' }, captureState: { textContent: '' }, visionResult: { textContent: '' },
    setCameraActionState() {}, setTimeout() { return 1; }, clearTimeout() {},
    activeRequestController: null, interruptedRequestController: null, activeTurnId: 'old-voice',
    segmentRecording: true, segmentShouldSend: true, segmentPcmChunks: [], performance,
    cancelConversationTurn: async () => events.push('cancel-old-turn'),
    stopVadLoop() {}, stopBargeInMonitor() {}, clearResponseQueue() {}, cancelPlayback() {},
  });
  if (busy) context.activeRequestController = { abort() { events.push('abort-old'); context.activeRequestController = null; } };
  context.sendStreamingRequest = async (request) => {
    // The established request coordinator's public busy result is intentionally
    // preserved: callers must resolve the old turn before submitting new media.
    if (context.activeRequestController) return { ok: false, busy: true };
    requests.push(request);
    events.push('send-video');
    return reply(request);
  };
  vm.runInContext(interrupt + '\n' + recording, context);
  const start = () => vm.runInContext('startVideoRecording()', context);
  const chunk = (recorder, text = 'synthetic-video') => recorder.ondataavailable({ data: new Blob([text]) });
  const finish = (recorder) => { recorder.state = 'inactive'; return recorder.onstop(); };
  const discard = () => vm.runInContext('stopVideoRecording(true)', context);
  return { context, recorders, requests, events, start, chunk, finish, discard };
}

test('an explicitly completed video replaces a busy voice turn before sending its RAM clip once', async () => {
  const h = harness({ busy: true });
  await h.start(); h.chunk(h.recorders[0]); await h.finish(h.recorders[0]);
  assert.equal(h.requests.length, 1);
  assert.ok(h.events.indexOf('abort-old') < h.events.indexOf('send-video'));
  assert.equal(h.requests[0].endpoint, '/api/conversation/video/stream');
  assert.equal(await h.requests[0].body.get('video').text(), 'synthetic-video');
  assert.equal(h.context.captureState.textContent, '爸爸看到了动作');
});

test('a previous delayed recorder stop cannot submit or clear a new recording', async () => {
  const h = harness();
  await h.start(); h.chunk(h.recorders[0], 'old');
  await h.start(); h.chunk(h.recorders[1], 'new');
  await h.finish(h.recorders[0]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.context.videoRecorder, h.recorders[1]);
  await h.finish(h.recorders[1]);
  assert.equal(h.requests.length, 1);
  assert.equal(await h.requests[0].body.get('video').text(), 'new');
});

test('discarding a recording prevents its delayed stop from uploading', async () => {
  const h = harness();
  await h.start(); h.chunk(h.recorders[0]); h.discard();
  await h.finish(h.recorders[0]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.context.videoChunks.length, 0);
});

test('cancelling a video upload aborts it and its late result cannot overwrite newer status', async () => {
  let release;
  const h = harness({ reply: () => new Promise(resolve => { release = resolve; }) });
  await h.start(); h.chunk(h.recorders[0]);
  const pending = h.finish(h.recorders[0]);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.discard();
  h.context.cameraStatus.textContent = '摄像头已关好';
  assert.equal(h.requests[0].signal.aborted, true);
  release({ ok: true }); await pending;
  assert.equal(h.context.cameraStatus.textContent, '摄像头已关好');
  assert.notEqual(h.context.captureState.textContent, '爸爸看到了动作');
});

test('an actual decoding failure retains its diagnostic message', async () => {
  const h = harness({ reply: async () => ({ ok: false, error: 'could not extract a frame from the video' }) });
  await h.start(); h.chunk(h.recorders[0]); await h.finish(h.recorders[0]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.context.cameraStatus.textContent, '短视频分析失败');
  assert.equal(h.context.visionResult.textContent, 'could not extract a frame from the video');
});

test('failure to end the prior reply is reported before upload, without claiming analysis failed', async () => {
  const h = harness();
  h.context.interruptActiveReply = async () => { throw new Error('上一句话正在结束，请稍后再试一次'); };
  await h.start(); h.chunk(h.recorders[0]); await h.finish(h.recorders[0]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.context.cameraStatus.textContent, '视频还没有发送');
  assert.equal(h.context.visionResult.textContent, '上一句话正在结束，请稍后再试一次');
});

test('a failed recorder never uploads its partial buffered clip', async () => {
  const h = harness();
  await h.start(); h.chunk(h.recorders[0]); h.recorders[0].onerror();
  await h.finish(h.recorders[0]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.context.cameraStatus.textContent, '短视频录制失败，请再试一次');
});
