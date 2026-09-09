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
    later(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    cancelLater(id) { timers.delete(id); }, ...options });
  return { viewer, doc, container, timers, events, setClock(value) { clock = value; } };
}

test("URL boundary requires HTTPS, an exact allowlisted host suffix, and canonical YouTube links", async () => {
  const { trustedMediaUrl, youtubeEmbedUrl } = await viewerModule;
  assert.equal(trustedMediaUrl("http://www.cdc.gov/test"), "");
  assert.equal(trustedMediaUrl("https://wikipedia.org.evil.example/test"), "");
  assert.equal(trustedMediaUrl("https://user:secret@youtube.com/watch?v=AcYCMJvdupI"), "");
  assert.equal(trustedMediaUrl("https://youtube.com:444/watch?v=AcYCMJvdupI"), "");
  assert.match(trustedMediaUrl("https://upload.wikimedia.org/example.jpg"), /^https:/);
  assert.equal(trustedMediaUrl("/api/generated-media/0123456789abcdef01234567.png"), "/api/generated-media/0123456789abcdef01234567.png");
  assert.equal(trustedMediaUrl("/api/generated-media/../../data/child_profile.json"), "");
  assert.equal(trustedMediaUrl("/api/generated-media/0123456789abcdef01234567.jpg"), "");
  assert.equal(youtubeEmbedUrl("https://www.youtube.com/watch?v=AcYCMJvdupI"), "https://www.youtube-nocookie.com/embed/AcYCMJvdupI?autoplay=1");
  assert.equal(youtubeEmbedUrl("https://youtu.be/AcYCMJvdupI"), "https://www.youtube-nocookie.com/embed/AcYCMJvdupI?autoplay=1");
  assert.equal(youtubeEmbedUrl("https://www.youtube.com/embed/AcYCMJvdupI"), "");
  assert.equal(youtubeEmbedUrl("https://music.youtube.com/watch?v=AcYCMJvdupI"), "");
  assert.equal(youtubeEmbedUrl("https://youtube.com.evil.example/watch?v=AcYCMJvdupI"), "");
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

test("image auto-close starts on load, preserves remaining time while paused, and replay resets it", async () => {
  const f = await fixture();
  const [card] = f.viewer.appendCards([{ kind: "image", title: "月亮", url: "https://zh.wikipedia.org/wiki/test", thumbnail_url: "https://upload.wikimedia.org/moon.jpg" }]);
  findAll(card, "button")[0].dispatch("click");
  const overlay = f.viewer.overlay, image = findAll(overlay, "img")[0];
  assert.equal(f.timers.size, 0, "no close countdown exists before the large image loads");
  image.dispatch("load");
  assert.equal([...f.timers.values()][0].ms, 8000);
  f.setClock(3000); overlay.dispatch("pointerdown");
  assert.equal(f.timers.size, 0);
  f.setClock(5000); overlay.dispatch("pointerup");
  assert.equal([...f.timers.values()][0].ms, 5000, "paused time is not consumed");
  overlay.dispatch("mouseenter"); assert.equal(f.timers.size, 0);
  overlay.dispatch("mouseleave"); assert.equal([...f.timers.values()][0].ms, 5000);
  f.setClock(6000); overlay.dispatch("focusin");
  f.setClock(9000); overlay.dispatch("focusout", { relatedTarget: null });
  assert.equal([...f.timers.values()][0].ms, 4000);
  const replay = findAll(overlay, "button").find(button => button.textContent.includes("再看一次"));
  replay.dispatch("click");
  assert.equal([...f.timers.values()][0].ms, 8000);
  [...f.timers.values()][0].fn();
  assert.equal(f.viewer.overlay, null);
  f.viewer.destroy();
});

test("an automatically opened image cannot be frozen by appearing under a stationary pointer", async () => {
  const f = await fixture();
  f.viewer.openImage({ kind: "image", title: "磁铁", url: "/api/generated-media/0123456789abcdef01234567.png", thumbnail_url: "/api/generated-media/0123456789abcdef01234567.png" });
  const overlay = f.viewer.overlay, image = findAll(overlay, "img")[0];
  image.dispatch("load");
  assert.equal(f.timers.size, 1);
  overlay.dispatch("mouseenter");
  assert.equal(f.timers.size, 1, "a programmatic overlay keeps its child-friendly countdown");
  [...f.timers.values()][0].fn();
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
