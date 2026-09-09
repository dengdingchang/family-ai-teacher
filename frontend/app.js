import "/pcm-player.js?v=20260907-playback-clock";
import "/voice-activity.js?v=20260906-2";
import "/interaction-clock.js?v=20260906-1";
import "/drawing-board.js?v=20260906-3";
import { CallView } from "/call-view.js?v=20260909-inline-pip";
import { MusicStudio } from "/music-studio.js?v=20260909-1";
import { MediaViewer } from "/media-viewer.js?v=20260909-1";

const statusText = document.querySelector("#statusText");
const serviceBadge = document.querySelector("#serviceBadge");
const recordButton = document.querySelector("#recordButton");
const recordLabel = document.querySelector("#recordLabel");
const recordHint = document.querySelector("#recordHint");
const chatHistory = document.querySelector("#chatHistory");
const chatEmpty = document.querySelector("#chatEmpty");
const liveTurn = document.querySelector("#liveTurn");
const userTextBox = document.querySelector("#userTextBox");
const answerBox = document.querySelector("#answerBox");
const textForm = document.querySelector("#textForm");
const textInput = document.querySelector("#textInput");
const dot = document.querySelector(".dot");
const avatarImage = document.querySelector("#avatarImage");
const avatarIdle = document.querySelector("#avatarIdle");
const avatarCanvas = document.querySelector("#avatarCanvas");
const avatarStateText = document.querySelector("#avatarStateText");
const avatarStage = document.querySelector("#avatarStage");
const activityButtons = [...document.querySelectorAll(".activity-chip")];
const childWelcome = document.querySelector("#childWelcome");
const conversationTitle = document.querySelector("#conversationTitle");
const playButton = document.querySelector("#playButton");
const playChoices = document.querySelector("#playChoices");
const defaultEnabledActivities = ["drawing", "story", "game", "music", "vision_photo", "vision_video"];
let enabledActivities = new Set(defaultEnabledActivities);
let childProfileLoaded = false;
let mediaConversationWasActive = false;
let mediaPlaybackGeneration = 0;
let mediaResumePending = false;
let mediaSuggestionRequestController = null;
let mediaSuggestionGeneration = 0;
let mediaSuggestionJobStatusUrl = "";
let pageIsLeaving = false;

async function resumeConversationAfterMedia(generation) {
  const until = performance.now() + 1800;
  while (activeRequestController && performance.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (generation !== mediaPlaybackGeneration || !mediaResumePending) return;
  mediaResumePending = false;
  if (conversationActive && !conversationStarting && !activeRequestController
      && !segmentRecording && mediaViewer.openKind !== "video") beginContinuousSegment();
}

const mediaViewer = new MediaViewer({
  container: document.createElement("div"),
  onOpen(kind) {
    if (kind !== "video") return;
    mediaPlaybackGeneration += 1;
    mediaResumePending = false;
    mediaConversationWasActive = conversationActive;
    if (activeRequestController) {
      interruptedRequestController = activeRequestController;
      void cancelConversationTurn(activeTurnId);
      activeRequestController.abort();
    }
    stopVadLoop();
    stopBargeInMonitor();
    segmentRecording = false;
    segmentShouldSend = false;
    segmentPcmChunks = [];
    clearResponseQueue();
    cancelPlayback();
  },
  onClose(kind) {
    if (kind === "video" && mediaConversationWasActive && !pageIsLeaving) {
      mediaResumePending = true;
      void resumeConversationAfterMedia(mediaPlaybackGeneration);
    }
    mediaConversationWasActive = false;
  },
});
const mediaSuggestionGroups = [];
if (avatarStage) new CallView(avatarStage.closest(".stage-card"));

let recordingStream = null;
let audioContext = null;
let activeAudio = null;
let activeAudioUrl = null;
let audioQueue = [];
let queueDraining = false;
let queueGeneration = 0;
let queueDrainWaiters = [];
let queuePlaybackError = null;
let activePlayback = null;
let streamingPlayback = null;
let streamingAudioContext = null;
let avatarSocket = null;
let avatarReady = false;
let avatarReconnectTimer = null;
let avatarReconnectDelayMs = 1200;
let avatarDrawing = false;
let avatarDecoder = null;
let avatarEncodedQueue = [];
let avatarPumpTimer = null;
let avatarNeedsKeyframe = true;
let avatarAcceptFrames = false;
let avatarAwaitingStreamStart = false;
let avatarFrameGeneration = 0;
let avatarAudioLeadMs = 900;
let avatarFrameSerial = 0;
let avatarFrameWaiters = [];
let avatarIdleReady = false;
let avatarIdleFailed = false;
let avatarIdleConfigured = false;
const avatarReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let inputSource = null;
let inputAnalyser = null;
let inputProcessor = null;
let inputMuteGain = null;
let inputSampleRate = 48000;
let segmentPcmChunks = [];
let segmentRecording = false;
let vadTimer = null;
let conversationActive = false;
let conversationStarting = false;
let speechStartedAt = 0;
let lastVoiceAt = 0;
let loudSince = 0;
let segmentShouldSend = false;
let activeRequestController = null;
let activeRequestSource = "";
let drawingBoard = null;
let chessBoard = null;
let musicStudio = null;
let musicSpeechController = null;
let musicConversationWasActive = false;
let chessSpeechController = null;
let chessSpeechGeneration = 0;
let chessOpenGeneration = 0;
let interruptedRequestController = null;
let activeTurnId = null;
let bargeInTimer = null;
let bargeInMonitoring = false;
let bargeInPcmChunks = [];

const VAD_INTERVAL_MS = 40;
const VAD_START_RMS = 0.045;
const VAD_STOP_RMS = 0.028;
const VAD_START_HOLD_MS = 80;
const VAD_SILENCE_MS = 1200;
const VAD_MAX_SEGMENT_MS = 12000;
const BARGE_IN_START_RMS = 0.075;
const BARGE_IN_HOLD_MS = 240;
const BARGE_IN_INTERVAL_MS = 40;
const PCM_PREROLL_SECONDS = 1;
// A measured relay path adds about 0.5 s round-trip latency. Keep this wait
// bounded, while allowing its first decodable video packet to arrive.
const STREAM_AVATAR_FIRST_FRAME_WAIT_MS = 2000;
const bargeInGate = new globalThis.BargeInGate({
  threshold: BARGE_IN_START_RMS,
  voicedMs: BARGE_IN_HOLD_MS,
  sampleMs: BARGE_IN_INTERVAL_MS,
});

let historyRecords = [];

function scrollHistoryToLatest() {
  if (!chatHistory) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chatHistory.scrollTop = chatHistory.scrollHeight;
    });
  });
}

function historyMessage(className, speaker, text) {
  const message = document.createElement("div");
  message.className = `chat-message ${className}`;
  const label = document.createElement("span");
  label.className = "chat-speaker";
  label.textContent = speaker;
  const content = document.createElement("p");
  content.textContent = text || "（没有文字）";
  message.append(label, content);
  return message;
}

function formatHistoryTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildMediaHistoryTurn(group) {
  const turn = document.createElement("article");
  turn.className = "history-turn media-history-turn";
  const message = document.createElement("div");
  message.className = "chat-message dad-message media-history-message";
  const label = document.createElement("span");
  label.className = "chat-speaker";
  label.textContent = "爸爸老师";
  const heading = document.createElement("p");
  heading.className = "media-history-heading";
  heading.textContent = group.message || "找到可以一起看的图片和视频";
  const cards = document.createElement("div");
  cards.className = "media-history-cards";
  message.append(label, heading);
  if (group.cards.length) message.append(cards);
  turn.append(message);
  if (group.cards.length) {
    mediaViewer.container = cards;
    mediaViewer.appendCards(group.cards);
  }
  return turn;
}

function cancelMediaSuggestionLookup() {
  mediaSuggestionGeneration += 1;
  const controller = mediaSuggestionRequestController;
  mediaSuggestionRequestController = null;
  controller?.abort();
  const statusUrl = mediaSuggestionJobStatusUrl;
  mediaSuggestionJobStatusUrl = "";
  if (/^\/api\/image-generation\/jobs\/[0-9a-f]{32}$/.test(statusUrl)) {
    fetch(`${statusUrl}/cancel`, { method: "POST", keepalive: true }).catch(() => {});
  }
  mediaViewer?.close({ restoreFocus: false });
}

function waitForMediaPoll(delayMs, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener?.("abort", cancelled);
      resolve(true);
    }, delayMs);
    const cancelled = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener?.("abort", cancelled, { once: true });
  });
}

async function pollGeneratedMedia(job, topic, group, controller, generation) {
  const statusUrl = String(job?.status_url || "");
  if (!/^\/api\/image-generation\/jobs\/[0-9a-f]{32}$/.test(statusUrl)) return;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (!await waitForMediaPoll(2000, controller.signal)) return;
    if (controller.signal.aborted || generation !== mediaSuggestionGeneration) return;
    const response = await fetch(statusUrl, { signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || String(result.topic || "") !== topic) return;
    if (result.status === "failed") {
      if (mediaSuggestionJobStatusUrl === statusUrl) mediaSuggestionJobStatusUrl = "";
      if (!group.cards.length && generation === mediaSuggestionGeneration) {
        group.message = `这次没有画好${topic}，我们先继续聊。`;
        renderHistory();
      }
      return;
    }
    if (result.status === "cancelled") {
      if (mediaSuggestionJobStatusUrl === statusUrl) mediaSuggestionJobStatusUrl = "";
      return;
    }
    if (result.status !== "completed" || !result.card) continue;
    if (controller.signal.aborted || generation !== mediaSuggestionGeneration) return;
    const imageUrl = String(result.card.thumbnail_url || "");
    if (!group.cards.some(card => String(card.thumbnail_url || "") === imageUrl)) {
      group.cards.unshift(result.card);
    }
    group.message = "";
    if (mediaSuggestionJobStatusUrl === statusUrl) mediaSuggestionJobStatusUrl = "";
    renderHistory();
    if (!document.hidden && generation === mediaSuggestionGeneration) {
      mediaViewer.openImage(result.card);
    }
    return;
  }
}

async function loadMediaSuggestions(childText, assistantText = "") {
  cancelMediaSuggestionLookup();
  const generation = mediaSuggestionGeneration;
  const childRequest = String(childText || "").replace(/\s+/g, "");
  const teacherReply = String(assistantText || "").replace(/\s+/g, "");
  const text = `${childRequest}${teacherReply}`;
  const topics = [
    ["刷牙", ["刷牙", "牙刷", "牙齿", "牙齒"]], ["恐龙", ["恐龙", "恐龍", "霸王龙", "暴龍"]],
    ["月亮", ["月亮", "月球"]], ["太空", ["太空", "宇宙", "星球"]], ["鱼", ["鱼", "魚"]],
    ["钢琴", ["钢琴", "鋼琴", "琴键", "琴鍵"]], ["红绿灯", ["红绿灯", "紅綠燈", "交通灯", "交通燈"]],
  ];
  const educationTopics = [
    "蝴蝶", "蜜蜂", "熊猫", "长颈鹿", "大象", "海豚", "鲸鱼", "鲨鱼", "企鹅", "乌龟",
    "青蛙", "狮子", "老虎", "斑马", "袋鼠", "猫头鹰", "孔雀", "蜗牛", "蚂蚁", "瓢虫",
    "彩虹", "火山", "地震", "云朵", "闪电", "雪花", "太阳", "地球", "星星", "海洋",
    "森林", "沙漠", "河流", "瀑布", "山峰", "春天", "夏天", "秋天", "冬天", "太阳系",
    "木星", "火星", "土星", "火车", "飞机", "轮船", "汽车", "自行车", "直升机", "火箭",
    "小提琴", "吉他", "架子鼓", "长笛", "向日葵", "蒲公英", "苹果树", "水循环", "磁铁",
  ];
  const topic = topics.find(([, aliases]) => aliases.some(alias => text.includes(alias)))?.[0]
    || educationTopics.find(candidate => text.includes(candidate)) || "";
  if (!topic) return;
  const childAskedForDrawing = /(画一张|画一个|画幅|画出|生成一张|做一张|给我(?:画|生成|做|看)(?:一张|一个)?(?:图片|图画|插图|照片)|我要(?:一张|一个)?(?:图片|图画|插图|照片)|我想要(?:一张|一个)?(?:图片|图画|插图|照片))/.test(childRequest);
  const teacherWillDraw = /(?:我|爸爸老师)(?:现在|马上|来|可以|给你|为你){0,4}(?:画|生成|做)(?:一张|一个|幅)?[^。！？]{0,16}(?:图|图片|图画|插图|照片)/.test(teacherReply);
  const teacherWillShow = /(给你看|一起看|来看看|我们看看|我们看一看|看看|看一看)[^。！？]{0,16}/.test(teacherReply);
  const generateImage = childAskedForDrawing || teacherWillDraw || teacherWillShow;
  const imageJobId = generateImage && typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replaceAll("-", "").toLowerCase() : "";
  if (generateImage && !/^[0-9a-f]{32}$/.test(imageJobId)) return;
  if (imageJobId) mediaSuggestionJobStatusUrl = `/api/image-generation/jobs/${imageJobId}`;
  const controller = new AbortController();
  mediaSuggestionRequestController = controller;
  try {
    const response = await fetch("/api/media/suggestions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, generate_image: generateImage, image_job_id: imageJobId }),
      signal: controller.signal,
    });
    if (controller.signal.aborted || generation !== mediaSuggestionGeneration) return;
    const payload = await response.json().catch(() => ({}));
    if (controller.signal.aborted || generation !== mediaSuggestionGeneration) return;
    const returnedTopic = String(payload.topic || "");
    if (!response.ok || returnedTopic !== topic || !Array.isArray(payload.cards)) return;
    const drawing = ["queued", "running"].includes(payload.image_generation);
    const message = payload.cards.length ? "" : drawing ? `正在画${topic}，先继续聊。`
      : payload.image_generation === "busy" ? "图片任务有点忙，我们先继续聊。"
      : payload.image_generation === "failed" ? `这次没有画好${topic}，我们先继续聊。`
      : payload.reason === "source_unavailable"
      ? `这次暂时连不上${topic}图片，我们先继续聊。`
      : `这次没有找到合适的${topic}图片，我们先继续聊。`;
    let group = mediaSuggestionGroups.find(item => item.topic === returnedTopic);
    if (!group) {
      group = { topic: returnedTopic, cards: payload.cards, message };
      mediaSuggestionGroups.push(group);
    } else {
      const existing = new Set(group.cards.map(card => String(card.thumbnail_url || "")));
      group.cards.push(...payload.cards.filter(card => !existing.has(String(card.thumbnail_url || ""))));
      group.message = message;
    }
    renderHistory();
    const completedGeneratedCard = payload.image_generation === "completed"
      ? payload.cards.find(card => card?.generated === true) : null;
    if (completedGeneratedCard && !document.hidden && generation === mediaSuggestionGeneration) {
      mediaSuggestionJobStatusUrl = "";
      mediaViewer.openImage(completedGeneratedCard);
    }
    if (drawing) {
      mediaSuggestionJobStatusUrl = String(payload.image_generation_job?.status_url || "");
      await pollGeneratedMedia(payload.image_generation_job, topic, group, controller, generation);
    } else if (mediaSuggestionJobStatusUrl.endsWith(imageJobId)) {
      mediaSuggestionJobStatusUrl = "";
    }
  } catch (_) {
    // Learning cards are optional; voice and local activities stay available.
    const statusUrl = mediaSuggestionJobStatusUrl;
    if (/^\/api\/image-generation\/jobs\/[0-9a-f]{32}$/.test(statusUrl)) {
      fetch(`${statusUrl}/cancel`, { method: "POST", keepalive: true }).catch(() => {});
      mediaSuggestionJobStatusUrl = "";
    }
  } finally {
    if (mediaSuggestionRequestController === controller) mediaSuggestionRequestController = null;
  }
}

function renderHistory() {
  if (!chatHistory) return;
  chatHistory.replaceChildren();
  const visibleRecords = historyRecords.filter((record) => (
    String(record?.user_text || "").trim() || String(record?.assistant_text || "").trim()
  ));
  if (!visibleRecords.length && !mediaSuggestionGroups.length) {
    chatEmpty.hidden = false;
    chatEmpty.textContent = "还没有对话，先和爸爸老师说一句吧。";
    chatHistory.append(chatEmpty);
  } else {
    chatEmpty.hidden = true;
    for (const record of visibleRecords) {
      const turn = document.createElement("article");
      turn.className = "history-turn";
      const timestamp = formatHistoryTime(record.created_at);
      if (timestamp) {
        const time = document.createElement("time");
        time.className = "history-time";
        time.dateTime = record.created_at;
        time.textContent = timestamp;
        turn.append(time);
      }
      turn.append(
        historyMessage("child-message", "我", String(record.user_text || "").trim()),
        historyMessage("dad-message", "爸爸老师", String(record.assistant_text || "").trim()),
      );
      chatHistory.append(turn);
    }
    for (const group of mediaSuggestionGroups) chatHistory.append(buildMediaHistoryTurn(group));
  }
  // The current turn is part of this same scrolling log, never a second feed.
  chatHistory.append(liveTurn);
  scrollHistoryToLatest();
}

let historyResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(historyResizeTimer);
  historyResizeTimer = setTimeout(scrollHistoryToLatest, 100);
});

function appendHistoryRecord(record) {
  if (!record || typeof record !== "object") return;
  const createdAt = String(record.created_at || "");
  if (createdAt && historyRecords.some((item) => String(item?.created_at || "") === createdAt)) return;
  historyRecords.push(record);
  renderHistory();
}

async function loadHistory() {
  try {
    const response = await fetch("/api/memory/history");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.history)) throw new Error("历史记录暂时无法加载");
    historyRecords = payload.history.filter((record) => record && typeof record === "object");
    renderHistory();
  } catch (_) {
    chatEmpty.hidden = false;
    chatEmpty.textContent = "历史记录暂时无法加载，新的对话仍可继续。";
    chatHistory?.replaceChildren(chatEmpty);
  }
}

function resetLiveTurn() {
  if (!liveTurn.parentElement || liveTurn.parentElement !== chatHistory) chatHistory.append(liveTurn);
  liveTurn.hidden = false;
  userTextBox.textContent = "正在听你说…";
  answerBox.classList.remove("has-answer");
  answerBox.innerHTML = '<span class="answer-label">正在想一个好玩的教法…</span>';
  scrollHistoryToLatest();
}

function hideLiveTurn() {
  liveTurn.hidden = true;
  scrollHistoryToLatest();
}

function setStatus(message, state = "idle") {
  statusText.textContent = message;
  const visualState = ["idle", "listening", "thinking", "speaking", "offline"].includes(state) ? state : "idle";
  if (avatarStage) avatarStage.dataset.state = visualState;
  if (visualState !== "listening") resetListeningLevel();
  dot.classList.toggle("live", visualState !== "offline");
  syncAvatarIdle(visualState);
  if (typeof drawingBoard !== "undefined" && drawingBoard?.isOpen) {
    drawingBoard.setVoiceState(["listening", "thinking", "speaking"].includes(visualState) ? visualState : "paused");
  }
}

window.addEventListener("family-audio-playback", (event) => {
  const detail = event.detail || {};
  if (Number.isInteger(detail.generation) && detail.generation !== queueGeneration) return;
  if (detail.type === "scheduled") {
    setStatus(avatarReady ? "爸爸老师正在说话…" : "爸爸老师正在说话 · 动作暂时离线", "speaking");
  } else if (detail.type === "cancelled" && avatarStage?.dataset.state === "speaking") {
    setStatus("爸爸老师暂停了", "idle");
  }
});

function resetListeningLevel() {
  avatarStage?.style?.removeProperty("--listening-level");
}

function updateListeningLevel(rms) {
  if (avatarStage?.dataset.state !== "listening" || avatarReducedMotion.matches) {
    resetListeningLevel();
    return;
  }
  // Visual loudness only: this does not change VAD or recognition confidence.
  const level = Number.isFinite(rms) ? Math.max(0, Math.min(1, (rms - 0.015) / 0.135)) : 0;
  if (level === 0) resetListeningLevel();
  else avatarStage.style.setProperty("--listening-level", level.toFixed(3));
}

function syncAvatarIdle(state = avatarStage?.dataset.state || "idle") {
  if (!avatarIdle || !avatarImage || !avatarCanvas) return;
  // Text can keep arriving while speech is playing. Keep its accepted canvas
  // visible until the turn ends or flush revokes those frames.
  const live = avatarAcceptFrames && !avatarCanvas.hidden
    && ["speaking", "thinking"].includes(state);
  if (!live) avatarCanvas.hidden = true;
  const idle = !live && state !== "speaking" && avatarIdleReady && !avatarIdleFailed;
  avatarIdle.hidden = !idle;
  avatarImage.hidden = live || idle;
  if (!idle || document.hidden || avatarReducedMotion.matches) {
    avatarIdle.pause();
    if (idle && avatarReducedMotion.matches && avatarIdle.currentTime !== 0) avatarIdle.currentTime = 0;
    return;
  }
  if (avatarIdle.paused) {
    avatarIdle.play()?.catch((error) => {
      // A normal pause during handoff can abort an outstanding play promise.
      if (error.name === "AbortError") return;
      avatarIdleFailed = true;
      syncAvatarIdle();
    });
  }
}

function initializeAvatarIdle() {
  if (!avatarIdle) return;
  avatarIdle.muted = true;
  avatarIdle.addEventListener("loadeddata", () => {
    if (!avatarIdleConfigured) return;
    avatarIdleReady = true;
    syncAvatarIdle();
  });
  avatarIdle.addEventListener("error", () => {
    avatarIdleFailed = true;
    syncAvatarIdle();
  });
  avatarReducedMotion.addEventListener("change", () => {
    resetListeningLevel();
    syncAvatarIdle();
  });
  document.addEventListener("visibilitychange", () => syncAvatarIdle());
  window.addEventListener("pagehide", () => avatarIdle.pause());
  if (avatarIdle.readyState >= 2) avatarIdleReady = true;
  if (avatarIdle.error) avatarIdleFailed = true;
  syncAvatarIdle();
}

function setAvatarIdleAvailable(available) {
  if (!avatarIdle || avatarIdleConfigured === available) return;
  avatarIdleConfigured = available;
  avatarIdleReady = false;
  avatarIdleFailed = false;
  if (available) {
    avatarIdle.src = "/api/avatar/idle";
  } else {
    avatarIdle.pause();
    avatarIdle.removeAttribute("src");
  }
  avatarIdle.load();
  syncAvatarIdle();
}

function setBusy(busy) {
  recordButton.disabled = busy && !conversationActive;
  textForm.querySelector("button").disabled = busy;
  textInput.disabled = busy;
  for (const button of activityButtons) button.disabled = busy;
}

function activityEnabled(name) {
  return enabledActivities.has(name);
}

function setAvatarState(message) {
  if (avatarStateText) avatarStateText.textContent = message;
}

function markAvatarFrame() {
  if (avatarStateText && !avatarCanvas.hidden
      && avatarStateText.textContent !== "准备好啦，可以一起说话") {
    setAvatarState("准备好啦，可以一起说话");
  }
  avatarFrameSerial += 1;
  const pending = [];
  for (const waiter of avatarFrameWaiters) {
    if (avatarFrameSerial > waiter.afterSerial) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    } else {
      pending.push(waiter);
    }
  }
  avatarFrameWaiters = pending;
}

function waitForAvatarFrame(afterSerial, timeoutMs = 1500) {
  if (avatarFrameSerial > afterSerial) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiter = { afterSerial, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      avatarFrameWaiters = avatarFrameWaiters.filter((item) => item !== waiter);
      resolve(false);
    }, timeoutMs);
    avatarFrameWaiters.push(waiter);
  });
}

function cancelAvatarFrameWaiters() {
  const waiters = avatarFrameWaiters;
  avatarFrameWaiters = [];
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(false);
  }
}

function avatarWebSocketUrl() {
  const url = new URL("/ws/avatar", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function drawAvatarFrame(blob, generation = avatarFrameGeneration) {
  if (!avatarCanvas || !avatarImage || !avatarAcceptFrames || generation !== avatarFrameGeneration) return;
  if (avatarDrawing) return;
  avatarDrawing = true;
  try {
    const context = avatarCanvas.getContext("2d", { alpha: false });
    if (window.createImageBitmap) {
      const bitmap = await createImageBitmap(blob);
      try {
        if (!avatarAcceptFrames || generation !== avatarFrameGeneration) return;
        context.drawImage(bitmap, 0, 0, avatarCanvas.width, avatarCanvas.height);
      } finally {
        bitmap.close();
      }
    } else {
      const url = URL.createObjectURL(blob);
      try {
        const frame = new Image();
        frame.src = url;
        await frame.decode();
        if (!avatarAcceptFrames || generation !== avatarFrameGeneration) return;
        context.drawImage(frame, 0, 0, avatarCanvas.width, avatarCanvas.height);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    avatarCanvas.hidden = false;
    avatarImage.hidden = true;
    syncAvatarIdle();
    markAvatarFrame();
  } catch (_) {
    // Keep the last good frame or photographic fallback when one JPEG is bad.
  } finally {
    avatarDrawing = false;
  }
}

function showDecodedAvatarFrame(frame) {
  if (!avatarCanvas || !avatarImage || !avatarAcceptFrames) {
    frame.close();
    return;
  }
  try {
    const context = avatarCanvas.getContext("2d", { alpha: false });
    context.drawImage(frame, 0, 0, avatarCanvas.width, avatarCanvas.height);
    avatarCanvas.hidden = false;
    avatarImage.hidden = true;
    syncAvatarIdle();
    markAvatarFrame();
  } finally {
    frame.close();
  }
}

function ensureAvatarDecoder() {
  if (avatarDecoder?.state === "configured") return true;
  if (!window.VideoDecoder || !window.EncodedVideoChunk) {
    setAvatarState("浏览器不支持动作，声音仍可用");
    return false;
  }
  avatarNeedsKeyframe = true;
  if (!avatarDecoder || avatarDecoder.state === "closed") avatarDecoder = new VideoDecoder({
    output: showDecodedAvatarFrame,
    error: () => {
      avatarNeedsKeyframe = true;
      setAvatarState("爸爸老师正在跟上声音");
    },
  });
  avatarDecoder.configure({
    codec: "avc1.42E01E",
    codedWidth: 512,
    codedHeight: 512,
    hardwareAcceleration: "prefer-hardware",
    optimizeForLatency: true,
  });
  return true;
}

function pumpAvatarVideo() {
  avatarPumpTimer = null;
  if (!avatarEncodedQueue.length || !ensureAvatarDecoder()) return;
  const session = typeof streamingPlayback !== "undefined" ? streamingPlayback : null;
  const position = session?.generation === (typeof queueGeneration !== "undefined" ? queueGeneration : -1)
    ? session.player.playbackPositionSeconds?.() : null;
  const clocked = Number.isFinite(position);
  // Do not add another real-time queue behind a network burst. Decode late
  // dependencies promptly, but hold frames that would run ahead of the voice.
  if (clocked && avatarEncodedQueue[0].timestamp / 1000000 > position + 0.04) {
    avatarPumpTimer = setTimeout(pumpAvatarVideo, 20);
    return;
  }
  const next = avatarEncodedQueue.shift();
  if (avatarNeedsKeyframe && !next.key) {
    avatarPumpTimer = setTimeout(pumpAvatarVideo, 0);
    return;
  }
  try {
    avatarDecoder.decode(new EncodedVideoChunk({
      type: next.key ? "key" : "delta",
      timestamp: next.timestamp,
      data: next.data,
    }));
    avatarNeedsKeyframe = false;
  } catch (_) {
    avatarNeedsKeyframe = true;
  }
  avatarPumpTimer = setTimeout(pumpAvatarVideo, clocked ? 0 : 40);
}

function queueEncodedAvatarFrame(frame) {
  if (!avatarAcceptFrames) return;
  // Streaming flush resets the remote encoder to timestamp zero. A periodic
  // keyframe still in transit belongs to the previous reply, not this one.
  if (avatarAwaitingStreamStart) {
    if (!frame.key || frame.timestamp !== 0) return;
    avatarAwaitingStreamStart = false;
  }
  avatarEncodedQueue.push(frame);
  if (avatarEncodedQueue.length > 50) {
    const latestKeyframe = avatarEncodedQueue.findLastIndex((item) => item.key);
    avatarEncodedQueue = latestKeyframe > 0
      ? avatarEncodedQueue.slice(latestKeyframe)
      : avatarEncodedQueue.slice(-25);
    avatarNeedsKeyframe = true;
  }
  if (!avatarPumpTimer) pumpAvatarVideo();
}

async function receiveAvatarBinary(blob) {
  if (!avatarAcceptFrames) return;
  const generation = avatarFrameGeneration;
  const buffer = await blob.arrayBuffer();
  if (!avatarAcceptFrames || generation !== avatarFrameGeneration) return;
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const h264 = bytes.length >= 6
    && bytes[0] === 70 && bytes[1] === 65 && bytes[2] === 84
    && bytes[3] === 86 && bytes[4] === 49;
  if (!h264) {
    await drawAvatarFrame(blob, generation);
    return;
  }
  let offset = 6;
  const count = view.getUint8(5);
  for (let index = 0; index < count; index += 1) {
    if (offset + 13 > buffer.byteLength) return;
    const key = view.getUint8(offset) === 1;
    const timestamp = Number(view.getBigUint64(offset + 1, false));
    const length = view.getUint32(offset + 9, false);
    offset += 13;
    if (offset + length > buffer.byteLength) return;
    const data = new Uint8Array(buffer.slice(offset, offset + length));
    offset += length;
    queueEncodedAvatarFrame({ key, timestamp, data });
  }
}

function scheduleAvatarReconnect() {
  if (avatarReconnectTimer) return;
  avatarReconnectTimer = setTimeout(() => {
    avatarReconnectTimer = null;
    connectAvatar();
  }, avatarReconnectDelayMs);
  avatarReconnectDelayMs = Math.min(10000, Math.round(avatarReconnectDelayMs * 1.7));
}

function connectAvatar() {
  if (avatarSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(avatarSocket.readyState)) return;
  setAvatarState("爸爸老师正在准备");
  const socket = new WebSocket(avatarWebSocketUrl());
  avatarSocket = socket;
  socket.binaryType = "blob";
  socket.addEventListener("message", (event) => {
    if (avatarSocket !== socket) return;
    if (event.data instanceof Blob) {
      void receiveAvatarBinary(event.data);
      return;
    }
    try {
      const payload = JSON.parse(String(event.data));
      if (payload.type === "ready") {
        avatarReady = true;
        socket.supportsAudioStream = payload.audio_stream_protocol === true;
        avatarReconnectDelayMs = 1200;
        setAvatarState("准备好啦，可以一起说话");
      } else if (payload.type === "error") {
        avatarReady = false;
        avatarAcceptFrames = false;
        cancelAvatarFrameWaiters();
        // Reuse the close handler's decoder cleanup and bounded reconnect.
        // An open socket is not proof that the renderer can produce frames.
        socket.close();
        setAvatarState("动作暂时离线，声音仍可用");
      }
    } catch (_) {
      // Ignore unknown diagnostic messages from the renderer.
    }
  });
  socket.addEventListener("close", () => {
    if (avatarSocket !== socket) return;
    avatarSocket = null;
    avatarFrameGeneration++;
    avatarReady = false;
    avatarAcceptFrames = false;
    avatarEncodedQueue = [];
    avatarNeedsKeyframe = true;
    if (avatarPumpTimer) clearTimeout(avatarPumpTimer);
    avatarPumpTimer = null;
    if (avatarDecoder?.state === "configured") avatarDecoder.reset();
    cancelAvatarFrameWaiters();
    syncAvatarIdle();
    setAvatarState("动作暂时离线，声音仍可用");
    scheduleAvatarReconnect();
  });
  socket.addEventListener("error", () => socket.close());
}

function sendAvatarEvent(payload) {
  if (!avatarReady || avatarSocket?.readyState !== WebSocket.OPEN) return false;
  try {
    avatarSocket.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

function flushAvatar() {
  avatarFrameGeneration++;
  avatarAcceptFrames = false;
  avatarAwaitingStreamStart = false;
  avatarEncodedQueue = [];
  avatarNeedsKeyframe = true;
  if (avatarPumpTimer) clearTimeout(avatarPumpTimer);
  avatarPumpTimer = null;
  if (avatarDecoder?.state === "configured") avatarDecoder.reset();
  avatarCanvas.hidden = true;
  syncAvatarIdle("idle");
  sendAvatarEvent({ type: "flush" });
}

function cueAvatar(payload) {
  if (!avatarReady || avatarSocket?.readyState !== WebSocket.OPEN) {
    avatarAcceptFrames = false;
    return 0;
  }
  if (payload?.avatar_cued) {
    avatarAcceptFrames = true;
    const remoteLead = Number(payload.avatar_audio_lead_ms);
    return Number.isFinite(remoteLead)
      ? Math.max(0, Math.min(1500, remoteLead))
      : avatarAudioLeadMs;
  }
  if (!payload?.avatar_pcm_base64) return 0;
  const isFirstChunk = Number(payload.sequence || 1) === 1;
  if (isFirstChunk) flushAvatar();
  avatarAcceptFrames = true;
  if (isFirstChunk && payload.audio_stream && avatarSocket.supportsAudioStream) {
    avatarAwaitingStreamStart = true;
    sendAvatarEvent({ type: "audio_begin" });
  }
  const sent = sendAvatarEvent({ type: "audio", pcm: payload.avatar_pcm_base64 });
  if (!sent) avatarAcceptFrames = false;
  return sent && isFirstChunk ? avatarAudioLeadMs : 0;
}

function resolveQueueWaiters() {
  if (queueDraining || audioQueue.length) return;
  const waiters = queueDrainWaiters;
  queueDrainWaiters = [];
  for (const resolve of waiters) resolve();
}

async function waitForAudioQueue() {
  const generation = queueGeneration;
  const streamSession = typeof streamingPlayback !== "undefined" ? streamingPlayback : null;
  if (queueDraining || audioQueue.length) {
    await new Promise((resolve) => queueDrainWaiters.push(resolve));
  }
  if (generation !== queueGeneration) return;
  if (queuePlaybackError) throw queuePlaybackError;
  if (streamSession && streamSession.generation === generation) {
    streamSession.finishInput();
    try {
      await streamSession.player.drain();
    } catch (_) {
      if (generation === queueGeneration) {
        queuePlaybackError = new Error("声音没有播放成功，请让大人检查声音后再试一次");
        throw queuePlaybackError;
      }
    }
  }
}

function clearResponseQueue() {
  audioQueue = [];
  queueGeneration += 1;
  queuePlaybackError = null;
  if (typeof streamingPlayback !== "undefined" && streamingPlayback) {
    streamingPlayback.player.cancel();
    streamingPlayback = null;
  }
  cancelAvatarFrameWaiters();
  resolveQueueWaiters();
}

function cancelPlayback() {
  flushAvatar();
  if (typeof streamingPlayback !== "undefined" && streamingPlayback) streamingPlayback.player.cancel();
  if (activePlayback) {
    activePlayback.finish();
    return;
  }
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.removeAttribute("src");
    activeAudio.load();
    activeAudio = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
}

async function playAudioPayload(payload, generation) {
  if (generation !== queueGeneration) return;
  const binary = atob(payload.audio_base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const blob = new Blob([bytes], { type: payload.audio_mime || "audio/wav" });
  activeAudioUrl = URL.createObjectURL(blob);
  const audio = new Audio(activeAudioUrl);
  const timingSessionId = globalThis.familyInteractionClock?.sessionId;
  const trackInteraction = typeof activeRequestSource === "undefined"
    || !["drawing-observation", "chess-explanation"].includes(activeRequestSource);
  activeAudio = audio;
  const activeAudioUrlForPlayback = activeAudioUrl;
  const frameSerialAtCue = avatarFrameSerial;
  const syncStartedAt = performance.now();
  const leadMs = cueAvatar(payload);
  // Register the frame waiter before asking the remote renderer to start.
  // Later sentences may already be synthesized, but must not animate ahead
  // of the sentence the child is actually hearing.
  const pendingCue = Boolean(payload?.avatar_pending && payload?.turn_id);
  if (pendingCue && avatarReady) avatarAcceptFrames = true;
  const shouldSynchronizeAvatar = avatarReady
    && Boolean(pendingCue || payload?.avatar_cued || payload?.avatar_pcm_base64);
  // Remote TTS and SoulX are co-located, but the first video keyframe still
  // crosses the private tunnel. Allow the measured tail without making the
  // slower local fallback hold speech any longer.
  // Playback-owned cues include the remote round trip in this budget; the
  // legacy 2.2 s budget started only after that round trip had completed.
  const frameWaitMs = pendingCue ? 3200 : payload?.avatar_cued ? 2200 : 1500;
  const framePromise = shouldSynchronizeAvatar
    ? waitForAvatarFrame(frameSerialAtCue, frameWaitMs)
    : Promise.resolve(false);
  if (pendingCue && avatarReady) {
    void fetch(`/api/conversation/turns/${encodeURIComponent(payload.turn_id)}/avatar/${payload.sequence}`, {
      method: "POST",
      signal: AbortSignal.timeout(frameWaitMs),
    }).then(async (response) => {
      const cue = response.ok ? await response.json() : null;
      if (!cue?.cued && generation === queueGeneration && activeAudio === audio) cancelAvatarFrameWaiters();
    }).catch(() => {
      if (generation === queueGeneration && activeAudio === audio) cancelAvatarFrameWaiters();
    });
  }
  const frameSynchronized = await framePromise;
  const elapsedSyncMs = performance.now() - syncStartedAt;
  if (generation === queueGeneration && activeAudio === audio
      && shouldSynchronizeAvatar && !frameSynchronized) {
    // A slow first frame releases speech, not the current avatar turn.
    // Keep accepting its late frames; explicit cancellation still flushes them.
    avatarCanvas.hidden = true;
    avatarImage.hidden = false;
    setAvatarState("声音先开始，动作稍后恢复");
  }
  if (!frameSynchronized && leadMs > elapsedSyncMs) {
    await new Promise((resolve) => setTimeout(resolve, leadMs - elapsedSyncMs));
  }
  if (generation !== queueGeneration) {
    if (activeAudio === audio) activeAudio = null;
    if (activeAudioUrl === activeAudioUrlForPlayback) {
      URL.revokeObjectURL(activeAudioUrlForPlayback);
      activeAudioUrl = null;
    }
    audio.removeAttribute("src");
    audio.load();
    return;
  }
  const playbackPromise = new Promise((resolve, reject) => {
    let settled = false;
    const onEnded = () => {
      if (trackInteraction && generation === queueGeneration) globalThis.familyInteractionClock?.playbackEnded(timingSessionId);
      if (typeof window !== "undefined" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("family-audio-playback", { detail: { type: "ended", generation, transport: "html-audio" } }));
      }
      finish();
    };
    const onError = () => finish(new Error("audio playback failed"));
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      if (activeAudio === audio) activeAudio = null;
      if (activeAudioUrl === activeAudioUrlForPlayback) {
        URL.revokeObjectURL(activeAudioUrlForPlayback);
        activeAudioUrl = null;
      }
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (activePlayback?.audio === audio) activePlayback = null;
      if (error) reject(error);
      else resolve();
    };
    activePlayback = { audio, finish };
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.play().then(() => {
      if (generation !== queueGeneration || typeof window === "undefined" || typeof CustomEvent !== "function") return;
      window.dispatchEvent(new CustomEvent("family-audio-playback", { detail: { type: "scheduled", generation, transport: "html-audio" } }));
    }).catch(finish);
  });
  await playbackPromise;
}

async function drainResponseQueue() {
  if (queueDraining) return;
  const generation = queueGeneration;
  queueDraining = true;
  try {
    while (audioQueue.length && generation === queueGeneration) {
      const payload = audioQueue.shift();
      try {
        await playAudioPayload(payload, generation);
      } catch (_) {
        if (generation === queueGeneration) {
          queuePlaybackError = new Error("声音没有播放成功，请让大人检查声音后再试一次");
          audioQueue = [];
          cancelPlayback();
        }
      }
    }
  } finally {
    queueDraining = false;
    resolveQueueWaiters();
    if (audioQueue.length) void drainResponseQueue();
  }
}

function enqueueAudio(payload, generation = queueGeneration) {
  if (generation !== queueGeneration || queuePlaybackError) return;
  if (payload.audio_stream) {
    enqueueStreamingAudio(payload);
    return;
  }
  audioQueue.push(payload);
  void drainResponseQueue();
}

async function playResponse(payload) {
  clearResponseQueue();
  cancelPlayback();
  enqueueAudio(payload);
  await waitForAudioQueue();
}

async function prepareStreamingAudio() {
  if (typeof globalThis.StreamingPcmPlayer !== "function") return false;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return false;
  try {
    if (audioContext && audioContext.state !== "closed") streamingAudioContext = audioContext;
    if (!streamingAudioContext || streamingAudioContext.state === "closed") {
      streamingAudioContext = new Context();
    }
    if (streamingAudioContext.state !== "running") await streamingAudioContext.resume();
    return streamingAudioContext.state === "running";
  } catch (_) {
    return false;
  }
}

function enqueueStreamingAudio(payload) {
  if (!streamingAudioContext || typeof globalThis.StreamingPcmPlayer !== "function") {
    queuePlaybackError = new Error("声音没有播放成功，请让大人检查声音后再试一次");
    return;
  }
  const generation = queueGeneration;
  if (!streamingPlayback) {
    let releaseStart;
    const startGate = new Promise((resolve) => { releaseStart = resolve; });
    const session = {
      generation,
      player: null,
      duration: 0,
      sequence: 0,
      synchronized: false,
      avatarEnabled: avatarReady && avatarSocket?.readyState === WebSocket.OPEN,
      frameSerial: avatarFrameSerial,
      timingSessionId: globalThis.familyInteractionClock?.sessionId,
      trackInteraction: typeof activeRequestSource === "undefined" || activeRequestSource !== "drawing-observation",
      finishInput: null,
    };
    const beginSync = () => {
      if (session.synchronized) return;
      session.synchronized = true;
      if (!session.avatarEnabled || generation !== queueGeneration) {
        releaseStart();
        return;
      }
      // SoulX needs about 0.96 s of PCM before it can produce its first frame.
      // Send chunks on arrival, but wait for the first frame only once per turn.
      void waitForAvatarFrame(session.frameSerial, STREAM_AVATAR_FIRST_FRAME_WAIT_MS).then((ready) => {
        if (generation !== queueGeneration) { releaseStart(); return; }
        if (!ready) {
          // Let speech start on time while this turn's video catches up.
          // Disabling or flushing here also discards every later PCM/frame.
          avatarCanvas.hidden = true;
          avatarImage.hidden = false;
          setAvatarState("声音先开始，动作稍后恢复");
        }
        releaseStart();
      }).catch(() => releaseStart());
    };
    session.player = new globalThis.StreamingPcmPlayer(streamingAudioContext, {
      startGate,
      onDecoded(buffer) {
        session.duration += buffer.duration;
        if (session.duration >= 0.96) beginSync();
      },
      onEvent(detail) {
        if (session.trackInteraction && detail.type === "ended" && generation === queueGeneration
            && Math.abs(detail.contextTime - detail.contextStartTime - detail.duration) < 2) {
          globalThis.familyInteractionClock?.playbackEnded(session.timingSessionId);
        }
        window.dispatchEvent(new CustomEvent("family-audio-playback", {
          detail: { ...detail, generation, transport: "web-audio" },
        }));
      },
    });
    const streamSocket = avatarSocket;
    let inputFinished = false;
    session.finishInput = () => {
      if (!inputFinished && session.avatarEnabled && streamSocket === avatarSocket
          && streamSocket?.supportsAudioStream && generation === queueGeneration
          && !session.player.cancelled && session.sequence > 0) {
        sendAvatarEvent({ type: "audio_end" });
      }
      inputFinished = true;
      beginSync();
    };
    streamingPlayback = session;
    if (!session.avatarEnabled) beginSync();
  }
  const session = streamingPlayback;
  if (session.generation !== generation || session.player.cancelled || session.player.error) return;
  const sequence = Number(payload.sequence);
  if (Number.isInteger(sequence) && sequence > 0 && sequence <= session.sequence) return;
  if (!Number.isInteger(sequence) || sequence !== session.sequence + 1) {
    session.player.fail(new Error("The audio stream has a missing or invalid segment"));
    return;
  }
  session.sequence = sequence;
  try {
    const binary = atob(payload.audio_base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    if (session.avatarEnabled) cueAvatar(payload);
    session.player.enqueue(bytes.buffer);
  } catch (error) {
    session.player.fail(error);
  }
}

async function consumeSse(response, onEvent) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || "本地服务暂时没有回应");
  }
  if (!response.body) throw new Error("浏览器没有收到 streaming response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeFrame = (frame) => {
    const data = frame
      .replaceAll("\r", "")
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    onEvent(JSON.parse(data));
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) consumeFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
}

function createConversationTurnId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cancelConversationTurn(turnId) {
  if (!turnId) return Promise.resolve();
  return fetch(`/api/conversation/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: "POST",
    keepalive: true,
  }).catch(() => undefined);
}

async function completeConversationTurn(turnId) {
  const response = await fetch(`/api/conversation/turns/${encodeURIComponent(turnId)}/complete`, {
    method: "POST",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || "这次回答还没有完整结束");
  return payload;
}

async function sendStreamingRequest({ endpoint, body, continuous = false, signal = null, source = "", onText = null }) {
  if (typeof chessSpeechController !== "undefined" && chessSpeechController) cancelChessExplanation();
  if (activeRequestController) return { ok: false, busy: true };
  if (signal?.aborted) return { ok: false, aborted: true };
  if (typeof cancelMediaSuggestionLookup === "function") cancelMediaSuggestionLookup();
  continuous = continuous || conversationActive;
  if (continuous) {
    stopVadLoop();
    segmentRecording = false;
    segmentShouldSend = false;
    segmentPcmChunks = [];
  }
  setBusy(true);
  setStatus("正在听清楚你说的话…", "thinking");
  resetLiveTurn();
  clearResponseQueue();
  cancelPlayback();
  const playbackGeneration = queueGeneration;
  const controller = new AbortController();
  const turnId = createConversationTurnId();
  activeRequestController = controller;
  activeRequestSource = source;
  activeTurnId = turnId;
  const cancelFromCaller = () => {
    controller.abort();
    if (activeRequestController === controller) {
      clearResponseQueue();
      cancelPlayback();
      void cancelConversationTurn(turnId);
    }
  };
  signal?.addEventListener("abort", cancelFromCaller, { once: true });
  const timingSessionId = source === "drawing-observation"
    ? globalThis.familyInteractionClock?.sessionId : globalThis.familyInteractionClock?.begin();
  if (continuous) startBargeInMonitor();
  let assistantText = "";
  let activityTransition = null;
  let streamError = null;
  let commitRequired = false;
  let turnCommitted = false;
  let receivedDone = false;
  let chessRequested = false;
  let chessContextGeneration = null;
  let childTurnText = "";
  try {
    const audioStreaming = typeof prepareStreamingAudio === "function" && await prepareStreamingAudio();
    if ((endpoint === "/api/conversation/stream" || endpoint === "/api/conversation/text/stream")
        && typeof chessBoard !== "undefined" && chessBoard?.isOpen && activityEnabled("game")) {
      try {
        const context = chessBoard.getConversationContext?.();
        if (typeof context === "string" && context.trim()) {
          const value = context.trim().slice(0, 3000);
          if (body instanceof FormData) body.append("chess_context", value);
          else body = JSON.stringify({ ...JSON.parse(body), chess_context: value });
          chessContextGeneration = chessOpenGeneration;
        }
      } catch (_) { /* Optional board facts must not interrupt an ordinary voice turn. */ }
    }
    let observationRequest = "";
    for (let captureAttempt = 0; captureAttempt < 2; captureAttempt++) {
      observationRequest = "";
      const headers = { "X-Conversation-Turn-Id": turnId, "X-Avatar-Playback-Cues": "1" };
      if (audioStreaming) headers["X-Audio-Streaming"] = "1";
      if (!(body instanceof FormData)) {
        headers["Content-Type"] = body instanceof Blob ? body.type || "image/jpeg" : "application/json";
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      await consumeSse(response, (event) => {
        if (controller.signal.aborted || chessRequested) return;
        if (event.event === "chess_request") {
          chessRequested = true;
        } else if (event.event === "vision_request") {
          observationRequest = event.text || "";
        } else if (event.event === "user_text") {
          if (source !== "drawing-observation" && String(event.text || "").trim()) globalThis.familyInteractionClock?.confirmInput(timingSessionId);
          if (userTextBox) userTextBox.textContent = event.text || "刚刚说了一句话";
          childTurnText = String(event.text || "").trim();
        } else if (event.event === "assistant_delta") {
          assistantText += event.text || "";
          answerBox.classList.add("has-answer");
          answerBox.textContent = assistantText;
          onText?.(assistantText);
          // Text can arrive after audio has actually started. Do not let a late
          // delta overwrite the playback-owned speaking state.
          if (avatarStage?.dataset.state !== "speaking") setStatus("爸爸老师正在想一想…", "thinking");
        } else if (event.event === "audio") {
          enqueueAudio(event, playbackGeneration);
        } else if (event.event === "vision_context") {
          setStatus("爸爸老师看到了刚才的画面…", "thinking");
          if (visionResult) {
            visionResult.hidden = false;
            visionResult.textContent = event.description || "爸爸看到了刚才的画面";
          }
        } else if (event.event === "done") {
          receivedDone = true;
          assistantText = event.assistant_text || assistantText;
          commitRequired = Boolean(event.commit_required);
          if (source !== "drawing-observation" && event.activity_transition && typeof event.activity_transition === "object") {
            activityTransition = event.activity_transition;
          }
          if (assistantText) {
            answerBox.classList.add("has-answer");
            answerBox.textContent = assistantText;
            onText?.(assistantText);
          }
          if (event.history && assistantText) {
            appendHistoryRecord(event.history);
            turnCommitted = true;
          }
          if (event.ok === false) streamError = streamError || "回答没有完整生成";
        } else if (event.event === "error") {
          streamError = event.message || "本地服务暂时没有回应";
        }
      });
      if (!observationRequest) break;
      if (captureAttempt > 0) throw new Error("这次没看清，可以再给爸爸看一次");
      const observed = new FormData();
      observed.append("transcript", observationRequest);
      observed.append("observation_attempted", "true");
      const drawingOpen = typeof drawingBoard !== "undefined" && drawingBoard?.isOpen;
      if (!controller.signal.aborted && (drawingOpen ? activityEnabled("drawing") : activityEnabled("vision_photo"))) {
        setStatus("你请爸爸看，现在拍一张…", "thinking");
        captureState.textContent = "按你刚才的请求，拍一张";
        try {
          const usePhoto = !drawingOpen && typeof capturedBlob !== "undefined" && capturedBlob
            && /(?:刚才|剛才|这张|這張|那张|那張|上面|照片|图片|圖片)/.test(observationRequest);
          const frame = drawingOpen ? await drawingBoard.getSnapshot() : usePhoto ? capturedBlob : await makeFrameBlob();
          if (!controller.signal.aborted && frame) {
            observed.append("frame", frame, drawingOpen ? "drawing.png" : "requested-frame.jpg");
            if (drawingOpen) observed.append("visual_source", "drawing");
          }
        } catch (_) {
          cameraStatus.textContent = "这次没打开画面，我们继续说话";
        }
      }
      if (controller.signal.aborted) throw new DOMException("已取消", "AbortError");
      endpoint = "/api/conversation/stream";
      body = observed;
    }
    if (chessRequested) {
      if (controller.signal.aborted || playbackGeneration !== queueGeneration) return { ok: false, aborted: true };
      hideLiveTurn();
      stopBargeInMonitor();
      return { ok: true, chess: true };
    }
    if (!receivedDone) throw new Error("连接中断，这次回答还没有完整结束");
    if (streamError) throw new Error(streamError);
    await waitForAudioQueue();
    if (controller.signal.aborted || playbackGeneration !== queueGeneration) {
      throw new DOMException("这次回答已停止", "AbortError");
    }
    if (interruptedRequestController === controller) {
      return { ok: false, interrupted: true };
    }
    if (streamError) throw new Error(streamError);
    if (!assistantText) throw new Error("爸爸老师没有返回文字回答");
    if (commitRequired) {
      const completion = await completeConversationTurn(turnId);
      turnCommitted = true;
      if (interruptedRequestController === controller) {
        return { ok: false, interrupted: true };
      }
      // A successful receipt may arrive after pause or a newer turn. Preserve
      // the server's commit, but do not let this stale reply change the UI.
      if (controller.signal.aborted || playbackGeneration !== queueGeneration || activeRequestController !== controller) {
        return { ok: false, aborted: true };
      }
      if (completion.history) appendHistoryRecord(completion.history);
    }
    if (source === "drawing-observation") await cancelConversationTurn(turnId);
    if (turnCommitted && chessContextGeneration !== null && chessContextGeneration === chessOpenGeneration
        && chessBoard?.isOpen && activityTransition
        && (activityTransition.action === "clear" || (activityTransition.action === "set"
          && typeof activityTransition.activity === "string" && activityTransition.activity))) {
      activeRequestSource = "";
      chessBoard.close();
    }
    if (turnCommitted && typeof drawingBoard !== "undefined" && drawingBoard?.isOpen && activityTransition
        && (activityTransition.action === "clear" || (activityTransition.action === "set"
          && typeof activityTransition.activity === "string" && activityTransition.activity && activityTransition.activity !== "drawing"))) {
      // The reply and receipt are complete. Closing must not abort that finished
      // voice turn, and the RAM drawing remains available when reopened.
      activeRequestSource = "";
      drawingBoard.close();
    }
    hideLiveTurn();
    if (source !== "drawing-observation") void loadMediaSuggestions(childTurnText, assistantText);
    stopBargeInMonitor();
    if (continuous && conversationActive) beginContinuousSegment();
    else setStatus("回答完成", "idle");
    return { ok: true, assistantText };
  } catch (error) {
    if (!turnCommitted) cancelPlayback();
    if (!turnCommitted) void cancelConversationTurn(turnId);
    if (interruptedRequestController === controller) {
      return { ok: false, interrupted: true };
    }
    if (error.name === "AbortError" && !conversationActive) return { ok: false, aborted: true };
    const message = error.message || "本地服务暂时没有回应";
    setStatus("还没有准备好", "offline");
    answerBox.classList.add("has-answer");
    answerBox.textContent = message;
    liveTurn.hidden = false;
    stopBargeInMonitor();
    if (continuous && conversationActive) beginContinuousSegment();
    return { ok: false, error: message };
  } finally {
    signal?.removeEventListener("abort", cancelFromCaller);
    const openRequestedChess = chessRequested && !controller.signal.aborted
      && playbackGeneration === queueGeneration && activeRequestController === controller;
    if (activeRequestController === controller) {
      activeRequestController = null;
      activeRequestSource = "";
    }
    if (interruptedRequestController === controller) interruptedRequestController = null;
    if (activeTurnId === turnId) activeTurnId = null;
    if (!conversationActive) globalThis.familyInteractionClock?.end(timingSessionId);
    setBusy(false);
    if (openRequestedChess) void openChessActivity();
  }
}

async function sendText(text) {
  const clean = text.trim();
  if (!clean) return;
  if (drawingBoard?.isOpen && activityEnabled("drawing")) {
    const body = new FormData();
    body.append("transcript", clean);
    body.append("observation_attempted", "true");
    const snapshot = await drawingBoard.getSnapshot();
    if (snapshot) {
      body.append("frame", snapshot, "drawing.png");
      body.append("visual_source", "drawing");
    }
    return sendStreamingRequest({ endpoint: "/api/conversation/stream", body, source: "drawing-voice",
      onText: (text) => drawingBoard?.setFeedback(text) });
  }
  await sendStreamingRequest({
    endpoint: "/api/conversation/text/stream",
    body: JSON.stringify({ text: clean }),
  });
}

async function sendAudio(blob, continuous = false) {
  if (!blob?.size) return;
  const form = new FormData();
  const extension = blob.type === "audio/wav" ? "wav" : "webm";
  form.append("audio", blob, `child-speech.${extension}`);
  const drawingOpen = drawingBoard?.isOpen && activityEnabled("drawing");
  if (drawingOpen) {
    const snapshot = await drawingBoard.getSnapshot();
    if (snapshot) {
      form.append("frame", snapshot, "drawing.png");
      form.append("visual_source", "drawing");
    }
  }
  await sendStreamingRequest({ endpoint: "/api/conversation/stream", body: form, continuous,
    source: drawingOpen ? "drawing-voice" : "", onText: drawingOpen ? (text) => drawingBoard?.setFeedback(text) : null });
}

function stopVadLoop() {
  if (vadTimer) clearTimeout(vadTimer);
  vadTimer = null;
  loudSince = 0;
  lastVoiceAt = 0;
}

function stopBargeInMonitor() {
  if (bargeInTimer) clearTimeout(bargeInTimer);
  bargeInTimer = null;
  bargeInMonitoring = false;
  bargeInGate.reset();
  bargeInPcmChunks = [];
}

function scheduleBargeInCheck() {
  if (!bargeInMonitoring || !conversationActive || segmentRecording) return;
  if (bargeInTimer) clearTimeout(bargeInTimer);
  bargeInTimer = setTimeout(checkBargeIn, BARGE_IN_INTERVAL_MS);
}

function startBargeInMonitor() {
  if (!conversationActive || !inputAnalyser || segmentRecording) return;
  stopBargeInMonitor();
  bargeInMonitoring = true;
  scheduleBargeInCheck();
}

function triggerBargeIn() {
  if (!bargeInMonitoring || !conversationActive || segmentRecording) return;
  const preRoll = bargeInPcmChunks.slice();
  interruptedRequestController = activeRequestController;
  void cancelConversationTurn(activeTurnId);
  activeRequestController?.abort();
  clearResponseQueue();
  cancelPlayback();
  stopBargeInMonitor();
  beginContinuousSegment(preRoll, true);
  recordHint.textContent = "我停下来听你说；说完停一下。";
  setStatus("我在听，请继续说…", "listening");
}

function checkBargeIn() {
  if (!bargeInMonitoring || !conversationActive || segmentRecording) return;
  if (bargeInGate.update(inputRms(), performance.now())) {
    triggerBargeIn();
    return;
  }
  scheduleBargeInCheck();
}

function inputRms() {
  if (!inputAnalyser) return 0;
  const data = new Uint8Array(inputAnalyser.fftSize);
  inputAnalyser.getByteTimeDomainData(data);
  let square = 0;
  for (const value of data) {
    const centered = (value - 128) / 128;
    square += centered * centered;
  }
  return Math.sqrt(square / data.length);
}

function scheduleVad() {
  if (!conversationActive || !inputAnalyser || !segmentRecording) return;
  if (vadTimer) clearTimeout(vadTimer);
  vadTimer = setTimeout(checkVoiceActivity, VAD_INTERVAL_MS);
}

function checkVoiceActivity() {
  if (!conversationActive || !inputAnalyser || !segmentRecording) return;
  const now = performance.now();
  const rms = inputRms();
  updateListeningLevel(rms);
  if (rms >= VAD_START_RMS) {
    if (!loudSince) loudSince = now;
    lastVoiceAt = now;
    if (!speechStartedAt && now - loudSince >= VAD_START_HOLD_MS) {
      speechStartedAt = now;
      recordHint.textContent = "我听到了…说完停一下，我来回答。";
    }
  } else if (rms >= VAD_STOP_RMS) {
    lastVoiceAt = now;
  } else {
    loudSince = 0;
  }

  if (speechStartedAt && now - lastVoiceAt >= VAD_SILENCE_MS) {
    finishContinuousSegment();
    return;
  }
  if (speechStartedAt && now - speechStartedAt >= VAD_MAX_SEGMENT_MS) {
    finishContinuousSegment();
    return;
  }
  scheduleVad();
}

function retainRecentPcm(chunks, sampleRate, seconds = PCM_PREROLL_SECONDS) {
  let remaining = Math.ceil(sampleRate * seconds);
  const recent = [];
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index--) {
    const chunk = chunks[index];
    const count = Math.min(chunk.length, remaining);
    recent.push(count === chunk.length ? chunk : chunk.subarray(chunk.length - count));
    remaining -= count;
  }
  return recent.reverse();
}

function writeWavString(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function pcmToWav(chunks, sampleRate) {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  writeWavString(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeWavString(view, 8, "WAVE");
  writeWavString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeWavString(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clipped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clipped < 0 ? clipped * 32768 : clipped * 32767, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function beginContinuousSegment(initialChunks = [], alreadySpeaking = false) {
  if (!conversationActive || !recordingStream || segmentRecording) return;
  resetListeningLevel();
  stopBargeInMonitor();
  segmentPcmChunks = initialChunks.slice();
  segmentRecording = true;
  segmentShouldSend = false;
  speechStartedAt = alreadySpeaking ? performance.now() : 0;
  lastVoiceAt = speechStartedAt;
  loudSince = speechStartedAt;
  recordHint.textContent = "我会一直听；说完停一下，爸爸老师会回答。";
  setStatus("我在听，请说话…", "listening");
  scheduleVad();
}

function finishContinuousSegment() {
  if (!segmentRecording) return;
  segmentShouldSend = Boolean(speechStartedAt);
  segmentRecording = false;
  stopVadLoop();
  const chunks = segmentPcmChunks;
  segmentPcmChunks = [];
  const shouldSend = segmentShouldSend;
  segmentShouldSend = false;
  speechStartedAt = 0;
  if (!conversationActive || !shouldSend) {
    if (conversationActive) beginContinuousSegment();
    return;
  }
  if (shouldSend) setStatus("听到了，正在准备回答…", "thinking");
  const blob = pcmToWav(chunks, inputSampleRate);
  void sendAudio(blob, true);
}

function releaseInputStream() {
  resetListeningLevel();
  stopVadLoop();
  stopBargeInMonitor();
  segmentRecording = false;
  segmentPcmChunks = [];
  if (inputProcessor) {
    inputProcessor.onaudioprocess = null;
    inputProcessor.disconnect();
    inputProcessor = null;
  }
  if (inputMuteGain) {
    inputMuteGain.disconnect();
    inputMuteGain = null;
  }
  if (inputSource) {
    inputSource.disconnect();
    inputSource = null;
  }
  inputAnalyser = null;
  recordingStream?.getTracks().forEach((track) => track.stop());
  recordingStream = null;
}

async function startContinuousConversation() {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext && !window.webkitAudioContext) {
    throw new Error("当前浏览器不支持录音，请使用最新版 Chrome。");
  }
  if (conversationStarting || conversationActive) return;
  conversationStarting = true;
  recordButton.disabled = true;
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = audioContext || new AudioContextClass();
    await audioContext.resume();
    inputSampleRate = audioContext.sampleRate;
    inputSource = audioContext.createMediaStreamSource(recordingStream);
    inputAnalyser = audioContext.createAnalyser();
    inputAnalyser.fftSize = 1024;
    inputAnalyser.smoothingTimeConstant = 0.2;
    inputSource.connect(inputAnalyser);
    inputProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    inputMuteGain = audioContext.createGain();
    inputMuteGain.gain.value = 0;
    inputProcessor.onaudioprocess = (event) => {
      if (!conversationActive) return;
      const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
      if (segmentRecording) {
        segmentPcmChunks.push(chunk);
        // Keep the beginning of a word while VAD confirms its onset. Once
        // speech is confirmed, retain the complete sentence until submission.
        if (!speechStartedAt) segmentPcmChunks = retainRecentPcm(segmentPcmChunks, inputSampleRate);
      } else if (bargeInMonitoring) {
        bargeInPcmChunks.push(chunk);
        // The detection window may span several syllables. Include one input
        // block beyond it, including at sample rates with longer blocks.
        const seconds = Math.max(PCM_PREROLL_SECONDS, bargeInGate.windowMs / 1000 + chunk.length / inputSampleRate);
        bargeInPcmChunks = retainRecentPcm(bargeInPcmChunks, inputSampleRate, seconds);
      }
    };
    inputSource.connect(inputProcessor);
    inputProcessor.connect(inputMuteGain);
    inputMuteGain.connect(audioContext.destination);
    conversationActive = true;
    globalThis.familyInteractionClock?.begin();
    beginContinuousSegment();
  } catch (error) {
    conversationActive = false;
    releaseInputStream();
    throw error;
  } finally {
    conversationStarting = false;
    recordButton.disabled = false;
  }
  recordButton.classList.add("recording");
  recordButton.setAttribute("aria-pressed", "true");
  recordLabel.textContent = "结束这次交流";
}

function stopContinuousConversation() {
  globalThis.familyInteractionClock?.end();
  if (typeof cancelMediaSuggestionLookup === "function") cancelMediaSuggestionLookup();
  conversationActive = false;
  segmentShouldSend = false;
  void cancelConversationTurn(activeTurnId);
  activeRequestController?.abort();
  releaseInputStream();
  clearResponseQueue();
  cancelPlayback();
  recordButton.classList.remove("recording");
  recordButton.setAttribute("aria-pressed", "false");
  recordLabel.textContent = "和爸爸老师说话";
  recordHint.textContent = "这次交流结束了，想继续时再点一下。";
  setStatus("休息一下，想聊时我还在", "idle");
}

recordButton.addEventListener("click", async () => {
  cancelChessExplanation();
  if (conversationActive) {
    stopContinuousConversation();
    return;
  }
  try {
    await startContinuousConversation();
  } catch (error) {
    setStatus("麦克风没有打开", "idle");
    recordHint.textContent = error.message;
  }
});

textForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = textInput.value;
  textInput.value = "";
  await sendText(text);
});

async function startActivityConversation(button) {
  const text = String(button.dataset.prompt || "").trim();
  if (!text || !activityEnabled(String(button.dataset.activity || ""))
      || conversationStarting || activeRequestController) return;
  try {
    if (!conversationActive) await startContinuousConversation();
    // Permission can take long enough for a text reply or parent setting to
    // change. Do not pause a live input segment for a request we cannot send.
    if (!conversationActive || activeRequestController
        || !activityEnabled(String(button.dataset.activity || ""))) return;
    // The chosen activity replaces an unfinished listening segment. Keep the
    // microphone open, then let normal streamed playback resume listening.
    stopVadLoop();
    segmentRecording = false;
    segmentShouldSend = false;
    segmentPcmChunks = [];
    await sendStreamingRequest({
      endpoint: "/api/conversation/text/stream",
      body: JSON.stringify({ text }),
      continuous: true,
    });
  } catch (_) {
    setStatus("麦克风还没打开", "idle");
    recordHint.textContent = "请家长帮忙打开麦克风，也可以在下面帮忙打字。";
  }
}

async function interruptActiveReply() {
  const previous = activeRequestController;
  if (!previous) return;
  interruptedRequestController = previous;
  void cancelConversationTurn(activeTurnId);
  previous.abort();
  stopVadLoop();
  stopBargeInMonitor();
  segmentRecording = false;
  segmentShouldSend = false;
  segmentPcmChunks = [];
  clearResponseQueue();
  cancelPlayback();
  const until = performance.now() + 1500;
  while (activeRequestController === previous && performance.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (activeRequestController === previous) throw new Error("上一句话正在结束，请稍后再试一次");
}

function cancelChessExplanation(resumeListening = false) {
  chessSpeechGeneration += 1;
  const controller = chessSpeechController;
  chessSpeechController = null;
  controller?.abort();
  if (resumeListening && conversationActive && !conversationStarting
      && !activeRequestController && !segmentRecording) beginContinuousSegment();
}

function cancelMusicExplanation(resumeListening = false) {
  const controller = musicSpeechController;
  musicSpeechController = null;
  controller?.abort();
  if (resumeListening && conversationActive && !conversationStarting
      && !activeRequestController && !segmentRecording) beginContinuousSegment();
}

async function speakMusicInstruction(text) {
  cancelMusicExplanation();
  const instruction = String(text || "").trim();
  if (!musicStudio?.opened || !activityEnabled("music")) return { ok: false, aborted: true };
  if (activeRequestController || conversationStarting) {
    return { ok: false, error: "爸爸先把刚才的话说完，琴键还可以继续玩。" };
  }
  if (!instruction || instruction.length > 240) return { ok: false, error: "先看亮起来的琴键吧。" };
  const controller = new AbortController();
  musicSpeechController = controller;
  let timeout = null;
  try {
    stopVadLoop();
    stopBargeInMonitor();
    segmentRecording = false;
    segmentShouldSend = false;
    segmentPcmChunks = [];
    clearResponseQueue();
    cancelPlayback();
    const playbackGeneration = queueGeneration;
    activeRequestController = controller;
    activeRequestSource = "music-explanation";
    activeTurnId = null;
    setBusy(true);
    setStatus("爸爸老师正在准备音乐示范…", "thinking");
    timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch("/api/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: instruction }), signal: controller.signal,
    });
    const payload = await response.json();
    if (musicSpeechController !== controller || controller.signal.aborted
        || playbackGeneration !== queueGeneration) return { ok: false, aborted: true };
    if (!response.ok || !payload?.audio_base64) throw new Error("music voice unavailable");
    clearTimeout(timeout);
    timeout = null;
    setStatus("爸爸老师正在示范…", "speaking");
    await playAudioPayload(payload, playbackGeneration);
    if (musicSpeechController !== controller || controller.signal.aborted) return { ok: false, aborted: true };
    return { ok: true };
  } catch (_) {
    if (controller.signal.aborted || musicSpeechController !== controller) return { ok: false, aborted: true };
    return { ok: false, error: "声音没播出来，琴键仍然可以继续玩。" };
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    if (activeRequestController === controller) {
      clearResponseQueue();
      cancelPlayback();
      activeRequestController = null;
      activeRequestSource = "";
      setBusy(false);
    }
    if (musicSpeechController === controller) musicSpeechController = null;
    if (!conversationActive && !activeRequestController) setStatus("轮到你玩音乐", "idle");
  }
}

async function acquireMusicMicrophone() {
  if (!recordingStream?.active) await startContinuousConversation();
  stopVadLoop();
  stopBargeInMonitor();
  segmentRecording = false;
  segmentShouldSend = false;
  segmentPcmChunks = [];
  return recordingStream;
}

async function transcribeMusicRecording(blob) {
  const body = new FormData();
  body.append("audio", blob, "singing.webm");
  const response = await fetch("/api/transcribe", { method: "POST", body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("transcription unavailable");
  return String(payload.text || "");
}

function getMusicStudio() {
  if (musicStudio) return musicStudio;
  musicStudio = new MusicStudio({
    onSpeak: speakMusicInstruction,
    acquireMicrophone: acquireMusicMicrophone,
    transcribe: transcribeMusicRecording,
    onClose: () => {
      cancelMusicExplanation();
      if (!pageIsLeaving && musicConversationWasActive && conversationActive && !activeRequestController) beginContinuousSegment();
      else if (!pageIsLeaving && !musicConversationWasActive && conversationActive) stopContinuousConversation();
      musicConversationWasActive = false;
    },
  });
  return musicStudio;
}

async function openMusicActivity(mode) {
  if (!activityEnabled("music")) return;
  cancelChessExplanation();
  chessBoard?.close();
  drawingBoard?.close();
  await interruptActiveReply().catch(() => {});
  if (!activityEnabled("music")) return;
  musicConversationWasActive = conversationActive;
  stopVadLoop();
  stopBargeInMonitor();
  segmentRecording = false;
  segmentShouldSend = false;
  segmentPcmChunks = [];
  const studio = getMusicStudio();
  studio.open();
  studio.setMode(mode === "sing" ? "sing" : "piano");
  playChoices.hidden = true;
  playButton?.setAttribute("aria-expanded", "false");
}

async function speakChessInstruction(text) {
  cancelChessExplanation();
  const instruction = String(text || "").trim();
  if (!chessBoard?.isOpen || !activityEnabled("game")) return { ok: false, aborted: true };
  if (conversationActive && segmentRecording && (speechStartedAt || loudSince)) {
    return { ok: false, error: "我先听你说。想听棋盘讲解时，可以点“再听一遍”。" };
  }
  if (activeRequestController) {
    return { ok: false, error: "我先回答你刚才的问题。想听棋盘讲解，可以稍后点“再听一遍”。" };
  }
  if (conversationStarting) return { ok: false, error: "麦克风还在准备，可以先下棋，稍后再听讲解。" };
  if (!instruction || instruction.length > 200) {
    cancelChessExplanation(true);
    return { ok: false, error: "这句讲解太长了，先看棋盘上的提示吧。" };
  }
  const generation = chessSpeechGeneration;
  const controller = new AbortController();
  chessSpeechController = controller;
  const current = () => chessSpeechController === controller && generation === chessSpeechGeneration
    && !controller.signal.aborted && chessBoard?.isOpen && activityEnabled("game");
  let timeout = null;
  let timedOut = false;
  const releasePlayback = () => {
    if (activeRequestController !== controller) return;
    clearResponseQueue();
    cancelPlayback();
    stopBargeInMonitor();
    activeRequestController = null;
    activeRequestSource = "";
    if (interruptedRequestController === controller) interruptedRequestController = null;
    setBusy(false);
  };
  controller.signal.addEventListener("abort", releasePlayback, { once: true });
  try {
    if (!current()) return { ok: false, aborted: true };
    // Discard only the unfinished capture; keep the already-open microphone.
    stopVadLoop();
    segmentRecording = false;
    segmentShouldSend = false;
    segmentPcmChunks = [];
    speechStartedAt = 0;
    clearResponseQueue();
    cancelPlayback();
    const playbackGeneration = queueGeneration;
    activeRequestController = controller;
    activeRequestSource = "chess-explanation";
    activeTurnId = null;
    setBusy(true);
    setStatus("爸爸老师正在准备讲解棋盘…", "thinking");
    if (conversationActive) startBargeInMonitor();
    timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
    const response = await fetch("/api/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: instruction }), signal: controller.signal,
    });
    if (!current()) return { ok: false, aborted: true };
    const payload = await response.json();
    if (!current() || playbackGeneration !== queueGeneration) return { ok: false, aborted: true };
    if (!response.ok || !payload?.audio_base64) throw new Error("chess voice unavailable");
    clearTimeout(timeout);
    timeout = null;
    setStatus("爸爸老师正在讲解棋盘…", "speaking");
    // /api/tts supplies audio/avatar PCM only: no child turn or delivery receipt.
    await playAudioPayload(payload, playbackGeneration);
    if (!current() || playbackGeneration !== queueGeneration) return { ok: false, aborted: true };
    return { ok: true };
  } catch (_) {
    if ((!current() && !timedOut) || chessSpeechController !== controller
        || generation !== chessSpeechGeneration) return { ok: false, aborted: true };
    return { ok: false, error: "这次讲解的声音没播出来。可以点“再听一遍”，棋盘还能继续玩。" };
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    controller.signal.removeEventListener("abort", releasePlayback);
    releasePlayback();
    if (chessSpeechController === controller) {
      chessSpeechController = null;
      if (conversationActive && !segmentRecording && !activeRequestController) beginContinuousSegment();
      else if (!conversationActive && !activeRequestController) setStatus("看看棋盘，轮到你来试试", "idle");
    } else if (!chessSpeechController && !chessBoard?.isOpen && !drawingBoard?.isOpen
        && conversationActive && !conversationStarting && !segmentRecording && !activeRequestController) {
      // Closing during a previous conversation's cancellation still resumes
      // listening after that request has released its controller.
      beginContinuousSegment();
    }
  }
}

function getChessBoard() {
  if (chessBoard) return chessBoard;
  chessBoard = new globalThis.ChessBoard({
    onSpeak: speakChessInstruction,
    onClose: () => cancelChessExplanation(true),
  });
  return chessBoard;
}

async function openChessActivity() {
  if (!activityEnabled("game")) return;
  const generation = ++chessOpenGeneration;
  void prepareStreamingAudio();
  let timer = null;
  try {
    if (typeof globalThis.ChessBoard !== "function") {
      await Promise.race([
        import("/chess-board.js?v=20260906-1"),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("chess module timeout")), 5000); }),
      ]);
    }
    if (generation !== chessOpenGeneration || !activityEnabled("game")) return;
    if (!conversationActive) {
      try { await startContinuousConversation(); }
      catch (_) { recordHint.textContent = "麦克风暂时没打开，棋盘仍然可以玩；也可以请家长帮忙打开麦克风。"; }
    }
    if (generation !== chessOpenGeneration || !activityEnabled("game")) return;
    drawingBoard?.close();
    const board = getChessBoard();
    if (board.isOpen && conversationActive && !activeRequestController && !segmentRecording) beginContinuousSegment();
    board.open();
  } catch (_) {
    if (generation !== chessOpenGeneration) return;
    setStatus("棋盘正在准备，其他活动可以继续用", "idle");
    recordHint.textContent = "棋盘暂时没打开，可以稍后再点“下棋”。";
    if (conversationActive && !activeRequestController && !segmentRecording) beginContinuousSegment();
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function getDrawingBoard() {
  if (drawingBoard) return drawingBoard;
  drawingBoard = globalThis.createDrawingBoard({
    async onObserve(blob, revision, meta) {
      if (!meta.isActive() || !activityEnabled("drawing")) return null;
      if (activeRequestController || conversationStarting || speechStartedAt || loudSince) return { deferred: true };
      const body = new FormData();
      body.append("transcript", "请看看这张正在画的画，简短说出一个可见的笔画或给一个画画建议。");
      body.append("frame", blob, "drawing.png");
      body.append("visual_source", "drawing");
      body.append("observation_attempted", "true");
      body.append("drawing_observation", "true");
      const result = await sendStreamingRequest({ endpoint: "/api/conversation/stream", body,
        continuous: conversationActive, signal: meta.signal, source: "drawing-observation",
        onText: (text) => drawingBoard?.setFeedback(text, revision, meta.sessionId) });
      if (result.busy) return { deferred: true };
      if (!result.ok && !result.aborted && !result.interrupted) throw new Error(result.error || "这次看画暂时没有回应");
      return result.ok ? { text: result.assistantText } : null;
    },
    async onTalk() {
      if (conversationActive) stopContinuousConversation();
      else {
        try { await startContinuousConversation(); }
        catch (_) { drawingBoard?.setFeedback("画板可以继续用，请家长帮忙打开麦克风再和爸爸老师说话。"); }
      }
    },
    onClose() {
      if (activeRequestController && activeRequestSource.startsWith("drawing")) {
        activeRequestController.abort();
        clearResponseQueue();
        cancelPlayback();
      }
    },
  });
  return drawingBoard;
}

async function openDrawingActivity(button) {
  if (!activityEnabled("drawing") || conversationStarting) return;
  chessOpenGeneration += 1;
  chessBoard?.close();
  const board = getDrawingBoard();
  board.open();
  void prepareStreamingAudio();
  try {
    await interruptActiveReply();
    if (!board.isOpen) return;
    if (!conversationActive) await startContinuousConversation();
    if (!board.isOpen || !activityEnabled("drawing")) return;
    await sendStreamingRequest({ endpoint: "/api/conversation/text/stream",
      body: JSON.stringify({ text: String(button.dataset.prompt || "爸爸老师，带我一起画画吧。") }),
      continuous: true, source: "drawing-activity", onText: (text) => board.setFeedback(text) });
  } catch (_) {
    board.setFeedback("画板已经准备好了。你可以先画，点“和爸爸说话”再一起聊。");
    board.setVoiceState("paused");
  }
}

playButton?.addEventListener("click", () => {
  const expanded = playButton.getAttribute("aria-expanded") === "true";
  playButton.setAttribute("aria-expanded", String(!expanded));
  playChoices.hidden = expanded;
});

for (const button of activityButtons) {
  if (button === playButton) continue;
  button.addEventListener("click", () => {
    void (button.dataset.musicMode ? openMusicActivity(button.dataset.musicMode)
      : button.dataset.chess === "true" ? openChessActivity()
      : button.dataset.activity === "drawing" ? openDrawingActivity(button) : startActivityConversation(button));
  });
}
function handlePageHide() {
  pageIsLeaving = true;
  cancelMediaSuggestionLookup();
  mediaPlaybackGeneration += 1;
  mediaResumePending = false;
  mediaConversationWasActive = false;
  musicConversationWasActive = false;
  chessOpenGeneration += 1;
  cancelChessExplanation();
  cancelMusicExplanation();
  musicStudio?.destroy();
  mediaViewer.destroy();
}

window.addEventListener("pagehide", handlePageHide);

const cameraVideo = document.querySelector("#cameraVideo");
const cameraToolbar = document.querySelector("#cameraToolbar");
const cameraButton = document.querySelector("#cameraButton");
const captureButton = document.querySelector("#captureButton");
const recordVideoButton = document.querySelector("#recordVideoButton");
const cameraState = document.querySelector(".camera-state");
const recordProgress = document.querySelector("#recordProgress");
const cameraStatus = document.querySelector("#cameraStatus");
const captureState = document.querySelector("#captureState");
const captureCanvas = document.querySelector("#captureCanvas");
const capturedFrame = document.querySelector("#capturedFrame");
const visionResult = document.querySelector("#visionResult");
let cameraStream = null;
let capturedUrl = null;
let capturedBlob = null;
let videoRecorder = null;
let videoRecordingGeneration = 0;
let videoRequestController = null;
let videoChunks = [];
let videoStopTimer = null;
let videoProgressTimer = null;
const MANUAL_VIDEO_MAX_MS = 6000;

async function loadChildProfileControls() {
  try {
    const response = await fetch("/api/profile", { cache: "no-store" });
    const profile = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("家庭设置暂时不可用");
    childProfileLoaded = true;
    enabledActivities = new Set(
      Array.isArray(profile.enabled_activities) ? profile.enabled_activities : defaultEnabledActivities,
    );
    const nickname = String(profile.name || "").trim();
    if (nickname) {
      childWelcome.textContent = `${nickname}，爸爸老师在这里。`;
      conversationTitle.textContent = `${nickname}，一起学，一起聊`;
    } else {
      childWelcome.textContent = "一起说、一起看、一起学。";
      conversationTitle.textContent = "一起学，一起聊";
    }
  } catch (_) {
    // A temporary network miss must not erase the last parent-approved controls.
    if (!childProfileLoaded) enabledActivities = new Set(defaultEnabledActivities);
    else return;
  }
  for (const button of activityButtons) {
    if (button === playButton) continue;
    button.hidden = !activityEnabled(String(button.dataset.activity || ""));
  }
  if (drawingBoard?.isOpen && !activityEnabled("drawing")) drawingBoard.close();
  if (chessBoard?.isOpen && !activityEnabled("game")) chessBoard.close();
  if (musicStudio?.opened && !activityEnabled("music")) musicStudio.close();
  const activityRow = document.querySelector(".activity-row");
  const playableChoiceAvailable = activityButtons.some((button) => button !== playButton
    && button.dataset.activity !== "drawing" && button.dataset.activity !== "story" && !button.hidden);
  if (playButton) playButton.hidden = !playableChoiceAvailable;
  if (!playableChoiceAvailable && playChoices) {
    playChoices.hidden = true;
    playButton?.setAttribute("aria-expanded", "false");
  }
  if (activityRow) activityRow.hidden = activityButtons
    .filter((button) => button === playButton || button.dataset.activity === "drawing" || button.dataset.activity === "story")
    .every((button) => button.hidden);
  captureButton.hidden = !activityEnabled("vision_photo");
  recordVideoButton.hidden = !activityEnabled("vision_video");
  const visionEnabled = activityEnabled("vision_photo") || activityEnabled("vision_video");
  cameraButton.hidden = !visionEnabled;
  cameraToolbar.hidden = !visionEnabled;
  if (!visionEnabled) {
    captureState.textContent = "画面活动已由爸爸关闭";
    cameraStatus.textContent = "今天只用声音交流";
  }
  setCameraActionState(Boolean(cameraStream?.active));
}

function setCameraActionState(open) {
  captureButton.disabled = !activityEnabled("vision_photo");
  recordVideoButton.disabled = !activityEnabled("vision_video") || !open || !window.MediaRecorder;
  if (!videoRecorder || videoRecorder.state !== "recording") {
    setVideoRecordingVisual(false);
    recordVideoButton.title = "录一小段给爸爸看";
    recordVideoButton.setAttribute("aria-label", "录一小段给爸爸看");
  }
  cameraButton.dataset.open = String(open);
  cameraButton.setAttribute("aria-pressed", String(open));
  if (cameraState) cameraState.textContent = open ? "开" : "关";
  cameraButton.title = open ? "关闭摄像头" : "打开摄像头";
  cameraButton.setAttribute("aria-label", open ? "关闭摄像头" : "打开摄像头");
}

async function ensureCameraStream() {
  if (!activityEnabled("vision_photo") && !activityEnabled("vision_video")) {
    throw new Error("爸爸暂时关闭了画面活动，我们可以继续说话");
  }
  if (cameraStream?.active) return cameraStream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持摄像头");
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 400 }, facingMode: "user" },
    audio: false,
  });
  cameraVideo.srcObject = cameraStream;
  await cameraVideo.play().catch(() => {});
  setCameraActionState(true);
  cameraStatus.textContent = "可以看到自己了";
  return cameraStream;
}

cameraButton.addEventListener("click", async () => {
  try {
    if (cameraStream?.active) {
      stopCameraStream();
    } else {
      await ensureCameraStream();
    }
  } catch (error) {
    cameraStatus.textContent = `摄像头没有打开：${error.message}`;
  }
});

function stopCameraStream() {
  stopVideoRecording(true);
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  cameraVideo.srcObject = null;
  setCameraActionState(false);
  cameraStatus.textContent = "摄像头已关好";
}

function blobFromCanvas(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
}

async function makeFrameBlob() {
  if (!cameraStream?.active) await ensureCameraStream();
  if (cameraVideo.readyState < 2 || !cameraVideo.videoWidth) {
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        cameraVideo.removeEventListener("loadeddata", finish);
        cameraVideo.removeEventListener("canplay", finish);
        resolve();
      };
      const timeout = setTimeout(finish, 1800);
      cameraVideo.addEventListener("loadeddata", finish, { once: true });
      cameraVideo.addEventListener("canplay", finish, { once: true });
    });
  }
  if (!cameraStream?.active || cameraVideo.readyState < 2) throw new Error("摄像头画面还没有准备好");
  captureCanvas.width = cameraVideo.videoWidth || 640;
  captureCanvas.height = cameraVideo.videoHeight || 400;
  const context = captureCanvas.getContext("2d");
  context.save();
  context.translate(captureCanvas.width, 0);
  context.scale(-1, 1);
  context.drawImage(cameraVideo, 0, 0, captureCanvas.width, captureCanvas.height);
  context.restore();
  const blob = await blobFromCanvas(captureCanvas);
  if (!blob) throw new Error("截取失败");
  return blob;
}

async function capture_frame() {
  if (!activityEnabled("vision_photo")) throw new Error("爸爸暂时关闭了拍照活动");
  const blob = await makeFrameBlob();
  if (capturedUrl) URL.revokeObjectURL(capturedUrl);
  capturedUrl = URL.createObjectURL(blob);
  capturedFrame.src = capturedUrl;
  capturedFrame.hidden = false;
  capturedBlob = blob;
  const response = await fetch("/api/camera/capture", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || "截取失败");
  captureState.textContent = "照片已准备";
  cameraStatus.textContent = "照片准备好了";
  return payload;
}

async function visionRequest(endpoint, label) {
  if (!capturedBlob) throw new Error("请先截取一帧");
  visionResult.hidden = false;
  visionResult.textContent = `${label}…`;
  captureButton.disabled = true;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": capturedBlob.type || "image/jpeg" },
      body: capturedBlob,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || "AI Station Vision 暂时没有回应");
    visionResult.textContent = payload.description || "Vision 没有返回描述";
    cameraStatus.textContent = `${label}完成；图片未保存`;
    return payload;
  } finally {
    captureButton.disabled = false;
  }
}

window.capture_frame = capture_frame;
window.describe_frame = () => visionRequest("/api/vision/describe-frame", "爸爸正在看");
window.observe_child = () => visionRequest("/api/vision/observe-child", "爸爸正在观察");

captureButton.addEventListener("click", async () => {
  try {
    await prepareStreamingAudio();
    await interruptActiveReply();
    await capture_frame();
    const result = await sendStreamingRequest({
      endpoint: "/api/conversation/frame/stream",
      body: capturedBlob,
      continuous: conversationActive,
    });
    captureState.textContent = result.ok ? "爸爸看到了照片" : "照片还在，可以再给爸爸看";
    if (result.busy) cameraStatus.textContent = "爸爸老师正在结束上一句话，请再点一下照片";
    else if (result.error) cameraStatus.textContent = result.error;
  } catch (error) {
    cameraStatus.textContent = error.message;
    visionResult.hidden = false;
    visionResult.textContent = error.message;
  }
});

function supportedVideoMimeType() {
  if (!window.MediaRecorder) return "";
  return [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

function setVideoRecordingVisual(recording, elapsedMs = 0) {
  if (recording) recordVideoButton.classList.add("recording");
  else recordVideoButton.classList.remove("recording");
  const progress = recording ? Math.min(100, Math.round((elapsedMs / MANUAL_VIDEO_MAX_MS) * 100)) : 0;
  recordVideoButton.style?.setProperty("--record-progress", String(progress));
  if (typeof recordProgress !== "undefined" && recordProgress) recordProgress.style.setProperty("--record-progress", String(progress));
}

async function startVideoRecording() {
  if (!activityEnabled("vision_video")) throw new Error("爸爸暂时关闭了短视频活动");
  if (!window.MediaRecorder) throw new Error("当前浏览器不支持短视频录制");
  stopVideoRecording(true);
  const generation = videoRecordingGeneration;
  const isCurrent = () => generation === videoRecordingGeneration;
  await ensureCameraStream();
  if (!isCurrent()) return;
  if (!cameraStream?.active) throw new Error("请先打开摄像头");
  const mimeType = supportedVideoMimeType();
  const chunks = [];
  videoChunks = chunks;
  const recorder = new MediaRecorder(cameraStream, mimeType ? { mimeType } : undefined);
  videoRecorder = recorder;
  let recordingFailed = false;
  recorder.ondataavailable = (event) => {
    if (isCurrent() && event.data?.size) chunks.push(event.data);
  };
  recorder.onerror = () => {
    recordingFailed = true;
    if (!isCurrent()) return;
    visionResult.hidden = false;
    visionResult.textContent = "短视频录制失败";
  };
  recorder.onstop = async () => {
    if (!isCurrent()) return;
    clearTimeout(videoStopTimer);
    videoStopTimer = null;
    const clip = new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" });
    chunks.length = 0;
    videoChunks = [];
    videoRecorder = null;
    setVideoRecordingVisual(false);
    setCameraActionState(Boolean(cameraStream?.active));
    if (recordingFailed) {
      cameraStatus.textContent = "短视频录制失败，请再试一次";
      return;
    }
    if (!clip.size) {
      cameraStatus.textContent = "没有录到画面";
      return;
    }
    visionResult.hidden = false;
    visionResult.textContent = "爸爸正在看这段动作…";
    cameraStatus.textContent = "视频已录好，准备给爸爸看";
    recordVideoButton.disabled = true;
    const controller = new AbortController();
    videoRequestController = controller;
    let submitted = false;
    try {
      // A completed, explicitly requested clip takes precedence over the old
      // voice reply. Reuse its cancellation/receipt path before sending media.
      await interruptActiveReply();
      if (!isCurrent() || controller.signal.aborted) return;
      const form = new FormData();
      form.append("video", clip, "child-action.webm");
      cameraStatus.textContent = "短视频已发送，正在分析";
      submitted = true;
      const result = await sendStreamingRequest({ endpoint: "/api/conversation/video/stream", body: form,
        source: "video", signal: controller.signal });
      if (!isCurrent() || controller.signal.aborted) return;
      if (result?.aborted || result?.interrupted) {
        cameraStatus.textContent = "这段视频的回答已停止";
        visionResult.textContent = "可以继续说话，或者再录一段";
        return;
      }
      if (result?.busy) {
        submitted = false;
        throw new Error("上一句话还在结束，这段视频没有发送，请再录一次");
      }
      if (!result?.ok) throw new Error(result?.error || "短视频分析失败");
      captureState.textContent = "爸爸看到了动作";
      cameraStatus.textContent = "爸爸正在回答 · 原片未保存";
    } catch (error) {
      if (!isCurrent() || controller.signal.aborted) return;
      visionResult.textContent = error.message || "短视频分析失败";
      cameraStatus.textContent = submitted ? "短视频分析失败" : "视频还没有发送";
    } finally {
      if (videoRequestController === controller) videoRequestController = null;
      if (isCurrent()) setCameraActionState(Boolean(cameraStream?.active));
    }
  };
  recorder.start(250);
  const recordingStartedAt = Date.now();
  setVideoRecordingVisual(true, 0);
  recordVideoButton.title = "停止录制并给爸爸看";
  recordVideoButton.setAttribute("aria-label", "停止录制并给爸爸看");
  cameraStatus.textContent = "正在录制 · 最长6秒";
  if (typeof clearInterval === "function") clearInterval(videoProgressTimer);
  if (typeof setInterval === "function") {
    videoProgressTimer = setInterval(() => setVideoRecordingVisual(true, Date.now() - recordingStartedAt), 100);
  }
  videoStopTimer = setTimeout(stopVideoRecording, MANUAL_VIDEO_MAX_MS);
}

function stopVideoRecording(discard = false) {
  clearTimeout(videoStopTimer);
  videoStopTimer = null;
  if (typeof clearInterval === "function") clearInterval(videoProgressTimer);
  videoProgressTimer = null;
  const recorder = videoRecorder;
  if (discard) {
    videoRecordingGeneration++;
    videoRequestController?.abort();
    videoRequestController = null;
    videoChunks.length = 0;
    videoRecorder = null;
    setVideoRecordingVisual(false);
    setCameraActionState(Boolean(cameraStream?.active));
  }
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

recordVideoButton.addEventListener("click", async () => {
  if (videoRecorder?.state === "recording") {
    stopVideoRecording();
    return;
  }
  try {
    await startVideoRecording();
  } catch (error) {
    cameraStatus.textContent = error.message || "短视频录制失败";
  }
});

setCameraActionState(false);

function initializeInteractionClock() {
  const clock = new globalThis.InteractionClock({
    send: (payload) => globalThis.familyInteractionTimingSupported ? fetch("/api/conversation/interaction-interval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }) : Promise.resolve(),
  });
  globalThis.familyInteractionClock = clock;
  clock.setVisible(!document.hidden);
  let timer = null;
  const stopTicker = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  const startTicker = () => {
    if (timer === null && !document.hidden) timer = window.setInterval(() => clock.tick(), 1000);
  };
  document.addEventListener("visibilitychange", () => {
    clock.setVisible(!document.hidden);
    if (document.hidden) stopTicker();
    else startTicker();
  });
  window.addEventListener("pagehide", () => { clock.end(); stopTicker(); });
  window.addEventListener("pageshow", () => { clock.setVisible(!document.hidden); startTicker(); });
  startTicker();
}

async function checkHealth() {
  const mayUpdateIdle = () => !conversationActive && !conversationStarting && !activeRequestController;
  try {
    const response = await fetch("/health");
    const payload = await response.json();
    if (!response.ok) throw new Error("本地服务不可用");
    globalThis.familyInteractionTimingSupported = payload.interaction_timing_supported === true;
    setAvatarIdleAvailable(payload.avatar_idle_ready === true);
    const localReady = payload.stt_ready && payload.tts_ready;
    const configured = payload.llm_configured && localReady;
    if (Number.isFinite(Number(payload.avatar_audio_lead_ms))) {
      avatarAudioLeadMs = Math.max(0, Math.min(1500, Number(payload.avatar_audio_lead_ms)));
    }
    const warming = payload.tts_warmup === "warming";
    const voiceUncertain = ["failed", "retry_wait", "retrying"].includes(payload.tts_warmup);
    serviceBadge.textContent = warming
      ? "正在准备声音"
      : voiceUncertain
        ? "声音还没准备好，可以试着说话"
        : configured
        ? "准备好了"
        : localReady ? "本地活动可以玩" : "需要家长设置";
    serviceBadge.classList.toggle("ready", localReady && !warming && !voiceUncertain);
    serviceBadge.classList.toggle("warn", !localReady || warming || voiceUncertain);
    if (mayUpdateIdle()) setBusy(warming);
    if (mayUpdateIdle()) {
      setStatus(
        warming ? "正在准备声音" : voiceUncertain ? "声音准备遇到问题，可以试着说话" : configured ? "我在这里，可以开始说话" : localReady ? "我们可以先玩画画、故事和数字" : "请家长检查声音设置",
        warming ? "thinking" : voiceUncertain ? "offline" : localReady ? "idle" : "offline",
      );
    }
    if (warming || ["retry_wait", "retrying"].includes(payload.tts_warmup)) setTimeout(checkHealth, 1800);
  } catch (error) {
    serviceBadge.textContent = "服务未启动";
    serviceBadge.classList.add("warn");
    if (mayUpdateIdle()) {
      setStatus("请先启动本地服务", "offline");
      setBusy(true);
    }
    setTimeout(checkHealth, 1800);
  }
}

initializeAvatarIdle();
initializeInteractionClock();
checkHealth();
void loadHistory();
void loadChildProfileControls();
const childProfileRefreshTimer = window.setInterval(() => {
  if (document.visibilityState === "visible") void loadChildProfileControls();
}, 8000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cancelMediaSuggestionLookup();
  if (document.visibilityState === "visible") void loadChildProfileControls();
});
window.addEventListener("pagehide", () => {
  cancelMediaSuggestionLookup();
  window.clearInterval(childProfileRefreshTimer);
}, { once: true });
connectAvatar();
