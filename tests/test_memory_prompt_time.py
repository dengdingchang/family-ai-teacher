"""Recorded dates accompany recalled memories without inventing event dates."""
import json
import app.main as main
from memory.store import MemoryStore


def test_old_memory_keeps_its_recorded_date_source_and_correction_separate():
    record = {"summary": "今天第一次完整数到二十", "source": "parent",
              "created_at": "2025-06-01T09:00:00+08:00",
              "last_seen_at": "2026-08-01T09:00:00+08:00", "updated_at": "2026-08-02T09:00:00+08:00"}
    prompt = main._system_prompt({}, [], [record], {"skills": []}, {}, None)
    line = next(line for line in prompt.splitlines() if line.startswith("确认过的长期记忆"))
    encoded = json.loads(line.split("：", 1)[1])[0]
    assert encoded == {"summary": record["summary"], "source": "parent", "recorded_at": record["created_at"],
                       "last_mentioned_at": record["last_seen_at"], "corrected_at": record["updated_at"]}
    assert "不自动等于事件发生时间" in prompt and "当前本地时间" in prompt


def test_recall_supplies_old_dates_without_writing_or_promoting_a_candidate(tmp_path, monkeypatch):
    store = MemoryStore(tmp_path, tmp_path / "profile.json", tmp_path / "history.jsonl", tmp_path / "events.jsonl", tmp_path / "missing.json")
    durable = store.add_memory("今天第一次数到了二十", source="parent", status="durable")
    store.add_memory("今天第一次见到蓝鲸", source="conversation", status="candidate")
    monkeypatch.setattr(main, "memory", store)
    before = store.memories_path.read_bytes()
    prompt = main._messages_for("我第一次数到二十是什么时候？")[0]["content"]
    assert durable["created_at"] in prompt and "第一次数到了二十" in prompt
    assert "第一次见到蓝鲸" not in prompt
    assert store.memories_path.read_bytes() == before
