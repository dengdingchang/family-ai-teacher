"""Growth summaries separate exposure, committed attempts and parent reviews."""

import asyncio
import threading
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import app.main as main
from memory.store import MemoryStore


@pytest.fixture
def store(tmp_path, monkeypatch):
    data = tmp_path / "data"
    store = MemoryStore(data, data / "profile.json", data / "history.jsonl",
                        data / "events.jsonl", tmp_path / "missing.json")
    store.update_child_profile({"name": "成长测试宝贝", "brain_mode": "local_lessons_only"})
    monkeypatch.setattr(main, "memory", store)
    return store


def number_attempt(**changes):
    return {"source": "local_number_activity", "activity": "numbers", "step": 2,
            "skill_id": "math.addition", "question_id": "add_2_1",
            "question": "两加一，一共有几个？", "answer": "三", "result": "correct", **changes}


def completed_answer(store, answer, *, cancel=False):
    reply, transition = main._activity_turn_reply(answer, store.get_child_profile())
    turn_id = uuid.uuid4().hex
    try:
        main._register_stream_turn(turn_id, threading.Event())
        assert main._stage_stream_turn(turn_id, answer, reply, activity_transition=transition)
        if cancel:
            main._cancel_stream_turn(turn_id)
            with pytest.raises(HTTPException):
                asyncio.run(main.complete_streaming_turn(turn_id))
        else:
            asyncio.run(main.complete_streaming_turn(turn_id))
            asyncio.run(main.complete_streaming_turn(turn_id))  # A retried receipt is not another attempt.
    finally:
        with main._stream_turn_lock:
            main._stream_turns.pop(turn_id, None)


def test_topic_exposure_has_no_ability_arrow_and_unknown_events_are_not_practice(store):
    for stamp in ("2026-08-25T10:00:00+08:00", "2026-09-01T10:00:00+08:00", "2026-09-01T10:05:00+08:00"):
        store._append_jsonl(store.history_path, {"created_at": stamp,
            "user_text": "我不想学英语", "assistant_text": "Apple 是苹果。"})
        store.update_learning_state("我不想学英语", "Apple 是苹果。")
    for kind, changes in (("conversation", {}), ("unknown", {}),
                          ("practice_attempt", {"source": "unverified"}),
                          ("practice_attempt", {"activity": "drawing"}),
                          ("practice_attempt", {"result": ["correct"]}),
                          ("practice_attempt", {"question_id": " "}),
                          ("practice_attempt", {"question": {"text": "two plus one"}})):
        store.save_learning_event(kind, number_attempt(**changes))
    before = (store.history_path.read_bytes(), store.learning_events_path.read_bytes())
    weeks = store.get_growth_journal()
    week = next(item for item in weeks if item["week"] == "2026-W36")
    assert week["learning_progress"] == [{"name": "日常单词", "turns": 2, "trend": "",
                                         "trend_deprecated": True, "source": "topic_exposure"}]
    assert week["practiced_skills"] == ["日常单词"]  # Existing exposure field remains compatible.
    assert all(item["practice_results"] == [] for item in weeks)
    skill = next(item for item in store.get_skill_graph()["skills"] if item["id"] == "english.words")
    assert skill["status"] == "practicing" and skill["practice_count"] == 3
    assert skill["mastery_score"] == skill["evidence_count"] == 0
    assert before == (store.history_path.read_bytes(), store.learning_events_path.read_bytes())


def test_committed_attempts_show_question_results_while_cancelled_and_other_weeks_stay_separate(store):
    store.apply_activity_transition({"action": "set", "activity": "numbers", "step": 2})
    completed_answer(store, "三", cancel=True)
    assert store.get_growth_journal()[0]["practice_results"] == []
    assert not store.get_history()
    completed_answer(store, "四")
    completed_answer(store, "三")
    store.apply_activity_transition({"action": "set", "activity": "numbers", "step": 3})
    completed_answer(store, "五")
    # Imported old evidence keeps its original week, even when appended last.
    previous_week = datetime.now(timezone.utc) - timedelta(days=7)
    store._append_jsonl(store.learning_events_path, {"created_at": previous_week.isoformat(),
        "event_type": "practice_attempt", "payload": number_attempt(result="incorrect", answer="四")})
    week = store.get_growth_journal()[0]
    checks = {item["question_id"]: item for item in week["practice_results"]}
    assert set(checks) == {"add_2_1", "add_3_2"}
    assert checks["add_2_1"]["question"] == "两加一，一共有几个？"
    assert (checks["add_2_1"]["correct"], checks["add_2_1"]["incorrect"], checks["add_2_1"]["last_result"]) == (1, 1, "correct")
    assert checks["add_2_1"]["source"] == "local_number_activity" and checks["add_2_1"]["last_at"]
    assert checks["add_3_2"]["correct"] == 1 and checks["add_3_2"]["incorrect"] == 0
    assert store.get_growth_journal()[1]["practice_results"][0]["incorrect"] == 1
    assert not week["milestones"] and not week["difficulties"]
    assert all(skill["mastery_score"] == skill["evidence_count"] == 0 for skill in store.get_skill_graph()["skills"])
    assert len([item for item in store.get_recent_learning_events(limit=None) if item["event_type"] == "practice_attempt"]) == 4


def test_parent_reviews_keep_state_changes_and_evidence_after_reload_without_rewriting_records(store):
    store.update_skill("math.addition", {"status": "practicing", "last_evidence": "临时家长观察：在提示下完成"})
    reviewed = store.update_skill("math.addition", {"status": "mastered", "mastery_score": 1,
                                                    "last_evidence": "临时家长观察：独立摆出两加一"})
    store.update_learning_state("我不会加法", "我们慢慢试")
    store.save_learning_event("practice_attempt", number_attempt(result="incorrect", answer="四"))
    original = store.learning_events_path.read_bytes()
    reloaded = MemoryStore(store.data_dir, store.profile_path, store.history_path,
                           store.learning_events_path, store.template_path)
    journal = reloaded.get_growth_journal()[0]
    reviews = journal["skill_reviews"]
    assert [(item["previous_status"], item["status"]) for item in reviews] == [
        ("not_started", "practicing"), ("practicing", "mastered"),
    ]
    assert all(item["source"] == "parent" for item in reviews)
    assert reviews[-1]["evidence"] == reviewed["last_evidence"]
    skill = next(item for item in reloaded.get_skill_graph()["skills"] if item["id"] == "math.addition")
    for field in ("status", "mastery_score", "last_evidence", "evidence_count", "parent_reviewed_at"):
        assert skill[field] == reviewed[field]
    assert journal["practice_results"][0]["incorrect"] == 1
    assert reloaded.learning_events_path.read_bytes() == original
    assert len(reloaded.export_bundle()["learning_events"]) == 3
