const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(path.join(__dirname, "../frontend/media-viewer.js")).href;
const viewerModule = import(moduleUrl);

class ClassList {
  constructor(owner) { this.owner = owner; }
  _values() { return new Set(this.owner.className.split(/\s+/).filter(Boolean)); }
  contains(value) { return this._values().has(value); }
}

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.handlers = new Map();
    this.attributes = {}; this.dataset = {}; this.className = ""; this.classList = new ClassList(this);
    this.textContent = ""; this.isConnected = true;
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { this.handlers.set(type, [...(this.handlers.get(type) || []), fn]); }
  removeEventListener(type, fn) { this.handlers.set(type, (this.handlers.get(type) || []).filter(item => item !== fn)); }
  dispatch(type, values = {}) { for (const fn of this.handlers.get(type) || []) fn({ target: this, currentTarget: this, preventDefault() {}, ...values }); }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  querySelector(selector) {
    if (selector.startsWith(".") && this.classList.contains(selector.slice(1))) return this;
    for (const child of this.children) { const found = child.querySelector?.(selector); if (found) return found; }
    return null;
  }
  remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  focus() { this.doc.activeElement = this; }
  set innerHTML(_) { throw new Error("media text must never use innerHTML"); }
}

function findAll(root, tag) {
  const found = root.tagName === tag.toUpperCase() ? [root] : [];
  for (const child of root.children) found.push(...findAll(child, tag));
  return found;
}

async function fixture(options = {}) {
  const { MediaViewer } = await viewerModule;
  const events = new Map();
  const doc = {
    body: null,
    activeElement: null,
    defaultView: { setTimeout, clearTimeout },
    createElement(tag) { return new Element(tag, doc); },
    addEventListener(type, fn) { events.set(type, fn); },
    removeEventListener(type) { events.delete(type); },
  };
  doc.body = new Element("body", doc);
  const container = new Element("div", doc); doc.body.append(container);
  const timers = new Map(); let timerId = 0, clock = 0;
  const viewer = new MediaViewer({ container, document: doc, now: () => clock,
    later(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms, due: clock + ms }); return id; },
    cancelLater(id) { timers.delete(id); }, ...options });
  return { viewer, doc, container, timers, events, setClock(value) { clock = value; },
    advance(ms) {
      const end = clock + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        clock = next[1].due; timers.delete(next[0]); next[1].fn();
      }
      clock = end;
    } };
}

test("URL boundary requires HTTPS, an exact allowlisted host suffix, and canonical YouTube links", async () => {
  const { trustedMediaUrl, youtubeEmbedUrl } = await viewerModule;
  assert.equal(trustedMediaUrl("http://www.cdc.gov/test"), "");
  assert.equal(trustedMediaUrl("https://wikipedia.org.evil.example/test"), "");
  assert.equal(trustedMediaUrl("https://user:secret@youtube.com/watch?v=AcYCMJvdupI"), "");
  assert.equal(trustedMediaUrl("https://youtube.com:444/watch?v=AcYCMJvdupI"), "");
  for (const host of ["nasa.gov", "si.edu", "pbskids.org", "sesamestreet.org", "khanacademy.org", "kids.nationalgeographic.com"]) {
    assert.equal(trustedMediaUrl(`https://${host}/learn`), `https://${host}/learn`);
    assert.equal(trustedMediaUrl(`https://${host}.evil.example/learn`), "");
    assert.equal(trustedMediaUrl(`http://${host}/learn`), "");
  }
  assert.equal(trustedMediaUrl("https://nationalgeographic.com/learn"), "", "the approved kids subdomain does not allow the whole site");
  assert.match(trustedMediaUrl("https://upload.wikimedia.org/example.jpg"), /^https:/);
  assert.equal(trustedMediaUrl("/api/generated-media/0123456789abcdef01234567.png"), "/api/generated-media/0123456789abcdef01234567.png");
  assert.equal(trustedMediaUrl("/api/generated-media/../../data/child_profile.json"), "");
  assert.equal(trustedMediaUrl("/api/generated-media/0123456789abcdef01234567.jpg"), "");
  assert.equal(youtubeEmbedUrl("https://www.youtube.com/watch?v=AcYCMJvdupI"), "https://www.youtube-nocookie.com/embed/AcYCMJvdupI?autoplay=1");
  assert.equal(youtubeEmbedUrl("https://youtu.be/AcYCMJvdupI"), "https://www.youtube-nocookie.com/embed/AcYCMJvdupI?autoplay=1");
  assert.equal(youtubeEmbedUrl("https://www.youtube.com/embed/AcYCMJvdupI"), "");
  assert.equal(youtubeEmbedUrl("https://music.youtube.com/watch?v=AcYCMJvdupI"), "");
  assert.equal(youtubeEmbedUrl("https://youtube.com.evil.example/watch?v=AcYCMJvdupI"), "");
  assert.equal(youtubeEmbedUrl("/api/generated-media/0123456789abcdef01234567.png"), "");
});

test("cards append to the conversation and untrusted cards or HTML-like text stay inert", async () => {
  const f = await fixture();
  const cards = f.viewer.appendCards([
    { kind: "image", title: "<img src=x onerror=alert(1)>", description: "<b>恐龙</b>", url: "https://zh.wikipedia.org/wiki/test", thumbnail_url: "https://upload.wikimedia.org/test.jpg", source: "Wikipedia" },
    { kind: "link", title: "刷牙", description: "每天两次", url: "https://www.cdc.gov/oral-health/test", source: "CDC" },
    { kind: "image", title: "坏链接", url: "https://evil.example/page", thumbnail_url: "https://evil.example/a.jpg" },
  ]);
  assert.equal(cards.length, 2);
  assert.equal(f.container.children.length, 2, "rendering appends and preserves earlier conversation nodes");
  assert.equal(findAll(cards[0], "h3")[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(findAll(cards[0], "p")[0].textContent, "<b>恐龙</b>");
  f.viewer.destroy();
});

test("image auto-close starts on load for five seconds, cannot freeze under a pointer, and replay resets it", async () => {
  const f = await fixture();
  const [card] = f.viewer.appendCards([{ kind: "image", title: "月亮", url: "https://zh.wikipedia.org/wiki/test", thumbnail_url: "https://upload.wikimedia.org/moon.jpg" }]);
  findAll(card, "button")[0].dispatch("click");
  const overlay = f.viewer.overlay, image = findAll(overlay, "img")[0];
  assert.equal(f.timers.size, 0, "no close countdown exists before the large image loads");
  image.dispatch("load");
  assert.equal([...f.timers.values()][0].ms, 5000);
  assert.equal(f.viewer.imageCountdown.textContent, "5 秒后收起");
  f.advance(3000); overlay.dispatch("pointerdown");
  assert.equal(f.viewer.imageCountdown.textContent, "2 秒后收起");
  overlay.dispatch("pointerup"); overlay.dispatch("mouseenter"); overlay.dispatch("mouseleave");
  overlay.dispatch("focusin"); overlay.dispatch("focusout", { relatedTarget: null });
  f.advance(1000);
  assert.equal(f.viewer.imageCountdown.textContent, "1 秒后收起", "pointer and focus never freeze the visible countdown");
  const replay = overlay.querySelector(".media-viewer__replay");
  assert.match(replay.textContent, /继续看5秒/);
  replay.dispatch("click");
  assert.equal(f.viewer.overlay, overlay, "continue shows the same picture, not a new generation");
  assert.equal(f.viewer.imageCountdown.textContent, "5 秒后收起");
  assert.match(f.viewer.imageStatus.textContent, /好，继续看这张图/);
  assert.equal([...f.timers.values()][0].ms, 5000);
  f.advance(4999); assert.equal(f.viewer.overlay, overlay);
  f.advance(1);
  assert.equal(f.viewer.overlay, null);
  assert.equal(f.timers.size, 0, "closing cleans up both display and expiry timers");
  f.viewer.destroy();
});

test("voice can reopen the last image, close it, or ask by its title without hijacking unrelated speech", async () => {
  const f = await fixture();
  assert.equal(f.viewer.handleVoiceCommand("爸爸老师，再看一次"), false, "no remembered image");
  f.viewer.openImage({ kind: "image", title: "蝴蝶", source: "测试来源", url: "https://zh.wikipedia.org/wiki/test", thumbnail_url: "https://upload.wikimedia.org/butterfly.jpg" });
  assert.match(findAll(f.viewer.overlay, "p").map(node => node.textContent).join(" "), /测试来源/);
  f.viewer.close();
  for (const command of ["爸爸老师，再看一次", "爸爸老师，打开刚才的图片", "给我看看蝴蝶的图片", "把图片放大一下", "再看一遍吧", "爸爸老师，再看刚才的图片", "爸爸老师，再给我看刚才的图片", "让我再看看"]) {
    assert.equal(f.viewer.handleVoiceCommand(command), true, command);
    assert.equal(f.viewer.openKind, "image");
    assert.equal(f.viewer.handleVoiceCommand("爸爸老师，把图片关掉"), true);
    assert.equal(f.viewer.overlay, null);
  }
  for (const command of ["不要打开图片", "爸爸刚才说再看一次", "我想看恐龙", "给我看看飞机图片", "爸爸老师给我看看飞机图片", "蝴蝶为什么飞", "我不要再看一次", "小兔子再看一次月亮"]) {
    assert.equal(f.viewer.handleVoiceCommand(command), false, command);
    assert.equal(f.viewer.overlay, null);
  }
  f.viewer.destroy();
  assert.equal(f.viewer.reopenLastImage(), false);
});

test("stale timers and image events cannot close or replace a newer viewer; Escape restores focus", async () => {
  const f = await fixture();
  const trigger = f.doc.createElement("button"); f.doc.body.append(trigger); trigger.focus();
  const card = { kind: "image", title: "月亮", url: "https://zh.wikipedia.org/wiki/test", thumbnail_url: "https://upload.wikimedia.org/moon.jpg" };
  f.viewer.openImage(card);
  const oldImage = findAll(f.viewer.overlay, "img")[0]; oldImage.dispatch("load");
  const oldTimer = [...f.timers.values()][0];
  f.viewer.reopenLastImage();
  const current = f.viewer.overlay;
  oldTimer.fn(); oldImage.dispatch("error");
  assert.equal(f.viewer.overlay, current);
  assert.equal(f.timers.size, 0);
  const image = findAll(current, "img")[0]; image.dispatch("load");
  assert.equal(f.timers.size, 2);
  let prevented = false, stopped = false;
  f.events.get("keydown")({ key: "Escape", preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  assert.equal(prevented && stopped, true);
  assert.equal(f.viewer.overlay, null);
  assert.equal(f.doc.activeElement, trigger);
  assert.equal(f.timers.size, 0);
  f.viewer.destroy();
});

test("images use the active fullscreen host and failed loads are retryable without a permanent overlay", async () => {
  const f = await fixture();
  const host = f.doc.createElement("section"); f.doc.body.append(host); f.doc.fullscreenElement = host;
  f.viewer.openImage({ kind: "image", title: "测试月亮", url: "https://zh.wikipedia.org/wiki/test", thumbnail_url: "https://upload.wikimedia.org/moon.jpg" });
  assert.equal(f.viewer.overlay.parentElement, host);
  const overlay = f.viewer.overlay;
  findAll(overlay, "img")[0].dispatch("error");
  assert.match(f.viewer.imageStatus.textContent, /暂时没打开/);
  assert.equal([...f.timers.values()][0].ms, 5000);
  overlay.querySelector(".media-viewer__replay").dispatch("click");
  assert.notEqual(f.viewer.overlay, overlay);
  findAll(f.viewer.overlay, "img")[0].dispatch("load");
  [...f.timers.values()][0].fn();
  assert.equal(f.viewer.overlay, null);
  f.viewer.destroy();
});

test("an automatically opened image cannot be frozen by appearing under a stationary pointer", async () => {
  const f = await fixture();
  f.viewer.openImage({ kind: "image", title: "磁铁", url: "/api/generated-media/0123456789abcdef01234567.png", thumbnail_url: "/api/generated-media/0123456789abcdef01234567.png" });
  const overlay = f.viewer.overlay, image = findAll(overlay, "img")[0];
  image.dispatch("load");
  assert.equal(f.timers.size, 2);
  overlay.dispatch("mouseenter");
  assert.equal(f.timers.size, 2, "a programmatic overlay keeps its child-friendly countdown");
  [...f.timers.values()][0].fn();
  assert.equal(f.viewer.overlay, null);
  f.viewer.destroy();
});

test("replay ignores stale expiry and countdown callbacks from the previous interval", async () => {
  const f = await fixture();
  f.viewer.openImage({ kind: "image", title: "蝴蝶", url: "https://zh.wikipedia.org/wiki/test", thumbnail_url: "https://upload.wikimedia.org/butterfly.jpg" });
  const overlay = f.viewer.overlay;
  findAll(overlay, "img")[0].dispatch("load");
  const staleCallbacks = [...f.timers.values()].map(timer => timer.fn);
  f.advance(2000);
  overlay.querySelector(".media-viewer__replay").dispatch("click");
  staleCallbacks.forEach(callback => callback());
  assert.equal(f.viewer.overlay, overlay);
  assert.equal(f.viewer.imageCountdown.textContent, "5 秒后收起");
  assert.equal(f.timers.size, 2, "only the latest expiry and countdown are scheduled");
  f.advance(1000); assert.equal(f.viewer.imageCountdown.textContent, "4 秒后收起");
  f.viewer.close(); staleCallbacks.forEach(callback => callback());
  assert.equal(f.timers.size, 0);
  assert.equal(f.viewer.overlay, null);
  f.viewer.destroy();
});

test("video creates no iframe before a click and external sources remain honest links", async () => {
  const f = await fixture();
  const [youtube, external] = f.viewer.appendCards([
    { kind: "video", title: "刷牙歌", url: "https://www.youtube.com/watch?v=AcYCMJvdupI", thumbnail_url: "https://i.ytimg.com/vi/AcYCMJvdupI/hqdefault.jpg" },
    { kind: "video", title: "CDC 视频", url: "https://www.cdc.gov/oral-health/video", thumbnail_url: "" },
  ]);
  assert.equal(findAll(f.doc.body, "iframe").length, 0);
  findAll(youtube, "button")[0].dispatch("click");
  assert.equal(findAll(f.doc.body, "iframe").length, 1);
  assert.equal(findAll(f.doc.body, "iframe")[0].src, "https://www.youtube-nocookie.com/embed/AcYCMJvdupI?autoplay=1");
  f.viewer.close();
  findAll(external, "button")[0].dispatch("click");
  assert.equal(findAll(f.doc.body, "iframe").length, 0);
  const link = findAll(f.viewer.overlay, "a")[0];
  assert.equal(link.href, "https://www.cdc.gov/oral-health/video");
  assert.equal(link.textContent, "在原网站打开视频");
  f.viewer.destroy();
});

test("host callbacks distinguish an opened video from an ordinary image", async () => {
  const events = [];
  const f = await fixture({ onOpen: kind => events.push(`open:${kind}`), onClose: kind => events.push(`close:${kind}`) });
  const [image, video] = f.viewer.appendCards([
    { kind: "image", title: "月亮", url: "https://zh.wikipedia.org/wiki/test", thumbnail_url: "https://upload.wikimedia.org/moon.jpg" },
    { kind: "video", title: "刷牙歌", url: "https://www.youtube.com/watch?v=AcYCMJvdupI", thumbnail_url: "https://i.ytimg.com/vi/AcYCMJvdupI/hqdefault.jpg" },
  ]);
  findAll(image, "button")[0].dispatch("click"); f.viewer.close();
  findAll(video, "button")[0].dispatch("click"); f.viewer.close();
  assert.deepEqual(events, ["open:image", "close:image", "open:video", "close:video"]);
  f.viewer.destroy();
});

test("media styles keep touch controls large, prevent overflow, and reduce motion", () => {
  const css = fs.readFileSync(path.join(__dirname, "../frontend/media-viewer.css"), "utf8");
  assert.match(css, /min-width: 48px/);
  assert.match(css, /min-height: 48px/);
  assert.match(css, /position: fixed/);
  assert.match(css, /max-width: 100%/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation: none !important/);
});
