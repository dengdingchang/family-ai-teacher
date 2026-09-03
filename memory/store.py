"""Privacy-minimal local profile, text history, and learning-event store."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_PROFILE = {
    "name": "",
    "age": 4,
    "preferred_language": "zh-CN",
    "interests": [],
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MemoryStore:
    def __init__(self, data_dir: Path, profile_path: Path, history_path: Path, learning_events_path: Path, template_path: Path) -> None:
        self.data_dir = data_dir
        self.profile_path = profile_path
        self.history_path = history_path
        self.learning_events_path = learning_events_path
        self.template_path = template_path
        self._lock = threading.RLock()

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
            except (OSError, json.JSONDecodeError):
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
            except (OSError, json.JSONDecodeError):
                value = DEFAULT_PROFILE.copy()
            return {**DEFAULT_PROFILE, **value} if isinstance(value, dict) else DEFAULT_PROFILE.copy()

    def get_recent_context(self, limit: int = 8) -> list[dict[str, Any]]:
        with self._lock:
            if not self.history_path.is_file():
                return []
            records: list[dict[str, Any]] = []
            for line in self.history_path.read_text(encoding="utf-8").splitlines():
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    records.append(value)
            return records[-max(0, limit) :]

    def _append_jsonl(self, path: Path, record: dict[str, Any]) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def save_session_turn(self, user_text: str, assistant_text: str) -> None:
        with self._lock:
            self._append_jsonl(
                self.history_path,
                {
                    "created_at": _now(),
                    "user_text": user_text,
                    "assistant_text": assistant_text,
                },
            )

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
