import "/pcm-player.js?v=20260906-stream1";
import "/voice-activity.js?v=20260906-1";

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
const defaultEnabledActivities = ["drawing", "story", "game", "music", "vision_photo", "vision_video"];
let enabledActivities = new Set(defaultEnabledActivities);
let childProfileLoaded = false;

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
let interruptedRequestController = null;
let activeTurnId = null;
let bargeInTimer = null;
let bargeInMonitoring = false;
let bargeInPcmChunks = [];

const VAD_INTERVAL_MS = 80;
const VAD_START_RMS = 0.045;
const VAD_STOP_RMS = 0.028;
const VAD_START_HOLD_MS = 140;
const VAD_SILENCE_MS = 850;
const VAD_MAX_SEGMENT_MS = 12000;
const BARGE_IN_START_RMS = 0.075;
const BARGE_IN_HOLD_MS = 260;
const BARGE_IN_PREROLL_CHUNKS = 6;
// A measured relay path adds about 0.5 s round-trip latency. Keep this wait
// bounded, while allowing its first decodable video packet to arrive.
const STREAM_AVATAR_FIRST_FRAME_WAIT_MS = 2000;
const bargeInGate = new globalThis.BargeInGate({
  threshold: BARGE_IN_START_RMS,
  voicedMs: BARGE_IN_HOLD_MS,
  sampleMs: VAD_INTERVAL_MS,
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

function renderHistory() {
  if (!chatHistory) return;
  chatHistory.replaceChildren();
  const visibleRecords = historyRecords.filter((record) => (
    String(record?.user_text || "").trim() || String(record?.assistant_text || "").trim()
  ));
  if (!visibleRecords.length) {
    chatEmpty.hidden = false;
    chatEmpty.textContent = "还没有对话，先和爸爸老师说一句吧。";
    chatHistory.append(chatEmpty);
    return;
  }
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
  liveTurn.hidden = false;
  userTextBox.textContent = "正在听你说…";
  answerBox.classList.remove("has-answer");
  answerBox.innerHTML = '<span class="answer-label">正在想一个好玩的教法…</span>';
}

function hideLiveTurn() {
  liveTurn.hidden = true;
}

function setStatus(message, state = "idle") {
  statusText.textContent = message;
  const visualState = ["idle", "listening", "thinking", "speaking", "offline"].includes(state) ? state : "idle";
  if (avatarStage) avatarStage.dataset.state = visualState;
  dot.classList.toggle("live", visualState !== "offline");
  syncAvatarIdle(visualState);
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
  avatarReducedMotion.addEventListener("change", () => syncAvatarIdle());
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
  avatarPumpTimer = setTimeout(pumpAvatarVideo, 40);
}

function queueEncodedAvatarFrame(frame) {
  if (!avatarAcceptFrames) return;
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
  avatarEncodedQueue = [];
  avatarNeedsKeyframe = true;
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
  if (shouldSynchronizeAvatar && !frameSynchronized) {
    flushAvatar();
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
    const onEnded = () => finish();
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
    audio.play().catch(finish);
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
          session.avatarEnabled = false;
          flushAvatar();
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
        window.dispatchEvent(new CustomEvent("family-audio-playback", {
          detail: { ...detail, generation, transport: "web-audio" },
        }));
      },
    });
    session.finishInput = beginSync;
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

async function sendStreamingRequest({ endpoint, body, continuous = false }) {
  if (activeRequestController) return { ok: false, busy: true };
  setBusy(true);
  setStatus("正在听清楚你说的话…", "thinking");
  resetLiveTurn();
  clearResponseQueue();
  cancelPlayback();
  const playbackGeneration = queueGeneration;
  const controller = new AbortController();
  const turnId = createConversationTurnId();
  activeRequestController = controller;
  activeTurnId = turnId;
  if (continuous) startBargeInMonitor();
  let assistantText = "";
  let streamError = null;
  let commitRequired = false;
  let turnCommitted = false;
  let receivedDone = false;
  try {
    const audioStreaming = typeof prepareStreamingAudio === "function" && await prepareStreamingAudio();
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
        if (controller.signal.aborted) return;
        if (event.event === "vision_request") {
          observationRequest = event.text || "";
        } else if (event.event === "user_text") {
          if (userTextBox) userTextBox.textContent = event.text || "刚刚说了一句话";
        } else if (event.event === "assistant_delta") {
          assistantText += event.text || "";
          answerBox.classList.add("has-answer");
          answerBox.textContent = assistantText;
          setStatus("爸爸老师正在想一想…", "thinking");
        } else if (event.event === "audio") {
          setStatus(
            avatarReady ? "爸爸老师正在说话…" : "爸爸老师正在说话 · 动作暂时离线",
            "speaking",
          );
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
          if (assistantText) {
            answerBox.classList.add("has-answer");
            answerBox.textContent = assistantText;
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
      if (!controller.signal.aborted && activityEnabled("vision_photo")) {
        setStatus("你请爸爸看，现在拍一张…", "thinking");
        captureState.textContent = "按你刚才的请求，拍一张";
        try {
          const frame = await makeFrameBlob();
          if (!controller.signal.aborted) observed.append("frame", frame, "requested-frame.jpg");
        } catch (_) {
          cameraStatus.textContent = "这次没打开画面，我们继续说话";
        }
      }
      if (controller.signal.aborted) throw new DOMException("已取消", "AbortError");
      endpoint = "/api/conversation/stream";
      body = observed;
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
      if (interruptedRequestController === controller) {
        return { ok: false, interrupted: true };
      }
      if (completion.history) appendHistoryRecord(completion.history);
      turnCommitted = true;
    }
    hideLiveTurn();
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
    if (activeRequestController === controller) activeRequestController = null;
    if (interruptedRequestController === controller) interruptedRequestController = null;
    if (activeTurnId === turnId) activeTurnId = null;
    setBusy(false);
  }
}

async function sendText(text) {
  const clean = text.trim();
  if (!clean) return;
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
  await sendStreamingRequest({ endpoint: "/api/conversation/stream", body: form, continuous });
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
  bargeInTimer = setTimeout(checkBargeIn, VAD_INTERVAL_MS);
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
  if (!speechStartedAt && segmentPcmChunks.length > 120) segmentPcmChunks = [];
  scheduleVad();
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
      } else if (bargeInMonitoring) {
        bargeInPcmChunks.push(chunk);
        if (bargeInPcmChunks.length > BARGE_IN_PREROLL_CHUNKS) bargeInPcmChunks.shift();
      }
    };
    inputSource.connect(inputProcessor);
    inputProcessor.connect(inputMuteGain);
    inputMuteGain.connect(audioContext.destination);
    conversationActive = true;
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

for (const button of activityButtons) {
  button.addEventListener("click", async () => {
    if (conversationActive) stopContinuousConversation();
    await sendText(String(button.dataset.prompt || ""));
  });
}

const cameraVideo = document.querySelector("#cameraVideo");
const cameraToolbar = document.querySelector("#cameraToolbar");
const cameraButton = document.querySelector("#cameraButton");
const captureButton = document.querySelector("#captureButton");
const recordVideoButton = document.querySelector("#recordVideoButton");
const cameraStatus = document.querySelector("#cameraStatus");
const captureState = document.querySelector("#captureState");
const captureCanvas = document.querySelector("#captureCanvas");
const capturedFrame = document.querySelector("#capturedFrame");
const visionResult = document.querySelector("#visionResult");
let cameraStream = null;
let capturedUrl = null;
let capturedBlob = null;
let videoRecorder = null;
let videoChunks = [];
let videoStopTimer = null;
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
    button.hidden = !activityEnabled(String(button.dataset.activity || ""));
  }
  const activityRow = document.querySelector(".activity-row");
  if (activityRow) activityRow.hidden = activityButtons.every((button) => button.hidden);
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
    recordVideoButton.textContent = "▷";
    recordVideoButton.title = "录一小段给爸爸看";
    recordVideoButton.setAttribute("aria-label", "录一小段给爸爸看");
  }
  cameraButton.textContent = open ? "■" : "◉";
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
  stopVideoRecording();
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
    await capture_frame();
    await sendStreamingRequest({
      endpoint: "/api/conversation/frame/stream",
      body: capturedBlob,
    });
    captureState.textContent = "爸爸看到了照片";
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

async function startVideoRecording() {
  if (!activityEnabled("vision_video")) throw new Error("爸爸暂时关闭了短视频活动");
  if (!window.MediaRecorder) throw new Error("当前浏览器不支持短视频录制");
  await ensureCameraStream();
  if (!cameraStream?.active) throw new Error("请先打开摄像头");
  const mimeType = supportedVideoMimeType();
  videoChunks = [];
  videoRecorder = new MediaRecorder(cameraStream, mimeType ? { mimeType } : undefined);
  videoRecorder.ondataavailable = (event) => {
    if (event.data?.size) videoChunks.push(event.data);
  };
  videoRecorder.onerror = () => {
    visionResult.hidden = false;
    visionResult.textContent = "短视频录制失败";
  };
  videoRecorder.onstop = async () => {
    clearTimeout(videoStopTimer);
    videoStopTimer = null;
    const clip = new Blob(videoChunks, { type: videoRecorder?.mimeType || mimeType || "video/webm" });
    videoChunks = [];
    videoRecorder = null;
    recordVideoButton.classList.remove("recording");
    recordVideoButton.textContent = "▷";
    setCameraActionState(Boolean(cameraStream?.active));
    if (!clip.size) {
      cameraStatus.textContent = "没有录到画面";
      return;
    }
    visionResult.hidden = false;
    visionResult.textContent = "爸爸正在看这段动作…";
    cameraStatus.textContent = "短视频已发送，正在分析";
    recordVideoButton.disabled = true;
    try {
      const form = new FormData();
      form.append("video", clip, "child-action.webm");
      const result = await sendStreamingRequest({ endpoint: "/api/conversation/video/stream", body: form });
      if (!result?.ok) throw new Error(result?.error || "短视频分析失败");
      captureState.textContent = "爸爸看到了动作";
      cameraStatus.textContent = "爸爸正在回答 · 原片未保存";
    } catch (error) {
      visionResult.textContent = error.message || "短视频分析失败";
      cameraStatus.textContent = "短视频分析失败";
    } finally {
      setCameraActionState(Boolean(cameraStream?.active));
    }
  };
  videoRecorder.start(250);
  recordVideoButton.classList.add("recording");
  recordVideoButton.textContent = "■";
  recordVideoButton.title = "停止录制并给爸爸看";
  recordVideoButton.setAttribute("aria-label", "停止录制并给爸爸看");
  cameraStatus.textContent = "正在录制 · 最长6秒";
  videoStopTimer = setTimeout(stopVideoRecording, MANUAL_VIDEO_MAX_MS);
}

function stopVideoRecording() {
  clearTimeout(videoStopTimer);
  videoStopTimer = null;
  if (videoRecorder && videoRecorder.state !== "inactive") videoRecorder.stop();
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

async function checkHealth() {
  const mayUpdateIdle = () => !conversationActive && !conversationStarting && !activeRequestController;
  try {
    const response = await fetch("/health");
    const payload = await response.json();
    if (!response.ok) throw new Error("本地服务不可用");
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
checkHealth();
void loadHistory();
void loadChildProfileControls();
const childProfileRefreshTimer = window.setInterval(() => {
  if (document.visibilityState === "visible") void loadChildProfileControls();
}, 8000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void loadChildProfileControls();
});
window.addEventListener("pagehide", () => window.clearInterval(childProfileRefreshTimer), { once: true });
connectAvatar();
