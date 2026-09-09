const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("frontend/index.html");
const app = read("frontend/app.js");
const callView = read("frontend/call-view.js");
const callCss = read("frontend/call-view.css");

test("child home keeps one conversation log and a real three-level activity path", () => {
  const historyStart = html.indexOf('id="chatHistory"');
  const historyEnd = html.indexOf("</div>\n        </div>\n        <details", historyStart);
  const historyMarkup = html.slice(historyStart, historyEnd);
  assert.ok(historyMarkup.includes('id="liveTurn"'), "the live turn belongs inside chatHistory");
  assert.equal((html.match(/id="liveTurn"/g) || []).length, 1, "there is no second live feed");
  assert.match(html, /id="playButton"[\s\S]*aria-controls="playChoices"/);
  for (const label of ["下棋", "互动游戏", "钢琴", "唱歌"]) assert.match(html, new RegExp(`>${label}`));
  assert.match(html, /data-music-mode="piano"/);
  assert.match(html, /data-music-mode="sing"/);
  assert.doesNotMatch(html, /data-unavailable/);
  assert.match(app, /import \{ MusicStudio \}/);
  assert.match(app, /openMusicActivity\(button\.dataset\.musicMode\)/);
});

test("inline picture-in-picture reuses frames and does not enter fullscreen", () => {
  assert.match(callView, /this\.surface\.classList\.add\('call-view'\)/);
  assert.match(callView, /frame\.addEventListener\('click', handler\)/);
  assert.match(callView, /this\.primary = this\.primary === 'dad' \? 'child' : 'dad'/);
  assert.doesNotMatch(callView, /requestFullscreen|document\.body\.style\.overflow|\.inert/);
  assert.match(callCss, /\[data-call-primary="dad"\] \.child-video/);
  assert.match(callCss, /\[data-call-primary="child"\] \.dad-video \.video-frame/);
});

test("camera controls use distinct icons and playback owns the speaking state", () => {
  assert.match(html, /camera-toggle/);
  assert.match(html, /record-video-tool/);
  assert.match(html, /id="recordProgress"/);
  assert.doesNotMatch(html, />\s*▷\s*</);
  assert.match(app, /cameraButton\.setAttribute\("aria-pressed", String\(open\)\)/);
  assert.match(app, /setVideoRecordingVisual\(true, 0\)/);
  assert.match(app, /event\.detail \|\| \{\}/);
  assert.match(app, /detail\.type === "scheduled"/);
  assert.match(app, /avatarStage\?\.dataset\.state !== "speaking"/);
});

test("music owns the listening segment until its full demo or singing turn closes", () => {
  const openStart = app.indexOf("async function openMusicActivity(");
  const openEnd = app.indexOf("async function openDrawingActivity(", openStart);
  const openMusic = app.slice(openStart, openEnd);
  assert.ok(openStart >= 0 && openEnd > openStart);
  assert.ok(openMusic.indexOf("stopVadLoop()") < openMusic.indexOf("studio.open()"));
  assert.ok(openMusic.indexOf("segmentRecording = false") < openMusic.indexOf("studio.open()"));

  const speakStart = app.indexOf("async function speakMusicInstruction(");
  const speakEnd = app.indexOf("async function acquireMusicMicrophone(", speakStart);
  assert.doesNotMatch(app.slice(speakStart, speakEnd), /beginContinuousSegment\(\)/);
  assert.match(app, /if \(!pageIsLeaving && musicConversationWasActive && conversationActive && !activeRequestController\) beginContinuousSegment\(\)/);
  assert.match(app, /else if \(!pageIsLeaving && !musicConversationWasActive && conversationActive\) stopContinuousConversation\(\)/);
});

test("media lookup sends only a local canonical topic and video pauses the conversation", () => {
  const mediaStart = app.indexOf("async function loadMediaSuggestions(");
  const mediaEnd = app.indexOf("function renderHistory(", mediaStart);
  const media = app.slice(mediaStart, mediaEnd);
  assert.match(media, /JSON\.stringify\(\{ topic \}\)/);
  for (const topic of ["蝴蝶", "火山", "彩虹"]) assert.match(media, new RegExp(`"${topic}"`));
  assert.doesNotMatch(media, /encodeURIComponent\(text\)|\?topic=/);
  assert.match(media, /signal: controller\.signal/);
  assert.match(media, /generation !== mediaSuggestionGeneration/);
  assert.match(app, /function stopContinuousConversation\(\)[\s\S]*cancelMediaSuggestionLookup\(\)/);
  assert.match(app, /if \(kind !== "video"\) return/);
  assert.match(app, /mediaConversationWasActive = conversationActive/);
  assert.match(app, /stopVadLoop\(\)[\s\S]*stopBargeInMonitor\(\)[\s\S]*cancelPlayback\(\)/);
});
