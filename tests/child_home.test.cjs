const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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
  assert.match(app, /import \{ MusicStudio, parseMusicVoiceCommand \}/);
  assert.match(app, /openMusicActivity\(button\.dataset\.musicMode\)/);
});

test("inline picture-in-picture reuses frames and immersive dad view stays in the page", () => {
  assert.match(callView, /this\.surface\.classList\.add\('call-view'\)/);
  assert.match(callView, /frame\.addEventListener\('click', handler\)/);
  assert.match(callView, /this\.primary = this\.primary === 'dad' \? 'child' : 'dad'/);
  assert.doesNotMatch(callView, /requestFullscreen|\.inert/);
  assert.match(html, /id="dadExpandButton"[\s\S]*aria-label="放大爸爸老师画面"/);
  assert.match(callCss, /\.is-dad-immersive/);
  assert.match(callCss, /\[data-call-primary="dad"\] \.child-video/);
  assert.match(callCss, /\[data-call-primary="child"\] \.dad-video \.video-frame/);
});

test("dad expand button toggles a large voice view and Escape restores page scroll", async () => {
  const { CallView } = await import(pathToFileURL(path.join(__dirname, "../frontend/call-view.js")).href);
  const handlers = new Map();
  const node = () => ({ handlers: new Map(), addEventListener(type, fn) { this.handlers.set(type, fn); },
    removeEventListener(type) { this.handlers.delete(type); }, setAttribute(name, value) { this[name] = value; },
    closest() { return null; }, focus() {} });
  const dad = node(), child = node(), button = node(), label = { textContent: "" };
  button.querySelector = () => label;
  const classes = new Set();
  const doc = { body: { style: { overflow: "auto" } }, addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type) { handlers.delete(type); } };
  const surface = { ownerDocument: doc, dataset: {}, classList: {
    add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
  }, querySelector(selector) { return selector === "#dadExpandButton" ? button
    : selector.includes(".dad-video") ? dad : child; } };
  const view = new CallView(surface);
  button.handlers.get("click")({ preventDefault() {}, stopPropagation() {} });
  assert.equal(classes.has("is-dad-immersive"), true);
  assert.equal(doc.body.style.overflow, "hidden");
  assert.equal(button["aria-pressed"], "true");
  assert.equal(label.textContent, "收起");
  handlers.get("keydown")({ key: "Escape", preventDefault() {} });
  assert.equal(classes.has("is-dad-immersive"), false);
  assert.equal(doc.body.style.overflow, "auto");
  assert.equal(button["aria-pressed"], "false");
  view.destroy();
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
  assert.match(app.slice(speakStart, speakEnd), /musicStudio\.listeningAllowed\)\) beginContinuousSegment\(\)/);
  assert.match(app, /if \(!pageIsLeaving && musicConversationWasActive && conversationActive && !activeRequestController\) beginContinuousSegment\(\)/);
  assert.match(app, /else if \(!pageIsLeaving && !musicConversationWasActive && \(conversationActive \|\| conversationStarting\)\) stopContinuousConversation\(\)/);
});

test("media lookup sends only a local canonical topic and video pauses the conversation", () => {
  const mediaStart = app.indexOf("async function loadMediaSuggestions(");
  const mediaEnd = app.indexOf("function renderHistory(", mediaStart);
  const media = app.slice(mediaStart, mediaEnd);
  assert.match(media, /JSON\.stringify\(\{ topic, kind, generate_image: generateImage, image_job_id: imageJobId \}\)/);
  for (const topic of ["蝴蝶", "火山", "彩虹"]) assert.ok(read("frontend/media-intent.js").includes(topic));
  assert.doesNotMatch(media, /encodeURIComponent\(text\)|\?topic=/);
  assert.match(media, /signal: controller\.signal/);
  assert.match(media, /generation !== mediaSuggestionGeneration/);
  assert.match(app, /loadMediaSuggestions\(childTurnText, assistantText\)/);
  assert.match(app, /function stopContinuousConversation\(\)[\s\S]*cancelMediaSuggestionLookup\(\)/);
  assert.match(app, /if \(kind !== "video"\) return/);
  assert.match(app, /mediaConversationWasActive = conversationActive/);
  assert.match(app, /stopVadLoop\(\)[\s\S]*stopBargeInMonitor\(\)[\s\S]*cancelPlayback\(\)/);
});
