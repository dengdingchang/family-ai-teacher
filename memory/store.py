"""Privacy-minimal local profile, text history, and learning-event store."""

from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .interaction import InteractionConflictError, InteractionReceiptIndex, normalize_interval, today_interaction, validate_arrival


DEFAULT_ENABLED_ACTIVITIES = (
    "drawing",
    "story",
    "game",
    "music",
    "vision_photo",
    "vision_video",
)
TEACHER_STYLES = {"warm_guided", "playful", "calm"}
BRAIN_MODES = {"ai_station", "local_lessons_only"}
ACTIVITY_KINDS = {
    "english",
    "numbers",
    "colors",
    "animals",
    "drawing",
    "story",
    "game",
    "music",
}
FAMILY_DATA_SCOPES = {
    "profile",
    "history",
    "learning_events",
    "memories",
    "skills",
    "parent_messages",
    "activity",
}

DEFAULT_PROFILE = {
    "name": "",
    "age": 4,
    "preferred_language": "zh-CN",
    "interests": [],
    "teaching_preferences": [],
    "learning_goals": [],
    "teacher_style": "warm_guided",
    "content_boundaries": [],
    "enabled_activities": list(DEFAULT_ENABLED_ACTIVITIES),
    "brain_mode": "ai_station",
}

DEFAULT_ACTIVITY_STATE = {
    "status": "idle",
    "activity": "",
    "topic": "",
    "step": 0,
    "started_at": None,
    "updated_at": None,
    "completed_at": None,
}

MEMORY_STATUSES = {"candidate", "durable"}
MEMORY_CATEGORIES = {"profile", "learning", "episodic", "interest", "parent"}
SKILL_STATUSES = {"not_started", "exploring", "practicing", "mastered"}

DEFAULT_SKILLS = (
    ("math.count_1_10", "数学", "数数 1-10", ("数数", "数字", "一二三", "1-10")),
    ("math.count_11_20", "数学", "数数 11-20", ("十一", "十二", "十三", "二十", "11-20")),
    ("math.compare", "数学", "大小与数量比较", ("更大", "更小", "多少", "比较")),
    ("math.addition", "数学", "简单加法", ("加一", "加法", "一共", "总共")),
    ("english.colors", "英语", "颜色词", ("red", "blue", "green", "颜色", "红色", "蓝色", "绿色")),
    ("english.animals", "英语", "动物词", ("dinosaur", "cat", "dog", "动物", "恐龙")),
    ("english.words", "英语", "日常单词", ("英语", "英文", "hello", "apple")),
    ("language.expression", "语言", "表达想法和感受", ("开心", "难过", "因为", "我想", "我觉得")),
    ("creativity.drawing", "创造力", "画画与形状", ("画画", "画", "圆形", "方形", "三角")),
    ("science.curiosity", "科学", "观察与为什么", ("为什么", "月亮", "太空", "科学", "怎么会")),
)

INTEREST_TOPICS = (
    "恐龙",
    "太空",
    "月亮",
    "飞机",
    "积木",
    "画画",
    "唱歌",
    "动物",
    "英语",
    "数字",
    "颜色",
    "故事",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MemoryStore:
    def __init__(self, data_dir: Path, profile_path: Path, history_path: Path, learning_events_path: Path, template_path: Path) -> None:
        self.data_dir = data_dir
        self.profile_path = profile_path
        self.history_path = history_path
        self.learning_events_path = learning_events_path
        self.template_path = template_path
        self.memories_path = data_dir / "memories.json"
        self.skills_path = data_dir / "skill_graph.json"
        self.parent_messages_path = data_dir / "parent_messages.json"
        self.activity_state_path = data_dir / "activity_state.json"
        self._lock = threading.RLock()
        self._interaction_receipts = InteractionReceiptIndex(self.learning_events_path)

    @staticmethod
    def _clean_text(value: Any, limit: int = 240) -> str:
        return " ".join(str(value or "").strip().split())[:limit]

    def _read_json(self, path: Path, default: Any) -> Any:
        if not path.is_file():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return default

    def _write_json(self, path: Path, value: Any) -> None:
        # Keep an unreadable family file intact for recovery, rather than
        # replacing years of data with a default returned by a tolerant read.
        if path.is_file():
            try:
                previous = json.loads(path.read_text(encoding="utf-8"))
            except (UnicodeError, json.JSONDecodeError) as exc:
                raise OSError("Family data needs recovery before updates") from exc
            if path == self.skills_path and not self._valid_skill_graph(previous):
                raise OSError("Skill data needs recovery before updates")
        if path == self.skills_path:
            value = {key: item for key, item in value.items() if key != "recovery_required"}
        self.data_dir.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{path.name}.tmp")
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)

    def _ensure_profile(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if self.profile_path.exists():
            return
        profile = DEFAULT_PROFILE
        if self.template_path.is_file():
            try:
                loaded = json.loads(self.template_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    profile = {**DEFAULT_PROFILE, **loaded}
            except (OSError, UnicodeError, json.JSONDecodeError):
                pass
        self.profile_path.write_text(
            json.dumps(profile, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def get_child_profile(self) -> dict[str, Any]:
        with self._lock:
            self._ensure_profile()
            try:
                value = json.loads(self.profile_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                value = DEFAULT_PROFILE.copy()
            return {**DEFAULT_PROFILE, **value} if isinstance(value, dict) else DEFAULT_PROFILE.copy()

    def update_child_profile(self, updates: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "name",
            "age",
            "preferred_language",
            "interests",
            "teaching_preferences",
            "learning_goals",
            "teacher_style",
            "content_boundaries",
            "enabled_activities",
            "brain_mode",
        }
        clean_updates = {key: value for key, value in updates.items() if key in allowed}
        if "age" in clean_updates:
            age = int(clean_updates["age"])
            if age < 2 or age > 17:
                raise ValueError("age must be between 2 and 17")
            clean_updates["age"] = age
        for key in ("interests", "teaching_preferences", "learning_goals", "content_boundaries"):
            if key in clean_updates:
                value = clean_updates[key]
                if not isinstance(value, list):
                    raise ValueError(f"{key} must be a list")
                clean_updates[key] = [self._clean_text(item, 48) for item in value if self._clean_text(item, 48)][:24]
        if "enabled_activities" in clean_updates:
            value = clean_updates["enabled_activities"]
            if not isinstance(value, list):
                raise ValueError("enabled_activities must be a list")
            clean_updates["enabled_activities"] = list(
                dict.fromkeys(str(item) for item in value if str(item) in DEFAULT_ENABLED_ACTIVITIES)
            )
        if "teacher_style" in clean_updates:
            style = str(clean_updates["teacher_style"])
            if style not in TEACHER_STYLES:
                raise ValueError("unsupported teacher style")
            clean_updates["teacher_style"] = style
        if "brain_mode" in clean_updates:
            mode = str(clean_updates["brain_mode"])
            if mode not in BRAIN_MODES:
                raise ValueError("unsupported brain mode")
            clean_updates["brain_mode"] = mode
        if "name" in clean_updates:
            clean_updates["name"] = self._clean_text(clean_updates["name"], 16)
        if "preferred_language" in clean_updates:
            clean_updates["preferred_language"] = self._clean_text(clean_updates["preferred_language"], 48)
        with self._lock:
            profile = self.get_child_profile()
            profile.update(clean_updates)
            self._write_json(self.profile_path, profile)
            return profile.copy()

    def _read_jsonl(self, path: Path) -> list[dict[str, Any]]:
        if not path.is_file():
            return []
        records: list[dict[str, Any]] = []
        for raw_line in path.read_bytes().splitlines():
            try:
                line = raw_line.decode("utf-8")
                value = json.loads(line)
            except (UnicodeError, json.JSONDecodeError):
                continue
            if isinstance(value, dict):
                records.append(value)
        return records

    def get_history(self) -> list[dict[str, Any]]:
        """Return the complete text-only conversation history in chronological order."""

        with self._lock:
            return self._read_jsonl(self.history_path)

    def get_recent_context(self, limit: int = 8) -> list[dict[str, Any]]:
        with self._lock:
            records = self._read_jsonl(self.history_path)
            return records if limit is None else records[-limit:] if limit > 0 else []

    def get_recent_learning_events(
        self, limit: int | None = 6, *, exclude_types: tuple[str, ...] = (),
    ) -> list[dict[str, Any]]:
        """Filter before limiting; the default keeps all event types for export."""

        with self._lock:
            records = self._read_jsonl(self.learning_events_path)
            if exclude_types:
                records = [record for record in records if record.get("event_type") not in exclude_types]
            return records if limit is None else records[-limit:] if limit > 0 else []

    def _append_jsonl(self, path: Path, record: dict[str, Any]) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def save_session_turn(self, user_text: str, assistant_text: str) -> dict[str, Any]:
        with self._lock:
            record = {
                "created_at": _now(),
                "user_text": user_text,
                "assistant_text": assistant_text,
            }
            self._append_jsonl(self.history_path, record)
            return record

    def save_learning_event(self, event_type: str, payload: dict[str, Any]) -> None:
        with self._lock:
            self._append_jsonl(
                self.learning_events_path,
                {
                    "created_at": _now(),
                    "event_type": event_type,
                    "payload": payload,
                },
            )

    def record_interaction_interval(self, payload: dict[str, Any]) -> bool:
        """Record elapsed frontend contact time independently of voice success."""
        clean = normalize_interval(payload)
        with self._lock:
            previous = self._interaction_receipts.lookup(clean)
            if previous is not None:
                if previous != clean:
                    raise InteractionConflictError("interaction receipt conflicts with an existing interval")
                return False
            now = datetime.now(timezone.utc)
            validate_arrival(clean, now)
            if self.learning_events_path.is_file() and self.learning_events_path.stat().st_size:
                with self.learning_events_path.open("rb") as handle:
                    handle.seek(-1, 2)
                    missing_separator = handle.read(1) != b"\n"
                if missing_separator:
                    # Preserve a crash-truncated tail but do not concatenate
                    # the next good receipt into that unreadable JSON line.
                    with self.learning_events_path.open("ab") as handle:
                        handle.write(b"\n")
            self._append_jsonl(self.learning_events_path, {
                "created_at": now.isoformat(), "event_type": "interaction_interval", "payload": clean,
            })
            self._interaction_receipts.remember(clean)
            return True

    def get_today_interaction(self) -> dict[str, Any]:
        try:
            return today_interaction(self.get_recent_learning_events(limit=None), datetime.now(timezone.utc))
        except (OSError, ValueError, UnicodeError):
            return {"interaction_seconds": 0.0, "interaction_timing_available": False}

    def get_memories(self, status: str = "", limit: int | None = 200) -> list[dict[str, Any]]:
        with self._lock:
            value = self._read_json(self.memories_path, [])
            memories = [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []
            if status:
                memories = [item for item in memories if item.get("status") == status]
            return memories if limit is None else memories[-limit:] if limit > 0 else []

    def add_memory(
        self,
        summary: str,
        *,
        category: str = "episodic",
        status: str = "candidate",
        source: str = "conversation",
        confidence: float = 0.75,
        tags: list[str] | None = None,
        evidence: str = "",
    ) -> dict[str, Any]:
        clean_summary = self._clean_text(summary)
        if not clean_summary:
            raise ValueError("memory summary is empty")
        if category not in MEMORY_CATEGORIES:
            raise ValueError("unsupported memory category")
        if status not in MEMORY_STATUSES:
            raise ValueError("unsupported memory status")
        clean_tags = [self._clean_text(tag, 32) for tag in (tags or []) if self._clean_text(tag, 32)][:8]
        key = re.sub(r"\W+", "", clean_summary).casefold()
        now = _now()
        with self._lock:
            memories = self.get_memories(limit=None)
            for item in memories:
                item_key = re.sub(r"\W+", "", str(item.get("summary", ""))).casefold()
                if item.get("category") == category and item_key == key:
                    item["last_seen_at"] = now
                    item["occurrences"] = int(item.get("occurrences", 1)) + 1
                    item["confidence"] = max(float(item.get("confidence", 0)), min(1.0, float(confidence)))
                    if status == "durable" or (category == "interest" and item["occurrences"] >= 3):
                        item["status"] = "durable"
                    if evidence:
                        item["evidence"] = self._clean_text(evidence)
                    self._write_json(self.memories_path, memories)
                    return item.copy()
            item = {
                "id": uuid.uuid4().hex,
                "created_at": now,
                "last_seen_at": now,
                "category": category,
                "status": status,
                "summary": clean_summary,
                "source": self._clean_text(source, 40) or "unknown",
                "confidence": max(0.0, min(1.0, float(confidence))),
                "occurrences": 1,
                "tags": clean_tags,
                "evidence": self._clean_text(evidence),
            }
            memories.append(item)
            self._write_json(self.memories_path, memories)
            return item.copy()

    def recall_memories(self, query: str, limit: int = 6) -> list[dict[str, Any]]:
        """Recall relevant confirmed family memories without a model dependency."""
        normalized = self._clean_text(query, 2000).casefold()
        terms = set(re.findall(r"[a-z]{3,}", normalized))
        for phrase in re.findall(r"[\u4e00-\u9fff]+", normalized):
            terms.update(phrase[index:index + 2] for index in range(len(phrase) - 1))
        terms.difference_update({"爸爸", "老师", "你还", "还记", "记得", "我们", "什么", "怎么", "一个", "今天", "昨天"})
        memories = self.get_memories(status="durable", limit=None)
        def relevance(item: dict[str, Any]) -> int:
            summary = str(item.get("summary", "")).casefold()
            tags = [str(tag).casefold() for tag in item.get("tags", []) if str(tag)]
            return sum(8 for tag in tags if tag in normalized) + sum(1 for term in terms if term in summary)
        ranked = sorted(enumerate(memories), key=lambda pair: (relevance(pair[1]), pair[0]), reverse=True)
        return [item for _, item in ranked[:max(0, limit)]]

    def update_memory(self, memory_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            memories = self.get_memories(limit=None)
            for item in memories:
                if item.get("id") != memory_id:
                    continue
                if "summary" in updates:
                    summary = self._clean_text(updates["summary"])
                    if not summary:
                        raise ValueError("memory summary is empty")
                    if summary != item.get("summary") and "tags" not in updates:
                        # A corrected statement does not validate its old tags.
                        item["tags"] = []
                    item["summary"] = summary
                if "status" in updates:
                    status = str(updates["status"])
                    if status not in MEMORY_STATUSES:
                        raise ValueError("unsupported memory status")
                    item["status"] = status
                if "category" in updates:
                    category = str(updates["category"])
                    if category not in MEMORY_CATEGORIES:
                        raise ValueError("unsupported memory category")
                    item["category"] = category
                if "tags" in updates:
                    tags = updates["tags"]
                    if not isinstance(tags, list):
                        raise ValueError("tags must be a list")
                    item["tags"] = [self._clean_text(tag, 32) for tag in tags if self._clean_text(tag, 32)][:8]
                item["updated_at"] = _now()
                self._write_json(self.memories_path, memories)
                return item.copy()
        raise KeyError(memory_id)

    def delete_memory(self, memory_id: str) -> bool:
        with self._lock:
            memories = self.get_memories(limit=None)
            remaining = [item for item in memories if item.get("id") != memory_id]
            if len(remaining) == len(memories):
                return False
            self._write_json(self.memories_path, remaining)
            return True

    @staticmethod
    def _default_skill(skill_id: str, domain: str, name: str, keywords: tuple[str, ...]) -> dict[str, Any]:
        return {
            "id": skill_id,
            "domain": domain,
            "name": name,
            "status": "not_started",
            "practice_count": 0,
            "evidence_count": 0,
            "mastery_score": 0.0,
            "last_practiced_at": None,
            "last_evidence": "",
            "keywords": list(keywords),
        }

    @staticmethod
    def _valid_skill_entry(item: Any) -> bool:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            return False
        for key in ("domain", "name", "status", "last_evidence"):
            if key in item and not isinstance(item[key], str):
                return False
        if "status" in item and item["status"] not in SKILL_STATUSES:
            return False
        for key in ("practice_count", "evidence_count"):
            if key in item and (type(item[key]) is not int or item[key] < 0):
                return False
        if "mastery_score" in item and (
            type(item["mastery_score"]) not in (int, float) or not 0 <= item["mastery_score"] <= 1
        ):
            return False
        for key in ("last_practiced_at", "parent_reviewed_at"):
            if key in item and item[key] is not None and not isinstance(item[key], str):
                return False
        if "keywords" in item and (
            not isinstance(item["keywords"], list) or not all(isinstance(word, str) for word in item["keywords"])
        ):
            return False
        return True

    @classmethod
    def _valid_skill_graph(cls, value: Any) -> bool:
        return (isinstance(value, dict) and isinstance(value.get("skills"), list)
                and all(cls._valid_skill_entry(item) for item in value["skills"])
                and len({item["id"] for item in value["skills"]}) == len(value["skills"]))

    def get_skill_graph(self) -> dict[str, Any]:
        with self._lock:
            source_exists = self.skills_path.exists()
            value = self._read_json(self.skills_path, None)
            raw_skills = value.get("skills") if isinstance(value, dict) else None
            defaults = {definition[0]: self._default_skill(*definition) for definition in DEFAULT_SKILLS}
            seen_ids, duplicate_ids = set(), set()
            for item in raw_skills if isinstance(raw_skills, list) else []:
                skill_id = item.get("id") if isinstance(item, dict) else None
                if isinstance(skill_id, str):
                    if skill_id in seen_ids:
                        duplicate_ids.add(skill_id)
                    seen_ids.add(skill_id)
            existing = {}
            for item in raw_skills if isinstance(raw_skills, list) else []:
                # A duplicate ID has no trustworthy winning assessment. Keep
                # its source untouched and use only a provisional default.
                if self._valid_skill_entry(item) and item["id"] not in duplicate_ids:
                    baseline = defaults.get(item["id"]) or self._default_skill(item["id"], "其他", item["id"], ())
                    existing[item["id"]] = {**baseline, **item}
            for skill_id, default in defaults.items():
                existing.setdefault(skill_id, default)
            graph = {
                "version": 1,
                "updated_at": value.get("updated_at") if isinstance(value, dict) else None,
                "skills": list(existing.values()),
            }
            changed = graph["skills"] != raw_skills
            if changed and (not source_exists or self._valid_skill_graph(value)):
                graph["updated_at"] = _now()
                try:
                    self._write_json(self.skills_path, graph)
                except OSError:
                    # Read-only or unavailable storage must not block the dashboard
                    # or conversation. Explicit updates still report write failure.
                    pass
            graph["recovery_required"] = source_exists and not self._valid_skill_graph(value)
            return json.loads(json.dumps(graph, ensure_ascii=False))

    def update_skill(self, skill_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            graph = self.get_skill_graph()
            for skill in graph["skills"]:
                if skill.get("id") != skill_id:
                    continue
                previous_status = skill.get("status")
                if "status" in updates:
                    status = str(updates["status"])
                    if status not in SKILL_STATUSES:
                        raise ValueError("unsupported skill status")
                    skill["status"] = status
                if "mastery_score" in updates:
                    skill["mastery_score"] = max(0.0, min(1.0, float(updates["mastery_score"])))
                if "last_evidence" in updates:
                    skill["last_evidence"] = self._clean_text(updates["last_evidence"])
                    skill["evidence_count"] = int(skill.get("evidence_count", 0)) + 1
                if {"status", "mastery_score", "last_evidence"}.intersection(updates):
                    skill["parent_reviewed_at"] = _now()
                graph["updated_at"] = _now()
                self._write_json(self.skills_path, graph)
                if {"status", "mastery_score", "last_evidence"}.intersection(updates):
                    self.save_learning_event("skill_review", {
                        "skill_id": skill_id, "name": skill.get("name"),
                        "previous_status": previous_status, "status": skill.get("status"),
                        "evidence": skill.get("last_evidence", ""),
                        "source": "parent", "reviewed_at": skill.get("parent_reviewed_at"),
                    })
                return skill.copy()
        raise KeyError(skill_id)

    def update_learning_state(self, user_text: str, assistant_text: str) -> list[dict[str, Any]]:
        combined = f"{user_text} {assistant_text}".casefold()
        changed: list[dict[str, Any]] = []
        with self._lock:
            graph = self.get_skill_graph()
            now = _now()
            for skill in graph["skills"]:
                keywords = [str(word).casefold() for word in skill.get("keywords", [])]
                if not any(word and word in combined for word in keywords):
                    continue
                count = int(skill.get("practice_count", 0)) + 1
                skill["practice_count"] = count
                skill["last_practiced_at"] = now
                if not skill.get("parent_reviewed_at") and skill.get("status") == "not_started":
                    skill["status"] = "exploring"
                elif not skill.get("parent_reviewed_at") and skill.get("status") == "exploring" and count >= 3:
                    skill["status"] = "practicing"
                # Keyword exposure and "I can" claims are not demonstrations.
                # Keep parent evidence/scores intact; self-reports remain
                # reviewable candidates in observe_turn instead.
                changed.append(skill.copy())
            if changed:
                graph["updated_at"] = now
                self._write_json(self.skills_path, graph)
        return changed

    def observe_turn(self, user_text: str, assistant_text: str) -> dict[str, Any]:
        """Extract a small set of reviewable memories and update learning exposure."""

        candidates: list[dict[str, Any]] = []
        clean_user = self._clean_text(user_text)
        clauses = re.split(r"[，,。！？!?；;]|但是|不过|但", clean_user)
        positive_interests = [clause for clause in clauses
                              if any(marker in clause for marker in ("喜欢", "想学", "想听", "想画", "想玩"))
                              and not re.search(r"不喜欢|不喜歡|不想|不要|讨厌|討厭", clause)]
        if positive_interests:
            for topic in INTEREST_TOPICS:
                if any(topic in clause for clause in positive_interests):
                    candidates.append(
                        self.add_memory(
                            f"最近对{topic}感兴趣",
                            category="interest",
                            tags=[topic],
                            evidence=clean_user,
                            confidence=0.8,
                        )
                    )
        milestone = re.search(r"(第一次.{1,28}|我(?:已经)?会.{1,22}了|我能(?!不能).{1,22})", clean_user)
        if milestone:
            candidates.append(
                self.add_memory(
                    self._clean_text(milestone.group(1)),
                    category="episodic",
                    tags=["成长里程碑"],
                    evidence=clean_user,
                    confidence=0.72,
                )
            )
        skills = self.update_learning_state(clean_user, assistant_text)
        return {"memory_candidates": candidates, "skills_updated": skills}

    def add_parent_message(self, text: str) -> dict[str, Any]:
        clean = self._clean_text(text, 500)
        if not clean:
            raise ValueError("parent message is empty")
        with self._lock:
            messages = self.get_parent_messages(limit=None)
            item = {
                "id": uuid.uuid4().hex,
                "created_at": _now(),
                "text": clean,
                "status": "pending",
                "delivered_at": None,
                "delivered_in_reply": "",
                "child_response": "",
                "response_at": None,
            }
            messages.append(item)
            self._write_json(self.parent_messages_path, messages)
            return item.copy()

    def get_parent_messages(self, limit: int | None = 100) -> list[dict[str, Any]]:
        with self._lock:
            value = self._read_json(self.parent_messages_path, [])
            messages = [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []
            return messages if limit is None else messages[-limit:] if limit > 0 else []

    def get_pending_parent_message(self) -> dict[str, Any] | None:
        for item in self.get_parent_messages(limit=None):
            if item.get("status") == "pending":
                return item
        return None

    def mark_parent_message_delivered(self, message_id: str, assistant_text: str) -> dict[str, Any]:
        """Mark only the parent message that was actually spoken to the child."""

        with self._lock:
            messages = self.get_parent_messages(limit=None)
            for item in messages:
                if item.get("id") != message_id:
                    continue
                if item.get("status") != "pending":
                    return item.copy()
                item["status"] = "delivered"
                item["delivered_at"] = _now()
                item["delivered_in_reply"] = self._clean_text(assistant_text)
                self._write_json(self.parent_messages_path, messages)
                return item.copy()
        raise KeyError(message_id)

    def parent_message_response_target(self, child_text: str) -> str:
        """Associate only a nearby reply with the most recent spoken message."""

        clean = self._clean_text(child_text)
        if not clean:
            return ""
        # A new question/activity is not an acknowledgement of an older message.
        directed_to_parent = any(word in clean.replace("爸爸老师", "") for word in ("爸爸", "妈妈"))
        if not directed_to_parent and re.search(
            r"为什么|为什麼|怎么|什[么麼]|教我|我[想要].*(?:学|听|画|玩)|讲.*故事|我回来了", clean
        ):
            return ""
        with self._lock:
            messages = self.get_parent_messages(limit=None)
            delivered = [item for item in messages if item.get("delivered_at")]
            if not delivered:
                return ""
            item = max(delivered, key=lambda value: str(value.get("delivered_at", "")))
            timestamp = self._local_datetime(item.get("delivered_at"))
            if (item.get("status") != "delivered" or item.get("child_response") or timestamp is None
                    or not 0 <= (datetime.now().astimezone() - timestamp).total_seconds() <= 600):
                return ""
            recent = self.get_history()
            if recent and recent[-1].get("assistant_text") != item.get("delivered_in_reply"):
                return ""
            return str(item.get("id", ""))

    def capture_parent_message_response(
        self, child_text: str, message_id: str | None = None,
    ) -> dict[str, Any] | None:
        clean = self._clean_text(child_text)
        if not clean:
            return None
        target_id = self.parent_message_response_target(clean) if message_id is None else message_id
        if not target_id:
            return None
        with self._lock:
            messages = self.get_parent_messages(limit=None)
            for item in reversed(messages):
                if item.get("id") != target_id or item.get("status") != "delivered" or item.get("child_response"):
                    continue
                item["status"] = "responded"
                item["child_response"] = clean
                item["response_at"] = _now()
                self._write_json(self.parent_messages_path, messages)
                return item.copy()
        return None

    def cancel_parent_message(self, message_id: str) -> dict[str, Any]:
        with self._lock:
            messages = self.get_parent_messages(limit=None)
            for item in messages:
                if item.get("id") == message_id:
                    if item.get("status") == "pending":
                        item["status"] = "cancelled"
                    self._write_json(self.parent_messages_path, messages)
                    return item.copy()
        raise KeyError(message_id)

    def get_activity_state(self, *, include_stale: bool = False) -> dict[str, Any]:
        """Return the current step; explicit welcomes may inspect a paused checkpoint."""

        with self._lock:
            value = self._read_json(self.activity_state_path, DEFAULT_ACTIVITY_STATE.copy())
            if not isinstance(value, dict):
                return DEFAULT_ACTIVITY_STATE.copy()
            state = {**DEFAULT_ACTIVITY_STATE, **value}
            if state.get("status") != "active" or state.get("activity") not in ACTIVITY_KINDS:
                state.update({"status": "idle", "activity": "", "topic": "", "step": 0})
            elif state.get("updated_at"):
                try:
                    updated_at = datetime.fromisoformat(str(state["updated_at"]).replace("Z", "+00:00"))
                    if (not include_stale and
                            datetime.now(timezone.utc) - updated_at.astimezone(timezone.utc) > timedelta(hours=6)):
                        state.update(
                            {
                                "status": "idle",
                                "last_activity": state.get("activity", ""),
                                "last_topic": state.get("topic", ""),
                                "activity": "",
                                "topic": "",
                                "step": 0,
                            }
                        )
                except (TypeError, ValueError):
                    state.update({"status": "idle", "activity": "", "topic": "", "step": 0})
            return state

    def apply_activity_transition(self, transition: dict[str, Any]) -> dict[str, Any]:
        """Commit an activity step only after the spoken turn itself is committed."""

        if not isinstance(transition, dict):
            raise ValueError("activity transition must be an object")
        action = str(transition.get("action", ""))
        now = _now()
        with self._lock:
            previous = self.get_activity_state()
            if action == "clear":
                state = {
                    **DEFAULT_ACTIVITY_STATE,
                    "completed_at": now,
                    "updated_at": now,
                    "last_activity": previous.get("activity", ""),
                    "last_topic": previous.get("topic", ""),
                }
            elif action == "set":
                activity = str(transition.get("activity", ""))
                if activity not in ACTIVITY_KINDS:
                    raise ValueError("unsupported activity")
                try:
                    step = int(transition.get("step", 1))
                except (TypeError, ValueError) as exc:
                    raise ValueError("activity step must be a number") from exc
                if step < 1 or step > 12:
                    raise ValueError("activity step must be between 1 and 12")
                same_activity = previous.get("status") == "active" and previous.get("activity") == activity
                state = {
                    **DEFAULT_ACTIVITY_STATE,
                    "status": "active",
                    "activity": activity,
                    "topic": self._clean_text(transition.get("topic") or activity, 48),
                    "step": step,
                    "started_at": previous.get("started_at") if same_activity else now,
                    "updated_at": now,
                }
            else:
                raise ValueError("unsupported activity transition")
            self._write_json(self.activity_state_path, state)
            return state.copy()

    def delete_family_data(self, scopes: list[str]) -> dict[str, Any]:
        """Delete only explicit, known family-data files; never touch models or media."""

        if not isinstance(scopes, list) or not scopes:
            raise ValueError("at least one data scope is required")
        requested = {str(scope) for scope in scopes}
        if "all" in requested:
            requested = set(FAMILY_DATA_SCOPES)
        unknown = requested - FAMILY_DATA_SCOPES
        if unknown:
            raise ValueError(f"unsupported data scopes: {', '.join(sorted(unknown))}")
        paths = {
            "profile": self.profile_path,
            "history": self.history_path,
            "learning_events": self.learning_events_path,
            "memories": self.memories_path,
            "skills": self.skills_path,
            "parent_messages": self.parent_messages_path,
            "activity": self.activity_state_path,
        }
        data_root = self.data_dir.resolve()
        deleted: dict[str, bool] = {}
        with self._lock:
            for scope in sorted(requested):
                path = paths[scope]
                if path.resolve().parent != data_root:
                    raise ValueError("family data path escaped the data directory")
                existed = path.is_file()
                path.unlink(missing_ok=True)
                if scope == "learning_events":
                    self._interaction_receipts.reset()
                deleted[scope] = existed
        return {"deleted": deleted, "raw_media_deleted": False}

    def next_activity(self) -> dict[str, Any]:
        profile = self.get_child_profile()
        interests = self.get_memories(status="durable", limit=200)
        saved_interests = profile.get("interests") or []
        interest = saved_interests[0] if saved_interests else next(
            (item.get("tags", [""])[0] for item in reversed(interests) if item.get("category") == "interest" and item.get("tags")),
            "身边的东西",
        )
        skills = self.get_skill_graph()["skills"]
        if "drawing" not in profile.get("enabled_activities", DEFAULT_ENABLED_ACTIVITIES):
            skills = [skill for skill in skills if skill.get("id") != "creativity.drawing"]
        unfinished = [skill for skill in skills if skill.get("status") != "mastered"]
        active = [skill for skill in unfinished if skill.get("status") in {"exploring", "practicing"}]
        skill = min(active or unfinished or skills, key=lambda item: (item.get("last_practiced_at") or "", item.get("practice_count", 0)))
        prompts = {
            "数学": f"用{interest}做一个数数或比较大小的小练习",
            "英语": f"从{interest}里学一个简单英文词，并让孩子模仿",
            "语言": f"请孩子用一句话说说{interest}",
            "创造力": f"一起画一个和{interest}有关的简单图形",
            "科学": f"观察真实物品，问一个和{interest}有关的为什么",
        }
        return {
            "skill_id": skill["id"],
            "skill_name": skill["name"],
            "theme": interest,
            "suggestion": (f"轻松复习{skill['name']}，也可以让孩子选择新的问题"
                           if not unfinished else prompts.get(skill.get("domain"), f"围绕{interest}做一个简短问答")),
        }

    def get_continuity_cue(self) -> dict[str, Any]:
        """Return one evidence-backed cue for a warm welcome-back turn."""

        # A night's pause ends automatic continuation, not the child's work.
        # Only an explicit welcome uses the original unfinished checkpoint;
        # clear/completed records still stay idle and cannot be resurrected.
        activity = self.get_activity_state(include_stale=True)
        if activity.get("status") == "active":
            return {
                "kind": "activity",
                "topic": self._clean_text(activity.get("topic"), 48),
                "activity": activity.get("activity", ""),
                "step": activity.get("step", 1),
            }
        for item in reversed(self.get_memories(status="durable", limit=200)):
            if item.get("category") != "interest":
                continue
            tags = item.get("tags") if isinstance(item.get("tags"), list) else []
            topic = self._clean_text(tags[0] if tags else "", 32)
            if topic:
                return {"kind": "durable_interest", "topic": topic}
        for record in reversed(self.get_recent_context(limit=20)):
            combined = f"{record.get('user_text', '')} {record.get('assistant_text', '')}"
            topic = next((candidate for candidate in INTEREST_TOPICS if candidate in combined), "")
            if topic:
                return {"kind": "recent_topic", "topic": topic}
        return {"kind": "none", "topic": ""}

    @staticmethod
    def _is_today(value: Any) -> bool:
        try:
            timestamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return timestamp.astimezone().date() == datetime.now().astimezone().date()
        except ValueError:
            return False

    @staticmethod
    def _local_datetime(value: Any) -> datetime | None:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone()
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _append_unique(values: list[str], value: Any, limit: int = 12) -> None:
        clean = " ".join(str(value or "").strip().split())
        if clean and clean not in values and len(values) < limit:
            values.append(clean)

    @staticmethod
    def _clean_observation(value: Any) -> str:
        clean = " ".join(str(value or "").replace("**", "").replace("#", "").strip().split())
        clean = re.sub(r"^爸爸老师[：，, ]*(?:你好[！!，, ]*)?", "", clean)
        clean = re.sub(r"^(?:适合4岁孩子的)?可见事实[：:]\s*", "", clean)
        clean = re.split(r"(?:适合4岁孩子的)?可以回应孩子的简单问题[：:]", clean, maxsplit=1)[0]
        return clean.strip(" “”,，。")[:120]

    @staticmethod
    def _journal_bucket(buckets: dict[str, dict[str, Any]], timestamp: datetime) -> dict[str, Any]:
        year, week, _ = timestamp.isocalendar()
        key = f"{year}-W{week:02d}"
        return buckets.setdefault(
            key,
            {
                "week": key,
                "conversation_turns": 0,
                "active_days": set(),
                "topics": [],
                "questions": [],
                "difficulties": [],
                "milestones": [],
                "milestone_candidates": [],
                "skill_reviews": [],
                "observations": [],
                "parent_connections": [],
                "skill_counts": {},
                "number_practice": {},
            },
        )

    def get_growth_journal(self) -> list[dict[str, Any]]:
        """Rebuild every weekly journal from append-only structured family data."""

        buckets: dict[str, dict[str, Any]] = {}
        now = datetime.now().astimezone()
        self._journal_bucket(buckets, now)

        for record in self.get_history():
            timestamp = self._local_datetime(record.get("created_at"))
            if timestamp is None:
                continue
            bucket = self._journal_bucket(buckets, timestamp)
            bucket["conversation_turns"] += 1
            bucket["active_days"].add(timestamp.date().isoformat())
            user_text = self._clean_text(record.get("user_text"))
            assistant_text = self._clean_text(record.get("assistant_text"))
            combined = f"{user_text} {assistant_text}".casefold()
            for topic in INTEREST_TOPICS:
                if topic.casefold() in combined:
                    self._append_unique(bucket["topics"], topic)
            if any(marker in user_text for marker in ("为什么", "什么", "怎么")):
                self._append_unique(bucket["questions"], user_text, 8)
            if any(marker in user_text for marker in ("不会", "不知道", "不懂", "太难", "记不住", "错了", "忘了")):
                self._append_unique(bucket["difficulties"], user_text, 8)
            for _, _, skill_name, keywords in DEFAULT_SKILLS:
                if any(str(keyword).casefold() in combined for keyword in keywords):
                    counts = bucket["skill_counts"]
                    counts[skill_name] = int(counts.get(skill_name, 0)) + 1

        for item in self.get_memories(limit=None):
            if item.get("category") != "episodic":
                continue
            timestamp = self._local_datetime(item.get("created_at"))
            if timestamp is not None:
                self._append_unique(
                    self._journal_bucket(buckets, timestamp)[
                        "milestones" if item.get("status") == "durable" else "milestone_candidates"
                    ],
                    item.get("summary"),
                    12,
                )

        for event in self.get_recent_learning_events(limit=None):
            if event.get("event_type") == "practice_attempt":
                timestamp = self._local_datetime(event.get("created_at"))
                attempt = event.get("payload")
                if (timestamp is not None and isinstance(attempt, dict)
                        and attempt.get("source") == "local_number_activity"
                        and attempt.get("activity") == "numbers"
                        and attempt.get("result") in ("correct", "incorrect")
                        and isinstance(attempt.get("question_id"), str) and attempt["question_id"].strip()
                        and isinstance(attempt.get("question"), str) and attempt["question"].strip()):
                    checks = self._journal_bucket(buckets, timestamp)["number_practice"]
                    check = checks.setdefault(str(attempt["question_id"]), {
                        "source": "local_number_activity", "activity": "numbers",
                        "question_id": str(attempt["question_id"]),
                        "skill_id": self._clean_text(attempt.get("skill_id"), 80),
                        "question": self._clean_text(attempt["question"], 80),
                        "correct": 0, "incorrect": 0, "last_result": "", "last_at": "",
                    })
                    check[attempt["result"]] += 1
                    if not check["last_at"] or timestamp >= datetime.fromisoformat(check["last_at"]):
                        check["last_result"] = attempt["result"]
                        check["last_at"] = timestamp.isoformat()
                continue
            if event.get("event_type") == "skill_review":
                timestamp = self._local_datetime(event.get("created_at"))
                review = event.get("payload")
                if timestamp is not None and isinstance(review, dict) and review.get("source") == "parent":
                    self._journal_bucket(buckets, timestamp)["skill_reviews"].append(review)
                continue
            if event.get("event_type") not in {"vision", "vision_video", "vision_auto"}:
                continue
            timestamp = self._local_datetime(event.get("created_at"))
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            if timestamp is not None:
                observation = self._clean_observation(payload.get("description"))
                self._append_unique(self._journal_bucket(buckets, timestamp)["observations"], observation, 8)

        for message in self.get_parent_messages(limit=None):
            timestamp = self._local_datetime(
                message.get("response_at") or message.get("delivered_at") or message.get("created_at")
            )
            if timestamp is None or message.get("status") not in {"delivered", "responded"}:
                continue
            connection = self._clean_text(message.get("text"), 120)
            response = self._clean_text(message.get("child_response"), 120)
            if response:
                connection = f"爸爸留言：{connection}；孩子回应：{response}"
            self._append_unique(
                self._journal_bucket(buckets, timestamp)["parent_connections"],
                connection,
                8,
            )

        journals: list[dict[str, Any]] = []
        for week_key in sorted(buckets):
            bucket = buckets[week_key]
            counts = bucket.pop("skill_counts")
            number_practice = bucket.pop("number_practice")
            bucket["practice_results"] = list(number_practice.values())
            repeated_difficulties = [check for check in number_practice.values() if check["incorrect"] >= 3]
            for check in repeated_difficulties:
                latest = "最近一次已答对" if check["last_result"] == "correct" else "最近一次仍需再试"
                self._append_unique(
                    bucket["difficulties"],
                    f"{check['question']}本周有{check['incorrect']}次回答需要再试，{latest}。",
                    12,
                )
            progress = []
            for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
                # Retain the old string field for clients, but retire arrows:
                # more topic mentions cannot establish an ability improvement.
                progress.append({"name": name, "turns": count, "trend": "",
                                 "trend_deprecated": True, "source": "topic_exposure"})
            bucket["active_days"] = len(bucket["active_days"])
            bucket["observations"] = bucket["observations"][-3:]
            bucket["learning_progress"] = progress
            bucket["practiced_skills"] = [item["name"] for item in progress]
            theme = bucket["topics"][0] if bucket["topics"] else "身边的东西"
            skill_name = progress[0]["name"] if progress else "自由表达"
            bucket["recommendation"] = f"继续用{theme}练习{skill_name}，每次只走一小步。"
            if repeated_difficulties:
                question = repeated_difficulties[0]["question"]
                bucket["recommendation"] = f"用真实积木轻松复习“{question}”，请孩子边摆边数；一次答对还不代表独立掌握。"
            bucket["summary"] = (
                f"{bucket['active_days']} 天、{bucket['conversation_turns']} 轮互动"
                + (f"，主要围绕{'、'.join(bucket['topics'][:3])}" if bucket["topics"] else "")
            )
            journals.append(bucket)
        return list(reversed(journals))

    @staticmethod
    def _is_current_week(value: Any, year: int, week: int) -> bool:
        try:
            timestamp = datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone()
            iso = timestamp.isocalendar()
            return iso.year == year and iso.week == week
        except ValueError:
            return False

    def get_parent_dashboard(self) -> dict[str, Any]:
        history = self.get_history()
        today = [item for item in history if self._is_today(item.get("created_at"))]
        topics = [topic for topic in INTEREST_TOPICS if any(topic in str(item.get("user_text", "")) for item in today)]
        questions = [
            self._clean_text(item.get("user_text"))
            for item in today
            if any(marker in str(item.get("user_text", "")) for marker in ("为什么", "什么", "怎么"))
        ]
        memories = self.get_memories(limit=None)
        return {
            "generated_at": _now(),
            "profile": self.get_child_profile(),
            "today": {
                **self.get_today_interaction(),
                "conversation_turns": len(today),
                "topics": topics,
                "questions": questions[-6:],
                "recent_turns": today[-8:],
            },
            "memory_tiers": {
                "temporary": "只存在于当前处理内存，不落盘",
                "session_count": len(history),
                "candidate_count": sum(item.get("status") == "candidate" for item in memories),
                "durable_count": sum(item.get("status") == "durable" for item in memories),
            },
            "memories": memories[-12:],
            "skill_graph": self.get_skill_graph(),
            "current_activity": self.get_activity_state(),
            "next_activity": self.next_activity(),
            "parent_messages": self.get_parent_messages(limit=20),
            "growth_journal": self.get_growth_journal(),
        }

    def export_bundle(self) -> dict[str, Any]:
        return {
            "format": "family-ai-teacher-export-v1",
            "exported_at": _now(),
            "raw_media_included": False,
            "profile": self.get_child_profile(),
            "history": self.get_history(),
            "learning_events": self.get_recent_learning_events(limit=None),
            "memories": self.get_memories(limit=None),
            "skill_graph": self.get_skill_graph(),
            "current_activity": self.get_activity_state(),
            "parent_messages": self.get_parent_messages(limit=None),
            "growth_journal": self.get_growth_journal(),
        }
