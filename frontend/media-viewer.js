const TRUSTED_MEDIA_HOSTS = Object.freeze([
  "wikipedia.org",
  "wikimedia.org",
  "youtube.com",
  "youtu.be",
  "ytimg.com",
  "cdc.gov",
  "mouthhealthy.org",
]);

function hostIsTrusted(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return TRUSTED_MEDIA_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

export function trustedMediaUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || !hostIsTrusted(parsed.hostname)) return "";
    if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

export function youtubeEmbedUrl(value) {
  const safe = trustedMediaUrl(value);
  if (!safe) return "";
  const parsed = new URL(safe);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  let id = "";
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host) && parsed.pathname === "/watch") {
    id = parsed.searchParams.get("v") || "";
  } else if (host === "youtu.be" && /^\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) {
    id = parsed.pathname.split("/")[1] || "";
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return "";
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
}

function text(value, maximum) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

export class MediaViewer {
  constructor({ container, document: doc = globalThis.document,
    later, cancelLater, now = () => Date.now(), closeDelayMs = 8000,
    onOpen = () => {}, onClose = () => {} } = {}) {
    if (!container || !doc?.body || typeof doc.createElement !== "function") {
      throw new Error("MediaViewer needs a container and document body");
    }
    this.container = container;
    this.doc = doc;
    this.win = doc.defaultView || globalThis;
    this.later = later || ((fn, ms) => this.win.setTimeout(fn, ms));
    this.cancelLater = cancelLater || (handle => this.win.clearTimeout(handle));
    this.now = now;
    this.closeDelayMs = Math.max(1000, Number(closeDelayMs) || 8000);
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.overlay = null;
    this.timer = null;
    this.trigger = null;
    this.destroyed = false;
    this._keydown = event => {
      if (event.key === "Escape" && this.overlay) {
        event.preventDefault();
        this.close();
      }
    };
    this.doc.addEventListener?.("keydown", this._keydown, true);
  }

  _node(tag, className = "", content = "") {
    const node = this.doc.createElement(tag);
    node.className = className;
    if (content) node.textContent = content;
    return node;
  }

  _button(label, className, action) {
    const button = this._node("button", className, label);
    button.type = "button";
    button.addEventListener("click", action);
    return button;
  }

  appendCards(cards) {
    if (this.destroyed || !Array.isArray(cards)) return [];
    const appended = [];
    for (const rawCard of cards) {
      const card = this._normaliseCard(rawCard);
      if (!card) continue;
      const element = this._buildCard(card);
      this.container.append(element);
      appended.push(element);
    }
    return appended;
  }

  render(cards) {
    return this.appendCards(cards);
  }

  _normaliseCard(rawCard) {
    if (!rawCard || !["image", "video", "link"].includes(rawCard.kind)) return null;
    const url = trustedMediaUrl(rawCard.url);
    const thumbnailUrl = trustedMediaUrl(rawCard.thumbnail_url ?? rawCard.thumbnailUrl);
    if (!url) return null;
    if (rawCard.kind === "image" && !thumbnailUrl) return null;
    return {
      kind: rawCard.kind,
      title: text(rawCard.title, 80) || "一起看看",
      description: text(rawCard.description, 180),
      source: text(rawCard.source, 60),
      url,
      thumbnailUrl,
    };
  }

  _buildCard(card) {
    const article = this._node("article", `media-card media-card--${card.kind}`);
    article.dataset.kind = card.kind;
    const heading = this._node("h3", "media-card__title", card.title);
    article.append(heading);
    if (card.kind === "image") article.append(this._imageEntry(card));
    if (card.kind === "video") article.append(this._videoEntry(card));
    if (card.kind === "link") article.append(this._linkEntry(card));
    if (card.description) article.append(this._node("p", "media-card__description", card.description));
    if (card.source) article.append(this._node("p", "media-card__source", `来源：${card.source}`));
    return article;
  }

  _preview(card, altPrefix) {
    const image = this._node("img", "media-card__preview");
    image.src = card.thumbnailUrl;
    image.alt = `${altPrefix}：${card.title}`;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    return image;
  }

  _imageEntry(card) {
    const button = this._button("", "media-card__media-button", event => this.openImage(card, event.currentTarget));
    button.setAttribute("aria-label", `放大图片：${card.title}`);
    button.append(this._preview(card, "图片"), this._node("span", "media-card__action", "点一下放大"));
    return button;
  }

  _videoEntry(card) {
    const button = this._button("", "media-card__media-button media-card__video-button", event => this.openVideo(card, event.currentTarget));
    button.setAttribute("aria-label", `打开视频：${card.title}`);
    if (card.thumbnailUrl) button.append(this._preview(card, "视频封面"));
    else button.append(this._node("span", "media-card__video-placeholder", "视频"));
    button.append(this._node("span", "media-card__play", "▶"), this._node("span", "media-card__action", "点一下播放"));
    return button;
  }

  _linkEntry(card) {
    const link = this._node("a", "media-card__link", "打开可信资料");
    link.href = card.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer external";
    return link;
  }

  _createOverlay(label) {
    this.close({ restoreFocus: false });
    const overlay = this._node("section", "media-viewer");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", label);
    const panel = this._node("div", "media-viewer__panel");
    const close = this._button("✕ 关闭", "media-viewer__control media-viewer__close", () => this.close());
    close.setAttribute("aria-label", "关闭查看器");
    panel.append(close);
    overlay.append(panel);
    overlay.addEventListener("click", event => { if (event.target === overlay) this.close(); });
    this.doc.body.append(overlay);
    this.overlay = overlay;
    this.panel = panel;
    this.closeButton = close;
    return panel;
  }

  openImage(card, trigger = null) {
    const normal = this._normaliseCard(card);
    if (!normal || normal.kind !== "image") return false;
    const panel = this._createOverlay(`查看图片：${normal.title}`);
    this.trigger = trigger;
    const image = this._node("img", "media-viewer__image");
    image.alt = normal.title;
    image.referrerPolicy = "no-referrer";
    const title = this._node("p", "media-viewer__title", normal.title);
    const replay = this._button("↻ 再看一次", "media-viewer__control media-viewer__replay", () => this._restartImageTimer());
    panel.append(image, title, replay);
    this._prepareImageTimer(this.overlay, image);
    image.src = normal.thumbnailUrl;
    this.openKind = "image";
    this.onOpen("image");
    return true;
  }

  _prepareImageTimer(overlay, image) {
    this.timer = {
      handle: null,
      loaded: false,
      remaining: this.closeDelayMs,
      startedAt: 0,
      pauses: new Set(),
    };
    const pause = reason => this._pauseImageTimer(reason);
    const resume = reason => this._resumeImageTimer(reason);
    overlay.addEventListener("mouseenter", () => pause("hover"));
    overlay.addEventListener("mouseleave", () => resume("hover"));
    overlay.addEventListener("pointerdown", () => pause("pointer"));
    overlay.addEventListener("pointerup", () => resume("pointer"));
    overlay.addEventListener("pointercancel", () => resume("pointer"));
    overlay.addEventListener("focusin", () => pause("focus"));
    overlay.addEventListener("focusout", event => {
      if (!event.relatedTarget || !overlay.contains?.(event.relatedTarget)) resume("focus");
    });
    const timer = this.timer;
    image.addEventListener("load", () => {
      if (this.timer !== timer || !image.isConnected) return;
      timer.loaded = true;
      timer.remaining = this.closeDelayMs;
      this._startImageTimer();
    }, { once: true });
  }

  _startImageTimer() {
    const timer = this.timer;
    if (!timer?.loaded || timer.handle !== null || timer.pauses.size || !this.overlay) return;
    timer.startedAt = this.now();
    timer.handle = this.later(() => {
      if (this.timer === timer) this.close();
    }, timer.remaining);
  }

  _pauseImageTimer(reason) {
    const timer = this.timer;
    if (!timer) return;
    timer.pauses.add(reason);
    if (timer.handle === null) return;
    this.cancelLater(timer.handle);
    timer.handle = null;
    timer.remaining = Math.max(0, timer.remaining - Math.max(0, this.now() - timer.startedAt));
  }

  _resumeImageTimer(reason) {
    if (!this.timer) return;
    this.timer.pauses.delete(reason);
    this._startImageTimer();
  }

  _restartImageTimer() {
    const timer = this.timer;
    if (!timer?.loaded) return;
    if (timer.handle !== null) this.cancelLater(timer.handle);
    timer.handle = null;
    timer.remaining = this.closeDelayMs;
    this._startImageTimer();
  }

  openVideo(card, trigger = null) {
    const normal = this._normaliseCard(card);
    if (!normal || normal.kind !== "video") return false;
    const panel = this._createOverlay(`观看视频：${normal.title}`);
    this.trigger = trigger;
    const title = this._node("p", "media-viewer__title", normal.title);
    const embed = youtubeEmbedUrl(normal.url);
    this.openKind = "video";
    this.onOpen("video");
    if (embed) {
      const frame = this._node("iframe", "media-viewer__video");
      frame.title = normal.title;
      frame.src = embed;
      frame.allow = "autoplay; encrypted-media; picture-in-picture";
      frame.allowFullscreen = true;
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      panel.append(frame, title);
    } else {
      const message = this._node("p", "media-viewer__external-note", "这个来源不能在这里播放，请在原网站打开。");
      const link = this._node("a", "media-viewer__control media-viewer__external", "在原网站打开视频");
      link.href = normal.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer external";
      panel.append(title, message, link);
    }
    return true;
  }

  close({ restoreFocus = true } = {}) {
    const trigger = this.trigger;
    const openKind = this.openKind;
    if (this.timer && this.timer.handle !== null) this.cancelLater(this.timer.handle);
    this.timer = null;
    this.overlay?.remove();
    this.overlay = null;
    this.panel = null;
    this.closeButton = null;
    this.trigger = null;
    this.openKind = null;
    if (openKind) this.onClose(openKind);
    if (restoreFocus && trigger?.isConnected) trigger.focus?.();
  }

  destroy() {
    if (this.destroyed) return;
    this.close({ restoreFocus: false });
    this.doc.removeEventListener?.("keydown", this._keydown, true);
    this.destroyed = true;
  }
}

export { TRUSTED_MEDIA_HOSTS };
