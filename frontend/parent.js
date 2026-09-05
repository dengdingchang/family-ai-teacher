const byId = (id) => document.getElementById(id);

const statusLabels = {
  not_started: "尚未开始",
  exploring: "正在探索",
  practicing: "持续练习",
  mastered: "已经掌握",
  pending: "等待传达",
  delivered: "已经传达",
  responded: "孩子已回应",
  cancelled: "已取消",
  candidate: "候选记忆",
  durable: "长期保留",
};

const defaultActivities = [
  "drawing",
  "story",
  "game",
  "music",
  "vision_photo",
  "vision_video",
];
const activityLabels = {
  english: "英语小游戏",
  numbers: "数数游戏",
  colors: "找颜色",
  animals: "认识动物",
  drawing: "一起画画",
  story: "接龙故事",
  game: "观察游戏",
  music: "节奏唱歌",
};
let currentProfile = {};
let profileDirty = false;
let allMemories = [];
let memoryPage = 0;
const MEMORIES_PER_PAGE = 10;
let allJournal = [];
let journalVisible = 4;
let allMessages = [];
let messagesVisible = 4;

function showStatus(id, message, error = false) {
  const element = byId(id);
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("error", error);
}

function appendStatusMeta(element, status, timestamp) {
  const dot = document.createElement("span");
  dot.className = "status-dot";
  if (["delivered", "responded", "durable"].includes(status))
    dot.classList.add(status);
  element.append(
    dot,
    `${statusLabels[status] || "状态待确认"} · ${formatTime(timestamp)}`,
  );
}

function text(value) {
  return String(value || "").trim();
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function listText(values) {
  return Array.isArray(values) ? values.filter(Boolean).join("、") : "";
}

function parseList(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[\n,，、;；]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 24);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || "操作没有完成");
  return payload;
}

function formatInteractionTime(seconds, available) {
  if (
    available !== true ||
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < 0
  )
    return "尚无计时";
  if (seconds === 0) return "0秒";
  if (seconds < 60) return "小于1分钟";
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  if (minutes >= 60)
    return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
  return `${minutes}分${wholeSeconds % 60}秒`;
}

function renderToday(today) {
  byId("todayInteractionTime").textContent = formatInteractionTime(
    today.interaction_seconds,
    today.interaction_timing_available,
  );
  byId("todayTurns").textContent = `${today.conversation_turns || 0}轮完整对话`;
  byId("todayTopics").textContent = today.topics?.length
    ? `今天：${today.topics.join("、")}`
    : "今天还没有主题";
  byId("todaySummary").textContent = today.conversation_turns
    ? today.topics?.length
      ? `今天一起聊到了${today.topics.join("、")}。看看孩子说了什么，哪些好奇可以在生活里接着探索。`
      : "今天的交流已经留在这里。听见孩子的想法，就是陪伴的一部分。"
    : "今天的故事还没开始。孩子说出的第一个问题，会从这里留下记录。";
  const timeline = byId("todayTimeline");
  timeline.replaceChildren();
  if (!today.recent_turns?.length) {
    timeline.className = "timeline empty-state";
    timeline.textContent =
      "和爸爸老师聊过以后，这里会出现孩子的话和老师的回应。";
    return;
  }
  timeline.className = "timeline";
  for (const turn of [...today.recent_turns].reverse()) {
    const item = document.createElement("article");
    item.className = "timeline-item";
    const time = document.createElement("time");
    time.textContent = formatTime(turn.created_at);
    const copy = document.createElement("div");
    const child = document.createElement("p");
    child.textContent = `孩子：${text(turn.user_text)}`;
    const answer = document.createElement("p");
    answer.className = "answer";
    answer.textContent = `爸爸老师：${text(turn.assistant_text)}`;
    copy.append(child, answer);
    item.append(time, copy);
    timeline.append(item);
  }
}

function renderProfile(profile, brain) {
  currentProfile = profile && typeof profile === "object" ? profile : {};
  byId("profileName").value = text(profile?.name);
  byId("profileAge").value = String(profile?.age || 4);
  byId("teacherStyle").value = text(profile?.teacher_style) || "warm_guided";
  byId("brainMode").value = text(profile?.brain_mode) || "ai_station";
  byId("profileInterests").value = listText(profile?.interests);
  byId("learningGoals").value = listText(profile?.learning_goals);
  byId("teachingPreferences").value = listText(profile?.teaching_preferences);
  byId("contentBoundaries").value = listText(profile?.content_boundaries);
  const enabled = Array.isArray(profile?.enabled_activities)
    ? profile.enabled_activities
    : defaultActivities;
  for (const checkbox of document.querySelectorAll(
    'input[name="enabledActivity"]',
  )) {
    checkbox.checked = enabled.includes(checkbox.value);
  }
  byId("brainSummary").textContent = "爸爸来决定";
}

function renderSkills(graph) {
  const groups = new Map();
  for (const skill of graph.skills || []) {
    const domain = text(skill.domain) || "其他";
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(skill);
  }
  const root = byId("skillGroups");
  root.replaceChildren();
  let active = 0;
  for (const [domain, skills] of groups) {
    const section = document.createElement("section");
    section.className = "skill-domain";
    const heading = document.createElement("h3");
    heading.textContent = domain;
    section.append(heading);
    for (const skill of skills) {
      if (["exploring", "practicing"].includes(skill.status)) active += 1;
      const row = document.createElement("div");
      row.className = "skill-row";
      row.dataset.state = skill.status;
      const name = document.createElement("span");
      name.textContent = text(skill.name);
      const progress = document.createElement("small");
      progress.textContent = `话题接触 ${Number(skill.practice_count || 0)} 次 · ${skill.parent_reviewed_at ? "家长已评估" : "待家长评估"}`;
      progress.title =
        "话题接触次数不代表答对次数或掌握程度；右侧学习状态可由家长确认。";
      const select = document.createElement("select");
      select.setAttribute("aria-label", `${skill.name}学习状态`);
      for (const value of [
        "not_started",
        "exploring",
        "practicing",
        "mastered",
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = statusLabels[value];
        option.selected = value === skill.status;
        select.append(option);
      }
      select.addEventListener("change", async () => {
        select.disabled = true;
        const previous = skill.status;
        try {
          await api(`/api/skills/${encodeURIComponent(skill.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ status: select.value }),
          });
          skill.status = select.value;
          row.dataset.state = select.value;
          progress.textContent = `话题接触 ${Number(skill.practice_count || 0)} 次 · 家长已评估`;
          byId("activeSkills").textContent = String(
            (graph.skills || []).filter((item) =>
              ["exploring", "practicing"].includes(item.status),
            ).length,
          );
          showStatus("dashboardStatus", `已更新“${skill.name}”的学习状态。`);
        } catch (error) {
          select.value = previous;
          showStatus(
            "dashboardStatus",
            `学习状态没有保存：${error.message}`,
            true,
          );
        } finally {
          select.disabled = false;
        }
      });
      row.append(name, progress, select);
      section.append(row);
    }
    root.append(section);
  }
  byId("activeSkills").textContent = String(active);
}

function renderMemories(memories, tiers) {
  allMemories = Array.isArray(memories) ? memories : [];
  const durable = allMemories.filter(
    (memory) => memory.status === "durable",
  ).length;
  const candidates = allMemories.filter(
    (memory) => memory.status === "candidate",
  ).length;
  byId("durableCount").textContent = String(durable);
  byId("memoryCounts").textContent = `候选 ${candidates} · 长期 ${durable}`;
  renderMemoryPage();
}

function renderMemoryPage() {
  const root = byId("memoryList");
  const query = byId("memorySearch").value.trim().toLocaleLowerCase();
  const status = byId("memoryFilter").value;
  const memories = [...allMemories]
    .reverse()
    .filter(
      (memory) =>
        (!status || memory.status === status) &&
        (!query || text(memory.summary).toLocaleLowerCase().includes(query)),
    );
  const pageCount = Math.max(1, Math.ceil(memories.length / MEMORIES_PER_PAGE));
  memoryPage = Math.min(memoryPage, pageCount - 1);
  byId("memoryPrevious").disabled = memoryPage === 0;
  byId("memoryNext").disabled = memoryPage >= pageCount - 1;
  byId("memoryPage").textContent = `${memoryPage + 1} / ${pageCount}`;
  byId("memoryResultCount").textContent =
    `全部 ${allMemories.length} 条 · 当前找到 ${memories.length} 条`;
  root.replaceChildren();
  if (!memories?.length) {
    root.className = "memory-list empty-state";
    root.textContent =
      query || status
        ? "没有找到符合条件的记忆，试试其他词语或类型。"
        : "值得记住的小事会先来到这里，等你决定是否长期保留。";
    return;
  }
  root.className = "memory-list";
  for (const memory of memories.slice(
    memoryPage * MEMORIES_PER_PAGE,
    (memoryPage + 1) * MEMORIES_PER_PAGE,
  )) {
    const item = document.createElement("article");
    item.className = "memory-item";
    const top = document.createElement("div");
    top.className = "memory-top";
    const summary = document.createElement("p");
    summary.textContent = text(memory.summary);
    const actions = document.createElement("div");
    actions.className = "item-actions";
    if (memory.status === "candidate") {
      const keep = document.createElement("button");
      keep.type = "button";
      keep.className = "mini-button";
      keep.textContent = "长期保留";
      keep.addEventListener("click", async () => {
        keep.disabled = true;
        try {
          await api(`/api/memories/${encodeURIComponent(memory.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "durable" }),
          });
          showStatus("memorySaveStatus", "已放进家庭的长期记忆。");
          await loadDashboard();
        } catch (error) {
          showStatus(
            "memorySaveStatus",
            `这条记忆没有保存：${error.message}`,
            true,
          );
          keep.disabled = false;
        }
      });
      actions.append(keep);
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "mini-button";
    edit.textContent = "纠正";
    edit.addEventListener("click", () => {
      if (item.querySelector(".inline-editor")) return;
      const form = document.createElement("form");
      form.className = "inline-editor";
      const input = document.createElement("textarea");
      input.value = text(memory.summary);
      input.maxLength = 240;
      input.required = true;
      input.setAttribute("aria-label", "纠正记忆内容");
      const controls = document.createElement("div");
      controls.className = "item-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "quiet-button";
      cancel.textContent = "取消";
      cancel.addEventListener("click", () => {
        form.remove();
        edit.focus();
      });
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "primary-button";
      save.textContent = "保存纠正";
      controls.append(cancel, save);
      form.append(input, controls);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!input.value.trim()) return;
        save.disabled = true;
        try {
          await api(`/api/memories/${encodeURIComponent(memory.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ summary: input.value.trim() }),
          });
          showStatus("memorySaveStatus", "记忆已纠正，之后会使用新的内容。");
          await loadDashboard();
        } catch (error) {
          showStatus(
            "memorySaveStatus",
            `纠正没有保存：${error.message}`,
            true,
          );
          save.disabled = false;
        }
      });
      item.append(form);
      input.focus();
    });
    actions.append(edit);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini-button danger";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      if (!confirm("删除这条记忆？删除后不会自动恢复。")) return;
      remove.disabled = true;
      try {
        await api(`/api/memories/${encodeURIComponent(memory.id)}`, {
          method: "DELETE",
        });
        showStatus("memorySaveStatus", "这条记忆已删除。");
        await loadDashboard();
      } catch (error) {
        showStatus("memorySaveStatus", `删除没有完成：${error.message}`, true);
        remove.disabled = false;
      }
    });
    actions.append(remove);
    top.append(summary, actions);
    const meta = document.createElement("div");
    meta.className = "item-meta";
    appendStatusMeta(
      meta,
      memory.status,
      memory.last_seen_at || memory.created_at,
    );
    item.append(top, meta);
    root.append(item);
  }
}

function renderMessages(messages) {
  allMessages = Array.isArray(messages) ? messages : [];
  renderMessagePage();
}

function renderMessagePage() {
  const messages = allMessages;
  byId("messagesEarlier").hidden = messagesVisible >= messages.length;
  byId("messagesEarlier").textContent =
    `查看更早的留言（还有 ${Math.max(0, messages.length - messagesVisible)} 条）`;
  const root = byId("messageList");
  root.replaceChildren();
  if (!messages?.length) {
    root.className = "message-list empty-state";
    root.textContent = "还没有留言。写下今晚的安排，或一句想对孩子说的话。";
    return;
  }
  root.className = "message-list";
  for (const message of [...messages].reverse().slice(0, messagesVisible)) {
    const item = document.createElement("article");
    item.className = "message-item";
    const top = document.createElement("div");
    top.className = "message-top";
    const content = document.createElement("p");
    content.textContent = text(message.text);
    top.append(content);
    if (message.status === "pending") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "mini-button danger";
      cancel.textContent = "取消";
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        try {
          await api(
            `/api/parent/messages/${encodeURIComponent(message.id)}/cancel`,
            { method: "POST", body: "{}" },
          );
          showStatus(
            "messageSaveStatus",
            "留言已取消，爸爸老师不会再传达这条内容。",
          );
          await loadDashboard();
        } catch (error) {
          showStatus(
            "messageSaveStatus",
            `取消没有完成：${error.message}`,
            true,
          );
          cancel.disabled = false;
        }
      });
      top.append(cancel);
    }
    const meta = document.createElement("div");
    meta.className = "item-meta";
    appendStatusMeta(meta, message.status, message.created_at);
    item.append(top, meta);
    if (message.child_response) {
      const response = document.createElement("p");
      response.className = "item-meta";
      response.textContent = `孩子回应：${text(message.child_response)}`;
      item.append(response);
    }
    root.append(item);
  }
}

function renderJournal(journal) {
  allJournal = Array.isArray(journal) ? journal : [];
  renderJournalPage();
}

function renderJournalPage() {
  const journal = allJournal;
  const root = byId("journalContent");
  byId("journalEarlier").hidden = journalVisible >= journal.length;
  byId("journalEarlier").textContent =
    `查看更早的周记（还有 ${Math.max(0, journal.length - journalVisible)} 周）`;
  root.replaceChildren();
  if (!journal?.length) {
    root.className = "journal-content empty-state";
    root.textContent = "还在收集第一周的小进步。";
    return;
  }
  root.className = "journal-content journal-list";
  for (const [index, entry] of journal.slice(0, journalVisible).entries()) {
    const card = document.createElement("details");
    card.className = "journal-entry";
    card.open = index === 0;
    const title = document.createElement("summary");
    title.textContent = `${entry.week} · ${entry.summary || `${entry.conversation_turns || 0} 轮互动`}`;
    const list = document.createElement("ul");
    const facts = [
      ...(entry.learning_progress || [])
        .slice(0, 4)
        .map((value) => `话题接触 · ${value.name}：${value.turns || 0} 轮`),
      ...(entry.skill_reviews || []).map(
        (value) =>
          `爸爸确认：${value.name} · ${statusLabels[value.status] || value.status}${value.evidence ? `（${value.evidence}）` : ""}`,
      ),
      ...(entry.milestones || []).map((value) => `已确认的第一次：${value}`),
      ...(entry.milestone_candidates || []).map(
        (value) => `待爸爸确认：${value}`,
      ),
      ...(entry.parent_connections || []).map((value) => value),
      ...(entry.difficulties || []).map((value) => `需要留意：${value}`),
      ...(entry.observations || [])
        .slice(-2)
        .map((value) => `真实观察：${value}`),
      entry.recommendation ? `下一步：${entry.recommendation}` : "",
    ].filter(Boolean);
    if (!facts.length) facts.push("这一周还没有形成足够的成长证据。");
    for (const fact of facts) {
      const item = document.createElement("li");
      item.textContent = fact;
      list.append(item);
    }
    card.append(title, list);
    root.append(card);
  }
}

async function loadDashboard() {
  try {
    const data = await api("/api/parent/dashboard");
    const name = text(data.profile?.name);
    byId("welcomeText").textContent = name
      ? `看见 ${name} 今天的小进步，也把爸爸的话带回家。`
      : "看见今天的小进步，也把爸爸的话带回家。";
    if (!profileDirty) renderProfile(data.profile || {}, data.brain || {});
    renderToday(data.today || {});
    renderSkills(data.skill_graph || { skills: [] });
    renderJournal(data.growth_journal || []);
    if (data.current_activity?.status === "active") {
      const activity = text(data.current_activity.activity);
      byId("nextTitle").textContent =
        `正在进行 · ${activityLabels[activity] || text(data.current_activity.topic) || "小活动"}`;
      byId("nextSuggestion").textContent =
        `已经走到第 ${Number(data.current_activity.step || 1)} 小步；下一轮会接着孩子刚才的回答。`;
    } else {
      byId("nextTitle").textContent =
        text(data.next_activity?.skill_name) || "下一小步";
      byId("nextSuggestion").textContent =
        text(data.next_activity?.suggestion) ||
        "跟随孩子今天的兴趣继续一小步。";
    }
    showStatus("dashboardStatus", "");
    try {
      const library = await api("/api/memories");
      renderMemories(library.memories || [], data.memory_tiers || {});
    } catch (error) {
      showStatus(
        "memorySaveStatus",
        `完整记忆暂时无法读取：${error.message}。可刷新页面重试。`,
        true,
      );
    }
    try {
      const archive = await api("/api/parent/messages");
      renderMessages(archive.messages || []);
    } catch (error) {
      showStatus(
        "messageSaveStatus",
        `完整留言暂时无法读取：${error.message}。可刷新页面重试。`,
        true,
      );
    }
  } catch (error) {
    showStatus(
      "dashboardStatus",
      `暂时无法读取成长信息：${error.message}。请确认家庭应用已启动，然后刷新页面。`,
      true,
    );
    byId("todayTimeline").textContent =
      "成长记录还未加载，已保存的家庭资料不会因此丢失。";
  }
}

byId("profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = byId("profileSaveStatus");
  const enabledActivities = [
    ...document.querySelectorAll('input[name="enabledActivity"]:checked'),
  ].map((item) => item.value);
  const payload = {
    name: byId("profileName").value.trim(),
    age: Number(byId("profileAge").value || 4),
    teacher_style: byId("teacherStyle").value,
    brain_mode: byId("brainMode").value,
    interests: parseList(byId("profileInterests").value),
    learning_goals: parseList(byId("learningGoals").value),
    teaching_preferences: parseList(byId("teachingPreferences").value),
    content_boundaries: parseList(byId("contentBoundaries").value),
    enabled_activities: enabledActivities,
  };
  showStatus("profileSaveStatus", "正在保存…");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const saved = await api("/api/profile", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    profileDirty = false;
    await loadDashboard();
    const savedName = text(saved.name);
    status.textContent = savedName
      ? `已保存；下一轮会自然叫“${savedName}”`
      : "已保存；下一轮使用通用称呼";
  } catch (error) {
    showStatus("profileSaveStatus", `设置没有保存：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

byId("profileForm").addEventListener("input", () => {
  profileDirty = true;
});
byId("profileForm").addEventListener("change", () => {
  profileDirty = true;
});

byId("profileName").addEventListener("input", () => {
  byId("profileSaveStatus").textContent = "昵称有改动，保存后生效";
});

byId("messageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = byId("messageInput");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  showStatus("messageSaveStatus", "正在交给爸爸老师…");
  try {
    await api("/api/parent/messages", {
      method: "POST",
      body: JSON.stringify({ text: input.value }),
    });
    input.value = "";
    await loadDashboard();
    showStatus("messageSaveStatus", "已收到，会在合适的对话中传达。");
  } catch (error) {
    showStatus("messageSaveStatus", `留言没有送出：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

byId("memoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = byId("memoryInput");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  showStatus("memorySaveStatus", "正在记下来…");
  try {
    await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({
        summary: input.value,
        status: "durable",
        category: "parent",
      }),
    });
    input.value = "";
    await loadDashboard();
    showStatus("memorySaveStatus", "已加入家庭的长期记忆。");
  } catch (error) {
    showStatus("memorySaveStatus", `记忆没有保存：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

for (const id of ["memorySearch", "memoryFilter"]) {
  byId(id).addEventListener(id === "memorySearch" ? "input" : "change", () => {
    memoryPage = 0;
    renderMemoryPage();
  });
}
byId("memoryPrevious").addEventListener("click", () => {
  memoryPage = Math.max(0, memoryPage - 1);
  renderMemoryPage();
  byId("memorySearch").focus({ preventScroll: true });
});
byId("memoryNext").addEventListener("click", () => {
  memoryPage += 1;
  renderMemoryPage();
  byId("memorySearch").focus({ preventScroll: true });
});
byId("journalEarlier").addEventListener("click", () => {
  journalVisible += 4;
  renderJournalPage();
});
byId("messagesEarlier").addEventListener("click", () => {
  messagesVisible += 4;
  renderMessagePage();
});

byId("dashboardDate").textContent = new Date().toLocaleDateString("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});
document
  .querySelector('a[href="#familySettings"]')
  ?.addEventListener("click", () => {
    byId("familySettings").open = true;
  });

async function deleteFamilyData(scopes, description, button) {
  const expected = text(currentProfile.name) || "DELETE";
  const confirmation = prompt(
    `这是不可恢复的清除操作。请输入“${expected}”确认：`,
  );
  if (confirmation === null) return;
  if (confirmation.trim() !== expected) {
    alert("确认文字不一致，没有清除任何数据。");
    return;
  }
  if (!confirm(`最后确认：${description}？建议先导出备份。`)) return;
  const status = byId("dataActionStatus");
  button.disabled = true;
  status.textContent = "正在安全清除…";
  try {
    await api("/api/parent/data/delete", {
      method: "POST",
      body: JSON.stringify({ scopes, confirmation: expected }),
    });
    status.textContent = "已完成；页面已刷新。";
    await loadDashboard();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

byId("clearSessionData").addEventListener("click", (event) => {
  void deleteFamilyData(
    ["history", "learning_events", "activity"],
    "清除聊天记录、观察事件和当前活动；长期记忆与学习进度会保留",
    event.currentTarget,
  );
});

byId("resetFamilyData").addEventListener("click", (event) => {
  void deleteFamilyData(
    ["all"],
    "删除孩子资料、历史、成长记忆、学习进度和爸爸留言",
    event.currentTarget,
  );
});

void loadDashboard();
