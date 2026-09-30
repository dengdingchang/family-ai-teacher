"use strict";

const $ = (id) => document.getElementById(id);
const panels = { ready: $("guideReady"), record: $("guideRecord"), review: $("guideReview"), done: $("guideDone") };
const progress = { ready: $("progressReady"), record: $("progressRecord"), review: $("progressReview") };
let stream = null;
let recorder = null;
let captureTimer = null;
let audioContext = null;
let audioSource = null;
let audioProcessor = null;
let audioGain = null;
let samples = [];
let recorderChunks = [];
let recording = false;
let draftToken = "";
let recordingUrl = "";
let previewUrl = "";

function showStep(step) {
  for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== step;
  for (const [name, item] of Object.entries(progress)) {
    if (name === step || (step === "done" && name === "review")) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
}

function status(message, error = false) {
  $("setupStatus").textContent = message;
  $("setupStatus").classList.toggle("error", error);
}

function stopTracks() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  $("liveCamera").srcObject = null;
}

function releaseAudio() {
  audioSource?.disconnect();
  audioProcessor?.disconnect();
  audioGain?.disconnect();
  void audioContext?.close();
  audioSource = audioProcessor = audioGain = audioContext = null;
}

function resetPreview({ preservePortrait = false } = {}) {
  draftToken = "";
  $("voicePreview").pause();
  $("voicePreview").removeAttribute("src");
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  previewUrl = recordingUrl = "";
  $("recordedVideo").removeAttribute("src");
  $("recordedVideo").hidden = true;
  $("liveCamera").hidden = false;
  if (!preservePortrait) $("confirmedPortrait").removeAttribute("src");
  $("confirmedPortrait").hidden = !preservePortrait;
  $("cameraPlaceholder").hidden = Boolean(stream) || preservePortrait;
  document.querySelector(".face-guide").hidden = preservePortrait;
  $("qualityResults").replaceChildren();
}

async function requestCamera() {
  if (!$("consent").checked) { status("请先确认录制的是你本人的形象和声音。", true); return; }
  if (!window.isSecureContext) { status("摄像头需要 HTTPS。请打开爸爸老师的 HTTPS 私网或公网入口。", true); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    status("此浏览器暂不支持现场录制，请使用更新后的 Safari、Chrome 或 Edge。", true);
    return;
  }
  resetPreview();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } }, audio: true });
    $("liveCamera").srcObject = stream;
    await $("liveCamera").play();
    $("cameraPlaceholder").hidden = true;
    showStep("record");
    status("看一下画面：脸和肩膀居中、光线明亮，然后开始录制。");
  } catch (_) {
    stopTracks();
    status("摄像头或麦克风没有打开。请在浏览器允许权限后重试。", true);
  }
}

function wavFromSamples(chunks, rate) {
  const count = chunks.reduce((total, part) => total + part.length, 0);
  const pcm = new Int16Array(count);
  let index = 0;
  for (const part of chunks) for (const number of part) pcm[index++] = Math.max(-32768, Math.min(32767, Math.round(number * 32767)));
  const output = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(output);
  const label = (offset, word) => [...word].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
  label(0, "RIFF"); view.setUint32(4, 36 + pcm.byteLength, true); label(8, "WAVE"); label(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); label(36, "data"); view.setUint32(40, pcm.byteLength, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([output], { type: "audio/wav" });
}

function base64FromBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function selectRecordingType() {
  for (const type of ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return "";
}

async function startRecording() {
  if (!stream || recording) return;
  try {
    const mimeType = selectRecordingType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderChunks = [];
    samples = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) recorderChunks.push(event.data); };
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    audioSource = audioContext.createMediaStreamSource(stream);
    audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    audioGain = audioContext.createGain();
    audioGain.gain.value = 0;
    audioProcessor.onaudioprocess = (event) => { if (recording) samples.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
    audioSource.connect(audioProcessor);
    audioProcessor.connect(audioGain);
    audioGain.connect(audioContext.destination);
    recording = true;
    recorder.start(1000);
    $("startRecording").disabled = true;
    $("cancelRecording").disabled = false;
    $("recordTimer").hidden = false;
    status("正在录制，请按提示完整读完句子。");
    let remaining = 10;
    $("recordTimer").textContent = `录制中 · ${remaining}`;
    captureTimer = setInterval(() => {
      remaining -= 1;
      $("recordTimer").textContent = `录制中 · ${remaining}`;
      if (remaining <= 0) void finishRecording();
    }, 1000);
  } catch (_) {
    recording = false;
    releaseAudio();
    $("startRecording").disabled = false;
    $("cancelRecording").disabled = false;
    status("录制没有开始，请关闭其他占用摄像头的页面后重试。", true);
  }
}

async function finishRecording() {
  if (!recording) return;
  recording = false;
  clearInterval(captureTimer);
  $("cancelRecording").disabled = true;
  $("recordTimer").hidden = true;
  try {
    const rate = audioContext.sampleRate;
    releaseAudio();
    const video = $("liveCamera");
    if (!video.videoWidth || !video.videoHeight) throw new Error("没有拍到画面，请重录。");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 640;
    const side = Math.min(video.videoWidth, video.videoHeight);
    canvas.getContext("2d").drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, 640, 640);
    const portraitImage = canvas.toDataURL("image/jpeg", .88);
    const portrait = portraitImage.split(",", 2)[1];
    $("confirmedPortrait").src = portraitImage;
    const recorded = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = () => reject(new Error("视频录制中断，请重录。"));
    });
    recorder.stop();
    await recorded;
    stopTracks();
    const recordingBlob = new Blob(recorderChunks, { type: recorder.mimeType || "video/mp4" });
    recordingUrl = URL.createObjectURL(recordingBlob);
    $("recordedVideo").src = recordingUrl;
    $("recordedVideo").hidden = false;
    video.hidden = true;
    document.querySelector(".face-guide").hidden = true;
    recorder = null;
    status("正在检查光线、清晰度和声音，并生成试听…");
    const voice = await base64FromBlob(wavFromSamples(samples, rate));
    samples = [];
    const response = await fetch("/api/parent/enrollment/preview", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Family-Enroll": "1" },
      body: JSON.stringify({ portrait, voice, consent: true }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail || "质量检查没有通过，请重录");
    draftToken = result.token;
    const binary = atob(result.preview_audio);
    const wav = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) wav[i] = binary.charCodeAt(i);
    previewUrl = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    $("voicePreview").src = previewUrl;
    const quality = result.quality || {};
    const checks = ["画面光线合格", "画面清晰", "声音音量合格", "未检测到明显破音"];
    if (Number.isFinite(quality.voice?.speaking_duration_seconds)) {
      checks.push(`检测到约 ${quality.voice.speaking_duration_seconds} 秒说话`);
    }
    $("qualityResults").replaceChildren(...checks.map((label) => { const item = document.createElement("span"); item.textContent = label; return item; }));
    showStep("review");
    status("质量检查通过。试听后，再决定是否给孩子使用。");
  } catch (error) {
    if (recorder?.state === "recording") { try { recorder.stop(); } catch (_) { /* already stopped */ } }
    recorder = null;
    samples = [];
    stopTracks();
    resetPreview();
    showStep("ready");
    status(error.message || "录制没有通过，请重试。", true);
  } finally {
    $("startRecording").disabled = false;
    $("cancelRecording").disabled = false;
  }
}

function cancelCapture() {
  if (recording) {
    recording = false;
    clearInterval(captureTimer);
    $("recordTimer").hidden = true;
    if (recorder?.state === "recording") { try { recorder.stop(); } catch (_) { /* already stopped */ } }
    recorder = null;
    recorderChunks = [];
    samples = [];
    releaseAudio();
  }
  stopTracks();
  resetPreview();
  $("startRecording").disabled = false;
  showStep("ready");
  status("准备好后再打开摄像头。");
}

async function activate() {
  if (!draftToken) return;
  $("activate").disabled = true;
  status("正在启用你的声音与形象…");
  try {
    const response = await fetch("/api/parent/enrollment/activate", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Family-Enroll": "1" },
      body: JSON.stringify({ token: draftToken }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail || "启用没有完成");
    draftToken = "";
    resetPreview({ preservePortrait: true });
    showStep("done");
    $("identityState").textContent = "当前使用：你的形象和声音";
    $("deleteIdentity").hidden = false;
    status(result.avatar_configured ? "已启用。刷新孩子页面后，数字人服务可用时会使用你的动态形象和声音。" : "已启用。下一轮会使用你的声音。");
  } catch (error) { status(error.message, true); }
  finally { $("activate").disabled = false; }
}

async function deleteIdentity() {
  const profileResponse = await fetch("/api/profile");
  const profile = await profileResponse.json().catch(() => ({}));
  const expected = String(profile.name || "DELETE").trim();
  const typed = prompt(`删除家长形象和声音特征，并恢复原有老师。请输入孩子昵称“${expected}”确认：`);
  if (typed === null) return;
  if (typed.trim() !== expected) { status("确认文字不一致，没有删除。", true); return; }
  try {
    const response = await fetch("/api/parent/enrollment", {
      method: "DELETE", headers: { "Content-Type": "application/json", "X-Family-Enroll": "1" },
      body: JSON.stringify({ confirmation: expected }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail || "删除没有完成");
    $("identityState").textContent = "当前使用：原有爸爸老师";
    $("deleteIdentity").hidden = true;
    resetPreview();
    showStep("ready");
    status("已删除家长形象和声音特征，孩子页面刷新后恢复原有老师。");
  } catch (error) { status(error.message, true); }
}

$("openCamera").addEventListener("click", () => void requestCamera());
$("startRecording").addEventListener("click", () => void startRecording());
$("cancelRecording").addEventListener("click", cancelCapture);
$("recordAgain").addEventListener("click", () => { resetPreview(); showStep("ready"); status("请重新打开摄像头录制。 "); });
$("activate").addEventListener("click", () => void activate());
$("deleteIdentity").addEventListener("click", () => void deleteIdentity());
window.addEventListener("pagehide", () => { clearInterval(captureTimer); stopTracks(); releaseAudio(); if (recordingUrl) URL.revokeObjectURL(recordingUrl); if (previewUrl) URL.revokeObjectURL(previewUrl); });
void fetch("/api/parent/enrollment").then((response) => response.json()).then((result) => {
  $("identityState").textContent = result.active ? "当前使用：你的形象和声音" : "当前使用：原有爸爸老师";
  $("deleteIdentity").hidden = !result.active;
  if (!result.voice_supported) status("当前声音模式还不能启用家长录制，请先联系管理员。", true);
}).catch(() => { $("identityState").textContent = "当前形象暂时无法读取"; });
