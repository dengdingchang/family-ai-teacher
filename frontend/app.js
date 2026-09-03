const statusText = document.querySelector("#statusText");
const serviceBadge = document.querySelector("#serviceBadge");
const recordButton = document.querySelector("#recordButton");
const recordLabel = document.querySelector("#recordLabel");
const recordHint = document.querySelector("#recordHint");
const answerBox = document.querySelector("#answerBox");
const textForm = document.querySelector("#textForm");
const textInput = document.querySelector("#textInput");
const avatarStage = document.querySelector("#avatarStage");
const mouth = document.querySelector("#mouth");
const dot = document.querySelector(".dot");

let mediaRecorder = null;
let recordingStream = null;
let recordingChunks = [];
let audioContext = null;
let activeAudio = null;
let activeAudioUrl = null;
let analyser = null;
let mouthFrame = null;
let mouthEnergy = 0;

let inputSource = null;
let inputAnalyser = null;
let vadTimer = null;
let conversationActive = false;
let conversationStarting = false;
let speechStartedAt = 0;
let lastVoiceAt = 0;
let loudSince = 0;
let segmentShouldSend = false;
let activeRequestController = null;
let playbackDone = null;

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

function cancelPlayback() {
  const resolve = playbackDone;
  playbackDone = null;
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
  if (resolve) resolve();
}

async function playResponse(payload) {
  cancelPlayback();
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
  const playbackPromise = new Promise((resolve) => {
    const finish = () => {
      if (playbackDone !== finish) return;
      playbackDone = null;
      audio.removeEventListener("ended", finish);
      audio.removeEventListener("error", finish);
      source.disconnect();
      outputAnalyser.disconnect();
      if (analyser === outputAnalyser) analyser = null;
      stopMouthLoop();
      if (activeAudio === audio) activeAudio = null;
      if (activeAudioUrl) {
        URL.revokeObjectURL(activeAudioUrl);
        activeAudioUrl = null;
      }
      resolve();
    };
    playbackDone = finish;
    audio.addEventListener("ended", finish, { once: true });
    audio.addEventListener("error", finish, { once: true });
  });
  try {
    await audio.play();
    updateMouth();
    await playbackPromise;
  } catch (error) {
    cancelPlayback();
    throw error;
  }
}

async function sendText(text) {
  const clean = text.trim();
  if (!clean) return;
  setBusy(true);
  setStatus("爸爸老师正在想一想…");
  answerBox.classList.remove("has-answer");
  answerBox.innerHTML = '<span class="answer-label">正在准备声音…</span>';
  try {
    const response = await fetch("/api/conversation/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "本地服务暂时没有回应");
    answerBox.classList.add("has-answer");
    answerBox.textContent = payload.assistant_text;
    setStatus("爸爸老师正在说话…", "live");
    await playResponse(payload);
    setStatus("回答完成", "live");
  } catch (error) {
    setStatus("还没有准备好", "");
    answerBox.classList.add("has-answer");
    answerBox.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function sendAudio(blob, continuous = false) {
  if (!blob?.size) return;
  setBusy(true);
  setStatus("正在听清楚你说的话…");
  const form = new FormData();
  form.append("audio", blob, "child-speech.webm");
  const controller = new AbortController();
  activeRequestController = controller;
  try {
    const response = await fetch("/api/conversation", { method: "POST", body: form, signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "没有听清楚，请再说一次");
    answerBox.classList.add("has-answer");
    answerBox.textContent = payload.assistant_text;
    setStatus("爸爸老师正在说话…", "live");
    await playResponse(payload);
    if (continuous && conversationActive) beginContinuousSegment();
  } catch (error) {
    if (error.name === "AbortError" && !conversationActive) return;
    setStatus("还没有准备好", "");
    answerBox.classList.add("has-answer");
    answerBox.textContent = error.message;
    if (continuous && conversationActive) beginContinuousSegment();
  } finally {
    if (activeRequestController === controller) activeRequestController = null;
    setBusy(false);
  }
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
  if (!conversationActive || !inputAnalyser || !mediaRecorder) return;
  if (vadTimer) clearTimeout(vadTimer);
  vadTimer = setTimeout(checkVoiceActivity, VAD_INTERVAL_MS);
}

function checkVoiceActivity() {
  if (!conversationActive || !inputAnalyser || !mediaRecorder) return;
  const now = performance.now();
  const rms = inputRms();
  if (rms >= VAD_START_RMS) {
    if (!loudSince) loudSince = now;
    lastVoiceAt = now;
    if (!speechStartedAt && now - loudSince >= VAD_START_HOLD_MS) {
      speechStartedAt = now;
      recordingChunks = [];
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
  if (!speechStartedAt && recordingChunks.length > 25) recordingChunks = [];
  scheduleVad();
}

function beginContinuousSegment() {
  if (!conversationActive || !recordingStream || mediaRecorder) return;
  const preferred = "audio/webm;codecs=opus";
  const mimeType = MediaRecorder.isTypeSupported(preferred) ? preferred : "audio/webm";
  recordingChunks = [];
  segmentShouldSend = false;
  speechStartedAt = 0;
  const recorder = new MediaRecorder(recordingStream, { mimeType });
  mediaRecorder = recorder;
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) recordingChunks.push(event.data);
  });
  recorder.addEventListener("stop", async () => {
    if (mediaRecorder === recorder) mediaRecorder = null;
    stopVadLoop();
    const chunks = recordingChunks;
    recordingChunks = [];
    const shouldSend = segmentShouldSend;
    segmentShouldSend = false;
    speechStartedAt = 0;
    if (!conversationActive || !shouldSend) {
      if (conversationActive) beginContinuousSegment();
      return;
    }
    const blob = new Blob(chunks, { type: mimeType });
    await sendAudio(blob, true);
  }, { once: true });
  recorder.start(100);
  recordHint.textContent = "我会一直听；说完停一下，爸爸老师会回答。";
  setStatus("我在听，请说话…", "live");
  scheduleVad();
}

function finishContinuousSegment() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  segmentShouldSend = Boolean(speechStartedAt);
  stopVadLoop();
  if (segmentShouldSend) setStatus("听到了，正在准备回答…");
  mediaRecorder.stop();
}

function releaseInputStream() {
  stopVadLoop();
  if (inputSource) {
    inputSource.disconnect();
    inputSource = null;
  }
  inputAnalyser = null;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    segmentShouldSend = false;
    try { mediaRecorder.stop(); } catch (_) { /* already stopping */ }
  }
  mediaRecorder = null;
  recordingChunks = [];
  recordingStream?.getTracks().forEach((track) => track.stop());
  recordingStream = null;
}

async function startContinuousConversation() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
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
    audioContext = audioContext || new AudioContext();
    await audioContext.resume();
    inputSource = audioContext.createMediaStreamSource(recordingStream);
    inputAnalyser = audioContext.createAnalyser();
    inputAnalyser.fftSize = 1024;
    inputAnalyser.smoothingTimeConstant = 0.2;
    inputSource.connect(inputAnalyser);
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
  recordLabel.textContent = "结束持续交流";
}

function stopContinuousConversation() {
  conversationActive = false;
  segmentShouldSend = false;
  activeRequestController?.abort();
  releaseInputStream();
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
const cameraStatus = document.querySelector("#cameraStatus");
const captureState = document.querySelector("#captureState");
const captureCanvas = document.querySelector("#captureCanvas");
const capturedFrame = document.querySelector("#capturedFrame");
let cameraStream = null;
let capturedUrl = null;

cameraButton.addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraStatus.textContent = "当前浏览器不支持摄像头";
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 400 } }, audio: false });
    cameraVideo.srcObject = cameraStream;
    captureButton.disabled = false;
    cameraButton.textContent = "摄像头已打开";
    cameraStatus.textContent = "预览中；不会自动上传";
  } catch (error) {
    cameraStatus.textContent = `摄像头没有打开：${error.message}`;
  }
});

function blobFromCanvas(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
}

async function capture_frame() {
  if (!cameraStream || cameraVideo.readyState < 2) throw new Error("请先打开摄像头");
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
  if (capturedUrl) URL.revokeObjectURL(capturedUrl);
  capturedUrl = URL.createObjectURL(blob);
  capturedFrame.src = capturedUrl;
  capturedFrame.hidden = false;
  const response = await fetch("/api/camera/capture", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || "截取失败");
  captureState.textContent = "刚刚手动截取 · 未保存";
  cameraStatus.textContent = `已截取 ${payload.bytes} bytes；本阶段未上传 Vision`;
  return payload;
}

window.capture_frame = capture_frame;
window.describe_frame = async () => { throw new Error("Phase 2: describe_frame() uses AI Station Vision"); };
window.observe_child = async () => { throw new Error("Phase 2: observe_child() uses AI Station Vision"); };

captureButton.addEventListener("click", async () => {
  try { await capture_frame(); } catch (error) { cameraStatus.textContent = error.message; }
});

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
