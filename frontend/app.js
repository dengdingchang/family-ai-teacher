const statusText = document.querySelector("#statusText");
const serviceBadge = document.querySelector("#serviceBadge");
const recordButton = document.querySelector("#recordButton");
const recordLabel = document.querySelector("#recordLabel");
const recordHint = document.querySelector("#recordHint");
const userTextBox = document.querySelector("#userTextBox");
const answerBox = document.querySelector("#answerBox");
const textForm = document.querySelector("#textForm");
const textInput = document.querySelector("#textInput");
const avatarStage = document.querySelector("#avatarStage");
const mouth = document.querySelector("#mouth");
const dot = document.querySelector(".dot");

let recordingStream = null;
let audioContext = null;
let activeAudio = null;
let activeAudioUrl = null;
let analyser = null;
let mouthFrame = null;
let mouthEnergy = 0;
let audioQueue = [];
let queueDraining = false;
let queueGeneration = 0;
let queueDrainWaiters = [];
let activePlayback = null;

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

const VAD_INTERVAL_MS = 80;
const VAD_START_RMS = 0.045;
const VAD_STOP_RMS = 0.028;
const VAD_START_HOLD_MS = 140;
const VAD_SILENCE_MS = 850;
const VAD_MAX_SEGMENT_MS = 12000;

const avatarImage = document.querySelector("#avatarImage");
function classifyAvatarImage() {
  avatarStage.classList.toggle("portrait-photo", avatarImage.naturalHeight > avatarImage.naturalWidth * 1.1);
}
if (avatarImage.complete) classifyAvatarImage();
avatarImage.addEventListener("load", classifyAvatarImage);

function setStatus(message, state = "") {
  statusText.textContent = message;
  dot.classList.toggle("live", state === "live");
}

function setBusy(busy) {
  recordButton.disabled = busy && !conversationActive;
  textForm.querySelector("button").disabled = busy;
  textInput.disabled = busy;
}

function setMouth(state) {
  mouth.classList.remove("mouth-closed", "mouth-half", "mouth-open");
  mouth.classList.add(`mouth-${state}`);
}

function stopMouthLoop() {
  if (mouthFrame) cancelAnimationFrame(mouthFrame);
  mouthFrame = null;
  mouthEnergy = 0;
  avatarStage.classList.remove("speaking");
  setMouth("closed");
}

function updateMouth() {
  if (!analyser || !activeAudio || activeAudio.paused || activeAudio.ended) {
    stopMouthLoop();
    return;
  }
  const timeData = new Uint8Array(analyser.fftSize);
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(timeData);
  analyser.getByteFrequencyData(freqData);
  let square = 0;
  for (const value of timeData) {
    const centered = (value - 128) / 128;
    square += centered * centered;
  }
  const rms = Math.sqrt(square / timeData.length);
  let sum = 0;
  for (const value of freqData) sum += value;
  const frequencyEnergy = freqData.length ? sum / freqData.length / 255 : 0;
  const energy = rms * 1.7 + frequencyEnergy * 0.45;
  mouthEnergy = mouthEnergy * 0.62 + energy * 0.38;
  setMouth(mouthEnergy >= 0.14 ? "open" : mouthEnergy >= 0.045 ? "half" : "closed");
  avatarStage.classList.add("speaking");
  mouthFrame = requestAnimationFrame(updateMouth);
}

function resolveQueueWaiters() {
  if (queueDraining || audioQueue.length) return;
  const waiters = queueDrainWaiters;
  queueDrainWaiters = [];
  for (const resolve of waiters) resolve();
}

function waitForAudioQueue() {
  if (!queueDraining && !audioQueue.length) return Promise.resolve();
  return new Promise((resolve) => queueDrainWaiters.push(resolve));
}

function clearResponseQueue() {
  audioQueue = [];
  queueGeneration += 1;
  resolveQueueWaiters();
}

function cancelPlayback() {
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
  analyser = null;
  stopMouthLoop();
}

async function playAudioPayload(payload) {
  const binary = atob(payload.audio_base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const blob = new Blob([bytes], { type: payload.audio_mime || "audio/wav" });
  activeAudioUrl = URL.createObjectURL(blob);
  const audio = new Audio(activeAudioUrl);
  activeAudio = audio;
  audioContext = audioContext || new AudioContext();
  await audioContext.resume();
  const source = audioContext.createMediaElementSource(audio);
  const outputAnalyser = audioContext.createAnalyser();
  analyser = outputAnalyser;
  outputAnalyser.fftSize = 256;
  source.connect(outputAnalyser);
  outputAnalyser.connect(audioContext.destination);
  const activeAudioUrlForPlayback = activeAudioUrl;
  const playbackPromise = new Promise((resolve, reject) => {
    let settled = false;
    const onEnded = () => finish();
    const onError = () => finish(new Error("audio playback failed"));
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      try { source.disconnect(); } catch (_) { /* already disconnected */ }
      try { outputAnalyser.disconnect(); } catch (_) { /* already disconnected */ }
      if (analyser === outputAnalyser) analyser = null;
      if (activeAudio === audio) activeAudio = null;
      if (activeAudioUrl === activeAudioUrlForPlayback) {
        URL.revokeObjectURL(activeAudioUrlForPlayback);
        activeAudioUrl = null;
      }
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (activePlayback?.audio === audio) activePlayback = null;
      stopMouthLoop();
      if (error) reject(error);
      else resolve();
    };
    activePlayback = { audio, finish };
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.play().then(updateMouth).catch(finish);
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
        await playAudioPayload(payload);
      } catch (_) {
        // A browser playback error should not strand the continuous listener.
      }
    }
  } finally {
    queueDraining = false;
    resolveQueueWaiters();
    if (audioQueue.length) void drainResponseQueue();
  }
}

function enqueueAudio(payload) {
  audioQueue.push(payload);
  void drainResponseQueue();
}

async function playResponse(payload) {
  clearResponseQueue();
  cancelPlayback();
  enqueueAudio(payload);
  await waitForAudioQueue();
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

async function sendStreamingRequest({ endpoint, body, continuous = false }) {
  setBusy(true);
  setStatus("正在听清楚你说的话…");
  answerBox.classList.remove("has-answer");
  answerBox.innerHTML = '<span class="answer-label">爸爸老师正在准备回答…</span>';
  clearResponseQueue();
  cancelPlayback();
  const controller = new AbortController();
  activeRequestController = controller;
  let assistantText = "";
  let streamError = null;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: body instanceof FormData
        ? undefined
        : body instanceof Blob
          ? { "Content-Type": body.type || "image/jpeg" }
          : { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    await consumeSse(response, (event) => {
      if (event.event === "user_text") {
        if (userTextBox) userTextBox.textContent = event.text || "刚刚说了一句话";
      } else if (event.event === "assistant_delta") {
        assistantText += event.text || "";
        answerBox.classList.add("has-answer");
        answerBox.textContent = assistantText;
        setStatus("爸爸老师正在想一想…", "live");
      } else if (event.event === "audio") {
        setStatus("爸爸老师正在说话…", "live");
        enqueueAudio(event);
      } else if (event.event === "vision_context") {
        setStatus("爸爸老师看到了刚才的画面…", "live");
        if (visionResult) {
          visionResult.hidden = false;
          visionResult.textContent = event.description || "爸爸看到了刚才的画面";
        }
      } else if (event.event === "done") {
        assistantText = event.assistant_text || assistantText;
        if (assistantText) {
          answerBox.classList.add("has-answer");
          answerBox.textContent = assistantText;
        }
        if (event.ok === false) streamError = streamError || "回答没有完整生成";
      } else if (event.event === "error") {
        streamError = event.message || "本地服务暂时没有回应";
      }
    });
    await waitForAudioQueue();
    if (streamError) throw new Error(streamError);
    if (!assistantText) throw new Error("爸爸老师没有返回文字回答");
    if (continuous && conversationActive) beginContinuousSegment();
    else setStatus("回答完成", "live");
    return { ok: true, assistantText };
  } catch (error) {
    if (error.name === "AbortError" && !conversationActive) return { ok: false, aborted: true };
    const message = error.message || "本地服务暂时没有回应";
    setStatus("还没有准备好", "");
    answerBox.classList.add("has-answer");
    answerBox.textContent = message;
    if (continuous && conversationActive) beginContinuousSegment();
    return { ok: false, error: message };
  } finally {
    if (activeRequestController === controller) activeRequestController = null;
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
  const frame = continuous && shouldAttachAutomaticFrame() ? automaticFrameBlob : null;
  if (frame) {
    form.append("frame", frame, "child-frame.jpg");
    automaticFrameBlob = null;
    automaticFrameAt = 0;
  }
  await sendStreamingRequest({ endpoint: "/api/conversation/stream", body: form, continuous });
}

function stopVadLoop() {
  if (vadTimer) clearTimeout(vadTimer);
  vadTimer = null;
  loudSince = 0;
  lastVoiceAt = 0;
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

function beginContinuousSegment() {
  if (!conversationActive || !recordingStream || segmentRecording) return;
  segmentPcmChunks = [];
  segmentRecording = true;
  segmentShouldSend = false;
  speechStartedAt = 0;
  recordHint.textContent = "我会一直听；说完停一下，爸爸老师会回答。";
  setStatus("我在听，请说话…", "live");
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
  if (shouldSend) setStatus("听到了，正在准备回答…");
  const blob = pcmToWav(chunks, inputSampleRate);
  void sendAudio(blob, true);
}

function releaseInputStream() {
  stopVadLoop();
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
      if (!conversationActive || !segmentRecording) return;
      segmentPcmChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    inputSource.connect(inputProcessor);
    inputProcessor.connect(inputMuteGain);
    inputMuteGain.connect(audioContext.destination);
    conversationActive = true;
    try {
      await ensureCameraStream();
    } catch (error) {
      cameraStatus.textContent = `摄像头未打开：${error.message}`;
    }
    startAutomaticFrameTimer();
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
  recordLabel.textContent = "结束持续交流";
}

function stopContinuousConversation() {
  conversationActive = false;
  segmentShouldSend = false;
  stopAutomaticFrameTimer();
  activeRequestController?.abort();
  releaseInputStream();
  clearResponseQueue();
  cancelPlayback();
  recordButton.classList.remove("recording");
  recordButton.setAttribute("aria-pressed", "false");
  recordLabel.textContent = "点一下开始交流";
  recordHint.textContent = "已结束；点一下可以重新开始持续交流。";
  setStatus("交流已结束", "");
}

recordButton.addEventListener("click", async () => {
  if (conversationActive) {
    stopContinuousConversation();
    return;
  }
  try {
    await startContinuousConversation();
  } catch (error) {
    setStatus("麦克风没有打开", "");
    recordHint.textContent = error.message;
  }
});

textForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = textInput.value;
  textInput.value = "";
  await sendText(text);
});

const cameraVideo = document.querySelector("#cameraVideo");
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
let automaticFrameBlob = null;
let automaticFrameAt = 0;
let automaticFrameTimer = null;
let videoRecorder = null;
let videoChunks = [];
let videoStopTimer = null;
const AUTOMATIC_FRAME_INTERVAL_MS = 15000;
const MANUAL_VIDEO_MAX_MS = 6000;

function setCameraActionState(open) {
  captureButton.disabled = false;
  recordVideoButton.disabled = !open || !window.MediaRecorder;
  if (!videoRecorder || videoRecorder.state !== "recording") {
    recordVideoButton.textContent = "🎥";
    recordVideoButton.title = "录一小段给爸爸看";
    recordVideoButton.setAttribute("aria-label", "录一小段给爸爸看");
  }
  cameraButton.textContent = open ? "⏹" : "📹";
  cameraButton.title = open ? "关闭摄像头" : "打开摄像头";
  cameraButton.setAttribute("aria-label", open ? "关闭摄像头" : "打开摄像头");
}

async function ensureCameraStream() {
  if (cameraStream?.active) return cameraStream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持摄像头");
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 400 }, facingMode: "user" },
    audio: false,
  });
  cameraVideo.srcObject = cameraStream;
  await cameraVideo.play().catch(() => {});
  setCameraActionState(true);
  cameraStatus.textContent = "摄像头已打开";
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
  cameraStatus.textContent = "摄像头已关闭";
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

async function prepareAutomaticFrame() {
  if (!conversationActive || !cameraStream?.active) return;
  try {
    automaticFrameBlob = await makeFrameBlob();
    automaticFrameAt = Date.now();
    cameraStatus.textContent = "自动准备了一帧 · 尚未上传";
  } catch (error) {
    cameraStatus.textContent = `自动取帧未完成：${error.message}`;
  }
}

function startAutomaticFrameTimer() {
  stopAutomaticFrameTimer();
  automaticFrameTimer = setInterval(prepareAutomaticFrame, AUTOMATIC_FRAME_INTERVAL_MS);
  void prepareAutomaticFrame();
}

function stopAutomaticFrameTimer() {
  if (automaticFrameTimer) clearInterval(automaticFrameTimer);
  automaticFrameTimer = null;
  automaticFrameBlob = null;
  automaticFrameAt = 0;
}

function shouldAttachAutomaticFrame() {
  return Boolean(
    conversationActive &&
    automaticFrameBlob &&
    automaticFrameAt &&
    Date.now() - automaticFrameAt <= AUTOMATIC_FRAME_INTERVAL_MS * 1.5,
  );
}

async function capture_frame() {
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
  cameraStatus.textContent = `已拍照 ${payload.bytes} bytes`;
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
    recordVideoButton.textContent = "🎥";
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
  recordVideoButton.textContent = "⏹";
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
  try {
    const response = await fetch("/health");
    const payload = await response.json();
    if (!response.ok) throw new Error("本地服务不可用");
    const configured = payload.llm_configured && payload.stt_ready && payload.tts_ready;
    serviceBadge.textContent = configured ? "本地能力已就绪" : "还需配置 AI Station";
    serviceBadge.classList.toggle("ready", configured);
    serviceBadge.classList.toggle("warn", !configured);
    setStatus(configured ? "可以开始说话" : "请先在 .env 配置 AI Station", configured ? "live" : "");
  } catch (error) {
    serviceBadge.textContent = "服务未启动";
    serviceBadge.classList.add("warn");
    setStatus("请先启动本地服务", "");
  }
}

checkHealth();
