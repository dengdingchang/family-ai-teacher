const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/app.js"), "utf8");
const start = source.indexOf("async function resumeConversationAfterMedia(");
const end = source.indexOf("const mediaViewer = new MediaViewer", start);
const fn = source.slice(start, end);

function fixture() {
  const calls = [];
  const context = vm.createContext({
    activeRequestController: {}, conversationActive: true, conversationStarting: false,
    segmentRecording: false, mediaPlaybackGeneration: 1, mediaResumePending: true,
    mediaViewer: { openKind: null }, performance, setTimeout,
    beginContinuousSegment() { calls.push("resume"); },
  });
  vm.runInContext(fn, context);
  return { context, calls, run: () => vm.runInContext("resumeConversationAfterMedia(1)", context) };
}

test("closing video before an interrupted reply settles resumes the same live conversation", async () => {
  const f = fixture();
  const pending = f.run();
  setTimeout(() => { f.context.activeRequestController = null; }, 0);
  await pending;
  assert.deepEqual(f.calls, ["resume"]);
  assert.equal(f.context.mediaResumePending, false);
});

test("an ended or replaced conversation never resumes from a stale video close", async () => {
  const ended = fixture();
  const endedPending = ended.run();
  ended.context.conversationActive = false;
  ended.context.activeRequestController = null;
  await endedPending;
  assert.deepEqual(ended.calls, []);

  const replaced = fixture();
  const replacedPending = replaced.run();
  replaced.context.mediaPlaybackGeneration = 2;
  replaced.context.activeRequestController = null;
  await replacedPending;
  assert.deepEqual(replaced.calls, []);
  assert.equal(replaced.context.mediaResumePending, true);
});

test("pagehide invalidates media and music resume state before either viewer is destroyed", () => {
  const handlerStart = source.indexOf("function handlePageHide(");
  const handlerEnd = source.indexOf("\nwindow.addEventListener(\"pagehide\", handlePageHide)", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const observations = [];
  const context = vm.createContext({
    pageIsLeaving: false, mediaPlaybackGeneration: 7, mediaResumePending: true,
    mediaConversationWasActive: true, musicConversationWasActive: true,
    chessOpenGeneration: 2, cancelChessExplanation() {}, cancelMusicExplanation() {}, cancelMediaSuggestionLookup() {},
    musicStudio: { destroy() { observations.push({
      kind: "music", leaving: context.pageIsLeaving, shouldResume: context.musicConversationWasActive,
    }); } },
    mediaViewer: { destroy() { observations.push({
      kind: "media", leaving: context.pageIsLeaving, shouldResume: context.mediaConversationWasActive,
      generation: context.mediaPlaybackGeneration, pending: context.mediaResumePending,
    }); } },
  });
  vm.runInContext(source.slice(handlerStart, handlerEnd), context);
  context.handlePageHide();
  assert.deepEqual(observations, [
    { kind: "music", leaving: true, shouldResume: false },
    { kind: "media", leaving: true, shouldResume: false, generation: 8, pending: false },
  ]);
});
