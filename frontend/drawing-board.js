(function exposeDrawingBoard(root) {
  "use strict";

  // Observation owns no network or storage. The caller supplies the Vision adapter.
  class DrawingObservationQueue {
    constructor({ snapshot, observe, onResult = () => {}, onState = () => {},
      now = () => Date.now(), later = (fn, delay) => root.setTimeout(fn, delay),
      cancelLater = handle => root.clearTimeout(handle),
      debounceMs = 1200, intervalMs = 5000 } = {}) {
      Object.assign(this, { snapshot, observe, onResult, onState, now, later, cancelLater });
      this.debounceMs = Math.max(1200, debounceMs);
      this.intervalMs = Math.max(5000, intervalMs);
      this.active = false; this.visible = true; this.enabled = true;
      this.revision = 0; this.epoch = 0; this.hasContent = false;
      this.dirty = false; this.busy = false; this.timer = null;
      this.changedAt = 0; this.dirtySince = Infinity;
      this.lastStarted = -Infinity; this.retryAt = 0; this.controller = null;
    }
    current(revision, epoch) {
      return this.active && this.visible && this.enabled && this.hasContent
        && revision === this.revision && epoch === this.epoch;
    }
    invalidate() {
      this.epoch++;
      if (this.timer !== null) this.cancelLater(this.timer);
      this.timer = null;
      this.controller?.abort();
    }
    setActive(value) {
      this.invalidate(); this.active = value;
      if (value) { this.dirty = this.hasContent; this.dirtySince = this.changedAt = this.now(); }
      this.schedule();
    }
    setVisible(value) {
      if (this.visible === value) return;
      this.invalidate(); this.visible = value;
      if (value) { this.dirty = this.hasContent; this.dirtySince = this.changedAt = this.now(); }
      this.schedule();
    }
    setEnabled(value) {
      if (this.enabled === value) return;
      this.invalidate(); this.enabled = value;
      if (value) { this.dirty = this.hasContent; this.dirtySince = this.changedAt = this.now(); }
      this.schedule();
    }
    changed(revision, hasContent) {
      this.revision = revision; this.hasContent = hasContent;
      this.changedAt = this.now();
      if (!hasContent) this.dirtySince = Infinity;
      else if (!this.dirty) this.dirtySince = this.changedAt;
      this.dirty = hasContent;
      this.schedule();
    }
    schedule() {
      if (this.timer !== null) this.cancelLater(this.timer);
      this.timer = null;
      if (!this.active || !this.visible || !this.enabled || !this.dirty || this.busy) return;
      // Prefer a short pause, but continuous pen movement must not starve Vision.
      const progressAt = Math.min(this.changedAt + this.debounceMs, this.dirtySince + this.intervalMs);
      const due = Math.max(progressAt, this.lastStarted + this.intervalMs, this.retryAt);
      this.timer = this.later(() => { this.timer = null; void this.run(); }, Math.max(0, due - this.now()));
    }
    async run() {
      if (!this.active || !this.visible || !this.enabled || !this.dirty || this.busy) return;
      const revision = this.revision, epoch = this.epoch;
      const controller = this.controller = new AbortController();
      const isActive = () => !controller.signal.aborted && this.active && this.visible
        && this.enabled && this.hasContent && epoch === this.epoch;
      const isCurrent = () => !controller.signal.aborted && this.current(revision, epoch);
      this.busy = true; this.dirty = false; this.dirtySince = Infinity;
      try {
        const blob = await this.snapshot();
        // PNG encoding is asynchronous. New strokes may arrive meanwhile; a
        // recent snapshot remains useful in the same open, authorized session.
        if (!blob || !isActive()) return;
        const previousStart = this.lastStarted;
        this.lastStarted = this.now();
        this.onState("observing", revision, epoch);
        const result = await this.observe(blob, revision, { signal: controller.signal, sessionId: epoch, isCurrent, isActive });
        if (result?.deferred && !controller.signal.aborted && this.active && this.visible && this.enabled) {
          // A busy voice adapter has not started a Vision request. Retry the
          // newest drawing, retaining the interval from the last actual request.
          this.lastStarted = previousStart; this.dirty = this.hasContent;
          if (!Number.isFinite(this.dirtySince)) this.dirtySince = this.now();
          this.retryAt = this.now() + 1000;
          if (isCurrent()) this.onState("waiting", revision, epoch);
          return;
        }
        if (isCurrent()) { this.onResult(result, revision, epoch); this.onState("idle", revision, epoch); }
      } catch (error) {
        if (isCurrent()) this.onState("error", revision, epoch);
      } finally {
        this.busy = false;
        if (this.controller === controller) this.controller = null;
        this.schedule();
      }
    }
  }

  function createDrawingBoard({ onObserve = async () => null, onClose = () => {}, onTalk = () => {},
    nativeFullscreen = true, maxSnapshotEdge = 1024, document: doc = root.document } = {}) {
    if (!doc?.body) throw new Error("Drawing board needs a document body");
    const win = doc.defaultView || root;
    const element = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const button = (text, action, className = "") => {
      const node = element("button", `drawing-board__button ${className}`, text);
      node.type = "button"; node.addEventListener("click", action); return node;
    };
    const board = element("section", "drawing-board");
    board.hidden = true; board.setAttribute("role", "dialog");
    board.setAttribute("aria-modal", "true"); board.setAttribute("aria-label", "我的画板");
    // Keep a finger drag inside the drawing overlay instead of scrolling the page.
    board.addEventListener("touchmove", event => {
      if (opened && event.cancelable) event.preventDefault();
    }, { passive: false });
    const header = element("header", "drawing-board__header");
    const back = button("← 返回", () => close(), "drawing-board__back");
    const heading = element("div", "drawing-board__heading");
    heading.append(element("h2", "", "我的画板"), element("p", "", "爸爸老师能看到这张画"));
    const talk = button("和爸爸说话", () => {
      Promise.resolve().then(() => onTalk()).catch(() => {
        voiceStatus.setAttribute("data-state", "error"); voiceStatus.textContent = "声音还没准备好，请再试一次";
      });
    }, "drawing-board__talk");
    talk.setAttribute("aria-pressed", "false");
    const pause = button("暂停观察", () => {
      observation.setEnabled(!observation.enabled);
      feedback.textContent = ""; refreshObservation();
    }, "drawing-board__pause");
    pause.setAttribute("aria-pressed", "false");
    header.append(back, heading, talk, pause);
    const stage = element("div", "drawing-board__stage");
    const canvas = element("canvas", "drawing-board__canvas");
    canvas.setAttribute("aria-label", "白色画纸，用鼠标或手指画画");
    canvas.setAttribute("role", "img");
    stage.append(canvas);
    const footer = element("footer", "drawing-board__footer");
    const tools = element("div", "drawing-board__tools");
    tools.setAttribute("role", "toolbar"); tools.setAttribute("aria-label", "画笔工具");
    const palette = element("div", "drawing-board__palette");
    palette.setAttribute("role", "group"); palette.setAttribute("aria-label", "画笔颜色");
    const colors = [["森林绿", "#245441"], ["红色", "#c53f42"], ["蓝色", "#286ab5"],
      ["黄色", "#e6ae28"], ["紫色", "#8356a6"], ["棕色", "#875634"]];
    let color = colors[0][1], width = 10, erasing = false, hover = false;
    const colorButtons = colors.map(([label, value]) => {
      const control = button("", () => { finishStroke(); color = value; erasing = false; refreshTools(); }, "drawing-board__swatch");
      control.style.setProperty("--drawing-color", value);
      control.setAttribute("aria-label", label); control.title = label;
      palette.append(control); return control;
    });
    const sizes = element("div", "drawing-board__sizes");
    sizes.setAttribute("role", "group"); sizes.setAttribute("aria-label", "画笔粗细");
    const sizeButtons = [["细", 4], ["中", 10], ["粗", 22]].map(([label, value]) => {
      const control = button(label, () => { finishStroke(); width = value; refreshTools(); }, "drawing-board__size");
      control.setAttribute("aria-label", `${label}画笔`); sizes.append(control); return control;
    });
    const eraser = button("橡皮", () => { finishStroke(); erasing = !erasing; refreshTools(); });
    const undo = button("↶ 撤销", () => { finishStroke(); if (operations.length) { operations.pop(); redraw(); changed(); } });
    const clear = button("清空", () => {
      finishStroke(); if (!hasDrawing()) return;
      operations.push({ clear: true }); redraw(); changed();
      status.textContent = "画纸清空了，点撤销还能找回来";
    });
    const advancedTools = element("div", "drawing-board__advanced-tools");
    advancedTools.setAttribute("role", "group"); advancedTools.setAttribute("aria-label", "更多画笔工具");
    advancedTools.append(sizes, eraser, undo, clear);
    const advancedControls = [...sizeButtons, eraser, undo, clear];
    tools.append(palette, advancedTools);
    const lower = element("div", "drawing-board__lower");
    const mode = button("移动就画：关", () => {
      finishStroke(); hover = !hover; mode.setAttribute("aria-pressed", String(hover));
      mode.textContent = `移动就画：${hover ? "开" : "关"}`;
      hint.textContent = hover ? "鼠标移到画纸上，就能画画" : "按住鼠标拖一拖，或用手指画画";
    }, "drawing-board__mode");
    mode.setAttribute("aria-pressed", "false");
    let toolsExpanded = false;
    const toolsToggle = button("画笔工具 ▾", () => {
      finishStroke(); toolsExpanded = !toolsExpanded; refreshToolsLayout(); resize();
    }, "drawing-board__tools-toggle");
    toolsToggle.setAttribute("aria-expanded", "false");
    const hint = element("span", "drawing-board__hint", "按住鼠标拖一拖，或用手指画画");
    const status = element("span", "drawing-board__status");
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const voiceStatus = element("span", "drawing-board__voice", "点和爸爸说话，也能聊你的画");
    voiceStatus.setAttribute("role", "status"); voiceStatus.setAttribute("data-state", "paused");
    lower.append(mode, toolsToggle, hint, status, voiceStatus);
    const feedback = element("p", "drawing-board__feedback");
    feedback.setAttribute("aria-live", "polite");
    footer.append(tools, lower, feedback); board.append(header, stage, footer); doc.body.append(board);

    const operations = [];
    let stroke = null, pointerId = null, revision = 0, opened = false, destroyed = false;
    let focusBefore = null, overflowBefore = "", ownsFullscreen = false;
    let logicalWidth = 1200, logicalHeight = 800, initialized = false;
    const context = canvas.getContext("2d", { alpha: false });
    const observation = new DrawingObservationQueue({ snapshot: getSnapshot, observe: onObserve,
      onResult(result, rev, session) {
        const text = typeof result === "string" ? result : result?.text;
        if (text) setFeedback(text, rev, session);
      },
      onState(state, rev, session) { setObservationState(state, rev, session); },
    });
    function hasDrawing() {
      let ink = false;
      for (const operation of operations) {
        if (operation.clear) ink = false;
        else if (!operation.eraser && operation.points.length) ink = true;
      }
      return ink;
    }
    function refreshTools() {
      colorButtons.forEach((control, index) => control.setAttribute("aria-pressed", String(!erasing && color === colors[index][1])));
      sizeButtons.forEach((control, index) => control.setAttribute("aria-pressed", String(width === [4, 10, 22][index])));
      eraser.setAttribute("aria-pressed", String(erasing));
      undo.disabled = operations.length === 0; clear.disabled = !hasDrawing();
    }
    function refreshToolsLayout() {
      const compact = Boolean(win.matchMedia?.("(max-width: 480px)")?.matches);
      toolsToggle.hidden = !compact;
      advancedTools.hidden = compact && !toolsExpanded;
      toolsToggle.setAttribute("aria-expanded", String(!advancedTools.hidden));
      toolsToggle.textContent = toolsExpanded ? "收起工具 ▴" : "画笔工具 ▾";
      if (opened && advancedTools.hidden && advancedControls.includes(doc.activeElement)) toolsToggle.focus();
      if (opened && toolsToggle.hidden && doc.activeElement === toolsToggle) mode.focus();
    }
    function refreshObservation() {
      pause.setAttribute("aria-pressed", String(!observation.enabled));
      pause.textContent = observation.enabled ? "暂停观察" : "继续观察";
      status.textContent = !observation.enabled ? "已暂停，爸爸老师暂时不看画" :
        !observation.visible ? "画板隐藏时暂停观察" : "你慢慢画，爸爸老师会看你的新笔画";
    }
    function changed() {
      revision++; feedback.textContent = "";
      observation.changed(revision, hasDrawing()); refreshTools();
      if (observation.enabled) status.textContent = "你继续画，爸爸老师一会儿看看新笔画";
    }
    function paint(operation) {
      if (operation.clear) { context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); return; }
      context.strokeStyle = context.fillStyle = operation.eraser ? "#fff" : operation.color;
      context.lineWidth = operation.width; context.lineCap = "round"; context.lineJoin = "round";
      const first = operation.points[0]; if (!first) return;
      if (operation.points.length === 1) {
        context.beginPath(); context.arc(first.x, first.y, operation.width / 2, 0, Math.PI * 2); context.fill();
      } else {
        context.beginPath(); context.moveTo(first.x, first.y);
        for (const point of operation.points.slice(1)) context.lineTo(point.x, point.y);
        context.stroke();
      }
    }
    function redraw() {
      context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
      for (const operation of operations) paint(operation);
    }
    function resize() {
      if (!opened) return;
      refreshToolsLayout();
      const bounds = stage.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      if (!initialized) {
        logicalHeight = Math.round(logicalWidth * bounds.height / bounds.width);
        canvas.width = logicalWidth; canvas.height = logicalHeight;
        initialized = true; redraw();
      }
      const scale = Math.min(bounds.width / logicalWidth, bounds.height / logicalHeight);
      canvas.style.width = `${Math.floor(logicalWidth * scale)}px`;
      canvas.style.height = `${Math.floor(logicalHeight * scale)}px`;
    }
    function pointAt(event) {
      const bounds = canvas.getBoundingClientRect();
      return { x: Math.max(0, Math.min(logicalWidth, (event.clientX - bounds.left) * logicalWidth / bounds.width)),
        y: Math.max(0, Math.min(logicalHeight, (event.clientY - bounds.top) * logicalHeight / bounds.height)) };
    }
    function startStroke(event) {
      if (!opened || doc.hidden) return;
      stroke = { color, width: erasing ? Math.max(28, width * 2.5) : width, eraser: erasing, points: [pointAt(event)] };
      operations.push(stroke); pointerId = event.pointerId; paint(stroke); changed();
    }
    function finishStroke() { stroke = null; pointerId = null; }
    canvas.addEventListener("pointerdown", event => {
      if (event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault(); finishStroke(); startStroke(event);
      try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
    });
    canvas.addEventListener("pointermove", event => {
      if (event.isPrimary === false || !opened || doc.hidden) return;
      if (!stroke && hover && event.pointerType === "mouse") startStroke(event);
      if (!stroke || pointerId !== event.pointerId) return;
      event.preventDefault();
      const coalesced = event.getCoalescedEvents?.();
      for (const sample of coalesced?.length ? coalesced : [event]) {
        const next = pointAt(sample), previous = stroke.points.at(-1);
        if (Math.hypot(next.x - previous.x, next.y - previous.y) < 0.6) continue;
        stroke.points.push(next);
        paint({ ...stroke, points: [previous, next] }); changed();
      }
    });
    const endPointer = event => { if (event.pointerId === pointerId) finishStroke(); };
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("lostpointercapture", endPointer);
    canvas.addEventListener("pointerleave", event => {
      if (!canvas.hasPointerCapture?.(event.pointerId)) endPointer(event);
    });
    function allowed(rev, session) {
      return opened && !doc.hidden && observation.enabled
        && (rev === undefined || rev === revision) && (session === undefined || session === observation.epoch);
    }
    function setFeedback(text, rev, session) {
      if (!allowed(rev, session)) return false;
      feedback.textContent = String(text || "").slice(0, 280); return true;
    }
    function setObservationState(state, rev, session) {
      if (!allowed(rev, session)) return false;
      const messages = { observing: "爸爸老师正在看你的画…", busy: "爸爸老师正在看你的画…", waiting: "先聊一聊，爸爸老师一会儿看画",
        speaking: "听听爸爸老师怎么说", error: "爸爸老师这次没看清，你可以继续画", idle: "爸爸老师能看到这张画" };
      status.textContent = messages[state] || messages.idle; return true;
    }
    function setVoiceState(state) {
      if (!opened) return false;
      const labels = { listening: "爸爸老师在听你说", paused: "点和爸爸说话，也能聊你的画",
        thinking: "爸爸老师在想一想", speaking: "爸爸老师正在说话" };
      voiceStatus.textContent = labels[state] || labels.paused;
      voiceStatus.setAttribute("data-state", labels[state] ? state : "paused");
      talk.textContent = state === "listening" ? "暂停说话" : "和爸爸说话";
      talk.setAttribute("aria-pressed", String(state === "listening")); return true;
    }
    async function getSnapshot() {
      if (!opened || doc.hidden || !initialized || !hasDrawing()) return null;
      const snapshotSession = observation.epoch;
      const edge = Math.max(256, Math.min(1024, Number(maxSnapshotEdge) || 1024));
      const scale = Math.min(1, edge / Math.max(canvas.width, canvas.height));
      const snapshot = doc.createElement("canvas");
      snapshot.width = Math.max(1, Math.round(canvas.width * scale));
      snapshot.height = Math.max(1, Math.round(canvas.height * scale));
      const target = snapshot.getContext("2d", { alpha: false });
      target.fillStyle = "#fff"; target.fillRect(0, 0, snapshot.width, snapshot.height);
      target.drawImage(canvas, 0, 0, snapshot.width, snapshot.height);
      const pixels = target.getImageData(0, 0, snapshot.width, snapshot.height).data;
      let ink = false;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 250 || pixels[index + 1] < 250 || pixels[index + 2] < 250) { ink = true; break; }
      }
      if (!ink) return null;
      return new Promise(resolve => snapshot.toBlob(blob => {
        resolve(opened && !doc.hidden && snapshotSession === observation.epoch ? blob : null);
      }, "image/png"));
    }
    function open() {
      if (destroyed || opened) return api;
      opened = true; toolsExpanded = false; focusBefore = doc.activeElement; overflowBefore = doc.body.style.overflow;
      doc.body.style.overflow = "hidden"; board.hidden = false;
      observation.setEnabled(true); observation.setVisible(!doc.hidden); observation.setActive(true);
      refreshObservation(); refreshTools(); resize(); back.focus({ preventScroll: true });
      // A touch device already has a full-viewport overlay. Native fullscreen
      // can be dismissed by a downward system gesture, which must not end art.
      const touchDevice = Number(win.navigator?.maxTouchPoints || 0) > 0
        || Boolean(win.matchMedia?.("(pointer: coarse)")?.matches);
      if (nativeFullscreen && !touchDevice && board.requestFullscreen && !doc.fullscreenElement) {
        try {
          Promise.resolve(board.requestFullscreen()).then(() => {
            ownsFullscreen = doc.fullscreenElement === board;
            if (!opened && ownsFullscreen) void doc.exitFullscreen?.().catch(() => {});
            else resize();
          }).catch(() => {});
        } catch (_) { /* The full-viewport overlay also works without native fullscreen. */ }
      }
      return api;
    }
    function close() {
      if (!opened) return;
      finishStroke(); opened = false; observation.setActive(false); feedback.textContent = "";
      board.hidden = true; doc.body.style.overflow = overflowBefore;
      if (doc.fullscreenElement === board) {
        try { Promise.resolve(doc.exitFullscreen()).catch(() => {}); } catch (_) {}
      }
      ownsFullscreen = false;
      if (focusBefore?.isConnected) focusBefore.focus({ preventScroll: true });
      onClose();
    }
    const keydown = event => {
      if (!opened) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === "Tab") {
        const controls = [...board.querySelectorAll("button")].filter(control => !control.disabled && !control.hidden
          && (!advancedTools.hidden || !advancedControls.includes(control)));
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const visibility = () => {
      finishStroke(); observation.setVisible(!doc.hidden); feedback.textContent = ""; refreshObservation();
    };
    const fullscreen = () => {
      // Esc or a browser gesture may end native fullscreen. The fixed overlay
      // remains the drawing surface until the child presses Return.
      if (ownsFullscreen && doc.fullscreenElement !== board) ownsFullscreen = false;
      resize();
    };
    doc.addEventListener("keydown", keydown, true);
    doc.addEventListener("visibilitychange", visibility);
    doc.addEventListener("fullscreenchange", fullscreen);
    win.addEventListener("resize", resize);
    const resizeObserver = win.ResizeObserver ? new win.ResizeObserver(resize) : null;
    resizeObserver?.observe(stage);
    const api = { open, close, getSnapshot, setFeedback, setObservationState, setVoiceState,
      get isOpen() { return opened; }, get revision() { return revision; }, get sessionId() { return observation.epoch; },
      destroy() {
        close(); destroyed = true; observation.invalidate(); resizeObserver?.disconnect();
        doc.removeEventListener("keydown", keydown, true); doc.removeEventListener("visibilitychange", visibility);
        doc.removeEventListener("fullscreenchange", fullscreen); win.removeEventListener("resize", resize); board.remove();
      },
    };
    refreshTools(); refreshToolsLayout(); return api;
  }
  root.createDrawingBoard = createDrawingBoard;
  if (typeof module !== "undefined" && module.exports) module.exports = { createDrawingBoard, DrawingObservationQueue };
})(globalThis);
