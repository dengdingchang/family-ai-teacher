// Play receipts and the single "what am I playing" reminder.
//
// Every child activity reports how long it lasted so the parent space can show
// growth evidence. The reminder is owned here too, so leaving a conversation
// only activity (story, game) never depends on the child remembering where it
// started. The page supplies the two elements and its label table at startup.

let playActivity = "", playStartedAt = 0, playStep = "";
const pendingPlayEvents = new Map();

let indicator = null;
let indicatorLabel = null;
let activityLabels = {};

export function initActivitySession({ indicator: element, label, labels }) {
  indicator = element || null;
  indicatorLabel = label || null;
  activityLabels = labels || {};
  syncActivityNow();
}

/** Remember the step the child reached, so later receipts stay in context. */
export function setPlayStep(step) {
  playStep = step || "";
}

/** Current activity key, or "" when nothing is being played. */
export function getPlayActivity() {
  return playActivity;
}

function postPlayEvent(event) {
  return fetch("/api/activities/event", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event), keepalive: true }).then(async response => {
    if (!response.ok) throw new Error("activity receipt failed");
    pendingPlayEvents.delete(event.event_id);
    return response.json();
  });
}

export function savePlayEvent(payload) {
  const event = { event_id: crypto.randomUUID(), activity: playActivity || payload.activity,
    kind: payload.kind, step: String(payload.step || playStep).slice(0, 80),
    duration_seconds: Math.max(0, Math.min(3600, Math.round(payload.duration_seconds || 0))),
    level: payload.level || "", result: payload.result || "", independent: Boolean(payload.independent) };
  pendingPlayEvents.set(event.event_id, event);
  return postPlayEvent(event);
}

export function syncActivityNow() {
  if (!indicator) return;
  const label = activityLabels[playActivity] || "";
  indicator.hidden = !label;
  if (indicatorLabel) indicatorLabel.textContent = label ? ` · ${label}` : "";
}

export function endPlayActivity() {
  if (!playActivity) return;
  if (playStartedAt) void savePlayEvent({ kind: "session", duration_seconds: (performance.now() - playStartedAt) / 1000 }).catch(() => {});
  playActivity = ""; playStartedAt = 0; playStep = "";
  syncActivityNow();
}

export function beginPlayActivity(name, step = "") {
  if (playActivity !== name) endPlayActivity();
  playActivity = name; playStep = step;
  if (!playStartedAt && !document.hidden) playStartedAt = performance.now();
  syncActivityNow();
}

document.addEventListener("visibilitychange", () => {
  if (!playActivity) return;
  if (document.hidden && playStartedAt) {
    void savePlayEvent({ kind: "session", duration_seconds: (performance.now() - playStartedAt) / 1000 }).catch(() => {});
    playStartedAt = 0;
  } else if (!document.hidden) playStartedAt = performance.now();
});
window.setInterval(() => {
  for (const event of pendingPlayEvents.values()) void postPlayEvent(event).catch(() => {});
  if (!playActivity || !playStartedAt || document.hidden) return;
  const elapsed = (performance.now() - playStartedAt) / 1000;
  if (elapsed < 30) return;
  void savePlayEvent({ kind: "session", duration_seconds: elapsed }).catch(() => {});
  playStartedAt = performance.now();
}, 30000);
