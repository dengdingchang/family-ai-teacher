// The conversation transcript: history records, the live turn and the media
// suggestion cards that belong to a turn. The page hands over its elements and
// the shared media viewer at startup; everything else stays inside this module.

let chatHistory = null;
let chatEmpty = null;
let liveTurn = null;
let userTextBox = null;
let answerBox = null;
let mediaViewer = null;

let historyRecords = [];
let historyExpanded = false;
let historyResizeTimer = null;
const mediaSuggestionGroups = [];
let mediaSuggestionRequestController = null;
let mediaSuggestionGeneration = 0;
let mediaSuggestionJobStatusUrl = "";

export function initTranscriptView({ chatHistory: historyElement, chatEmpty: emptyElement,
  liveTurn: liveElement, userTextBox: userElement, answerBox: answerElement, mediaViewer: viewer }) {
  chatHistory = historyElement;
  chatEmpty = emptyElement;
  liveTurn = liveElement;
  userTextBox = userElement;
  answerBox = answerElement;
  mediaViewer = viewer;
}

document.querySelector("#historyToggle")?.addEventListener("click", event => {
  historyExpanded = !historyExpanded;
  event.currentTarget.textContent = historyExpanded ? "收起文字记录" : "展开最近记录";
  event.currentTarget.setAttribute("aria-expanded", String(historyExpanded));
  document.querySelector(".adult-transcript")?.classList.toggle("expanded", historyExpanded);
  renderHistory();
});

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

export function cancelMediaSuggestionLookup({ closeViewer = true } = {}) {
  for (let index = mediaSuggestionGroups.length - 1; index >= 0; index--) {
    if (mediaSuggestionGroups[index].pending && !mediaSuggestionGroups[index].cards.length) mediaSuggestionGroups.splice(index, 1);
  }
  mediaSuggestionGeneration += 1;
  const controller = mediaSuggestionRequestController;
  mediaSuggestionRequestController = null;
  controller?.abort();
  const statusUrl = mediaSuggestionJobStatusUrl;
  mediaSuggestionJobStatusUrl = "";
  if (/^\/api\/image-generation\/jobs\/[0-9a-f]{32}$/.test(statusUrl)) {
    fetch(`${statusUrl}/cancel`, { method: "POST", keepalive: true }).catch(() => {});
  }
  if (closeViewer) mediaViewer?.close({ restoreFocus: false });
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

// Image jobs take minutes, not seconds: start quick, then back off so a slow
// generation does not cost one request every two seconds.
function mediaPollDelay(attempt) {
  return Math.min(1200 * 2 ** Math.min(attempt, 4), 8000);
}

async function pollGeneratedMedia(job, topic, group, controller, generation) {
  const statusUrl = String(job?.status_url || "");
  if (!/^\/api\/image-generation\/jobs\/[0-9a-f]{32}$/.test(statusUrl)) return;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (!await waitForMediaPoll(mediaPollDelay(attempt), controller.signal)) return;
    if (Date.now() - startedAt > 180000) return;
    if (controller.signal.aborted || generation !== mediaSuggestionGeneration) return;
    const response = await fetch(statusUrl, { signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || String(result.topic || "") !== topic) {
      group.pending = false;
      if (!group.cards.length) group.message = "这次图片准备已停止，可以再说一次想看什么。";
      renderHistory();
      return;
    }
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
    if (String(result.card.topic || "") !== topic) {
      group.pending = false;
      group.message = "这张图和刚才要的不一致，爸爸重新准备时再给你看。";
      renderHistory();
      return;
    }
    if (controller.signal.aborted || generation !== mediaSuggestionGeneration) return;
    const imageUrl = String(result.card.thumbnail_url || "");
    if (!group.cards.some(card => String(card.thumbnail_url || "") === imageUrl)) {
      group.cards.unshift(result.card);
    }
    group.message = "";
    group.pending = false;
    if (mediaSuggestionJobStatusUrl === statusUrl) mediaSuggestionJobStatusUrl = "";
    renderHistory();
    if (!document.hidden && generation === mediaSuggestionGeneration) {
      mediaViewer.openImage(result.card);
    }
    return;
  }
}

export async function loadMediaSuggestions(childText, assistantText = "") {
  const suggestion = chooseMediaSuggestion(childText, assistantText);
  if (!suggestion) return;
  cancelMediaSuggestionLookup();
  const generation = mediaSuggestionGeneration;
  const { topic, generateImage, kind = "image" } = suggestion;
  const imageJobId = generateImage && typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replaceAll("-", "").toLowerCase() : "";
  if (generateImage && !/^[0-9a-f]{32}$/.test(imageJobId)) return;
  if (imageJobId) mediaSuggestionJobStatusUrl = `/api/image-generation/jobs/${imageJobId}`;
  const controller = new AbortController();
  mediaSuggestionRequestController = controller;
  const group = { topic, cards: [], pending: true, message: kind === "image"
    ? `正在准备${topic}的图片，可以继续和爸爸说话。` : `正在找${topic}的学习资料，可以继续和爸爸说话。` };
  mediaSuggestionGroups.push(group);
  if (mediaSuggestionGroups.length > 3) mediaSuggestionGroups.shift();
  renderHistory();
  try {
    const response = await fetch("/api/media/suggestions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, kind, generate_image: generateImage, image_job_id: imageJobId }),
      signal: controller.signal,
    });
    if (controller.signal.aborted || generation !== mediaSuggestionGeneration) return;
    const payload = await response.json().catch(() => ({}));
    if (controller.signal.aborted || generation !== mediaSuggestionGeneration) return;
    const returnedTopic = String(payload.topic || "");
    if (!response.ok || returnedTopic !== topic || !Array.isArray(payload.cards)) {
      group.message = `这次没能准备好${topic}，可以再试一次。`;
      renderHistory();
      return;
    }
    const drawing = ["queued", "running"].includes(payload.image_generation);
    payload.cards = payload.cards.filter(card => card && String(card.topic || "") === topic);
    group.pending = drawing;
    const message = payload.cards.length ? "" : drawing ? `正在画${topic}，先继续聊。`
      : payload.image_generation === "busy" ? "图片任务有点忙，我们先继续聊。"
      : payload.image_generation === "failed" ? `这次没有画好${topic}，我们先继续聊。`
      : payload.reason === "source_unavailable"
      ? `这次暂时连不上${topic}图片，我们先继续聊。`
      : payload.reason === "search_disabled" ? "家长暂时关闭了联网搜索。"
      : payload.reason === "search_busy" ? "爸爸正在查资料，稍后再试一次。"
      : `这次没有找到合适的${topic}${kind === "image" ? "图片" : "资料"}，我们先继续聊。`;
    group.cards = payload.cards;
    group.message = message;
    renderHistory();
    const displayCard = payload.cards.find(card => card?.generated === true)
      || payload.cards.find(card => card?.kind === "image" || card?.type === "image");
    if (displayCard && !document.hidden && generation === mediaSuggestionGeneration) {
      mediaSuggestionJobStatusUrl = "";
      mediaViewer.openImage(displayCard);
    }
    const videoCard = kind === "video" && payload.cards.find(card => card.kind === "video");
    if (videoCard && !document.hidden && generation === mediaSuggestionGeneration) mediaViewer.openVideo(videoCard);
    if (drawing) {
      mediaSuggestionJobStatusUrl = String(payload.image_generation_job?.status_url || "");
      await pollGeneratedMedia(payload.image_generation_job, topic, group, controller, generation);
    } else if (mediaSuggestionJobStatusUrl.endsWith(imageJobId)) {
      mediaSuggestionJobStatusUrl = "";
    }
  } catch (_) {
    if (!controller.signal.aborted && generation === mediaSuggestionGeneration) {
      group.message = `这次准备${topic}没有成功，可以再试一次。`;
      group.pending = false;
      renderHistory();
    }
    // Learning cards are optional; voice and local activities stay available.
    const statusUrl = mediaSuggestionRequestController === controller ? mediaSuggestionJobStatusUrl : "";
    if (/^\/api\/image-generation\/jobs\/[0-9a-f]{32}$/.test(statusUrl)) {
      fetch(`${statusUrl}/cancel`, { method: "POST", keepalive: true }).catch(() => {});
      mediaSuggestionJobStatusUrl = "";
    }
  } finally {
    if (mediaSuggestionRequestController === controller) mediaSuggestionRequestController = null;
  }
}

export function renderHistory() {
  if (!chatHistory) return;
  chatHistory.replaceChildren();
  const visibleRecords = historyRecords.filter((record) => (
    String(record?.user_text || "").trim() || String(record?.assistant_text || "").trim()
  )).slice(historyExpanded ? -10 : -1);
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
  }
    const mediaContent = document.querySelector("#sharedMediaContent");
    const mediaStage = document.querySelector("#sharedMediaStage");
    if (mediaContent && mediaStage) {
      mediaContent.replaceChildren();
      const latest = mediaSuggestionGroups.at(-1);
      mediaStage.hidden = !latest;
      if (latest) mediaContent.append(buildMediaHistoryTurn(latest));
    }
  // The current turn is part of this same scrolling log, never a second feed.
  chatHistory.append(liveTurn);
  scrollHistoryToLatest();
}

window.addEventListener("resize", () => {
  clearTimeout(historyResizeTimer);
  historyResizeTimer = setTimeout(scrollHistoryToLatest, 100);
});

export function appendHistoryRecord(record) {
  if (!record || typeof record !== "object") return;
  const createdAt = String(record.created_at || "");
  if (createdAt && historyRecords.some((item) => String(item?.created_at || "") === createdAt)) return;
  historyRecords.push(record);
  renderHistory();
}

export async function loadHistory() {
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

export function resetLiveTurn() {
  if (!liveTurn.parentElement || liveTurn.parentElement !== chatHistory) chatHistory.append(liveTurn);
  liveTurn.hidden = false;
  userTextBox.textContent = "正在听你说…";
  answerBox.classList.remove("has-answer");
  answerBox.innerHTML = '<span class="answer-label">正在想一个好玩的教法…</span>';
  scrollHistoryToLatest();
}

export function hideLiveTurn() {
  liveTurn.hidden = true;
  scrollHistoryToLatest();
}

