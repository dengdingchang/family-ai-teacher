"""A child's report can continue a search without becoming visual evidence."""

import asyncio
import json
import threading
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.main as main
from memory.store import MemoryStore


@pytest.fixture
def store(tmp_path, monkeypatch):
    data = tmp_path / "data"
    store = MemoryStore(data, data / "profile.json", data / "history.jsonl",
                        data / "events.jsonl", tmp_path / "missing.json")
    store.update_child_profile({"name": "临时测试宝贝", "brain_mode": "local_lessons_only",
                                "enabled_activities": ["game", "vision_photo"]})
    monkeypatch.setattr(main, "memory", store)
    return store


@pytest.mark.parametrize("activity,step,answer,next_step", [
    ("colors", 1, "我找到了", 2),
    ("game", 1, "我已经找到了，然后呢？", 2),
    ("game", 1, "就在我的玩具盒里", 2),
    ("colors", 1, "它就在桌子上。", 2),
    ("game", 2, "两个都找到了，然后呢？", 3),
    ("game", 2, "我已经找好了", 3),
])
def test_search_reports_propose_the_next_step_without_claiming_sight(store, activity, step, answer, next_step):
    store.apply_activity_transition({"action": "set", "activity": activity, "step": step})
    reply, transition = main._activity_turn_reply(answer, store.get_child_profile())
    assert transition["step"] == next_step
    assert "你说" in reply
    assert not any(claim in reply for claim in ("我看到", "我看见", "答对", "掌握", "学会"))
    assert store.get_activity_state()["step"] == step
    assert store.get_history() == []


@pytest.mark.parametrize("step,answer", [
    (1, "我还没找到，然后呢？"), (1, "我找到了吗？"),
    (1, "我不知道是不是找到了"), (1, "我正在玩具盒里找"),
    (1, "找到再说"), (1, "我找到了什么"), (1, "如果找到了然后呢？"),
    (1, "我找到了蓝色的"), (1, "故事里有一个玩具盒"),
    (2, "我只找到一个蓝色的"), (2, "我找到了一个蓝色的"),
    (2, "只有一个在玩具盒里"), (2, "找到了几个？"),
])
def test_uncertain_incomplete_or_unrelated_reports_do_not_advance(store, step, answer):
    store.apply_activity_transition({"action": "set", "activity": "game", "step": step})
    _, transition = main._activity_turn_reply(answer, store.get_child_profile())
    assert transition["step"] == step


@pytest.mark.parametrize("answer", ["兩個", "两个", "俩", "倆個", "俩个", "两", "一共有兩個", "我数了两个"])
def test_two_count_variants_finish_the_game_without_claiming_sight(store, answer):
    store.apply_activity_transition({"action": "set", "activity": "game", "step": 3})
    reply, transition = main._activity_turn_reply(answer, store.get_child_profile())
    assert transition == {"action": "clear"}
    assert "两个" in reply
    assert not any(claim in reply for claim in ("我看到", "我看见", "掌握", "学会"))


@pytest.mark.parametrize("answer", ["不是两个", "可能兩個", "兩個吗？", "两个？", "三个", "一个", "不知道"])
def test_uncertain_or_wrong_count_does_not_finish(store, answer):
    store.apply_activity_transition({"action": "set", "activity": "game", "step": 3})
    _, transition = main._activity_turn_reply(answer, store.get_child_profile())
    assert transition["step"] == 3 and transition["action"] == "set"


@pytest.mark.parametrize("cancel", [False, True])
def test_report_only_commits_after_playback_and_never_sets_mastery(store, cancel):
    store.apply_activity_transition({"action": "set", "activity": "game", "step": 1})
    before = {skill["id"]: (skill["mastery_score"], skill["evidence_count"])
              for skill in store.get_skill_graph()["skills"]}
    answer = "我已经找到了，然后呢？"
    reply, transition = main._activity_turn_reply(answer, store.get_child_profile())
    turn_id = uuid.uuid4().hex
    try:
        main._register_stream_turn(turn_id, threading.Event())
        assert main._stage_stream_turn(turn_id, answer, reply, activity_transition=transition)
        assert store.get_activity_state()["step"] == 1
        assert not store.get_history()
        if cancel:
            main._cancel_stream_turn(turn_id)
            with pytest.raises(HTTPException):
                asyncio.run(main.complete_streaming_turn(turn_id))
        else:
            asyncio.run(main.complete_streaming_turn(turn_id))
            asyncio.run(main.complete_streaming_turn(turn_id))
        assert store.get_activity_state()["step"] == (1 if cancel else 2)
        assert len(store.get_history()) == (0 if cancel else 1)
        assert before == {skill["id"]: (skill["mastery_score"], skill["evidence_count"])
                          for skill in store.get_skill_graph()["skills"]}
        assert not any(event["event_type"] in {"vision", "practice_attempt", "skill_review"}
                       for event in store.get_recent_learning_events(limit=None))
    finally:
        with main._stream_turn_lock:
            main._stream_turns.pop(turn_id, None)


@pytest.mark.parametrize("text,expected", [
    ("这里红色看得见吗", True), ("你能看见这个红色的东西吗？", True),
    ("爸爸老师，这个你看得见吗？", True),
    ("昨天这里红色看得见吗", False), ("故事里这个你看得见吗", False),
    ("不用看这里的红色", False), ("我已经找到了，然后呢？", False),
])
def test_visibility_question_is_an_explicit_current_request(text, expected):
    assert main._explicit_visual_request(text) is expected


def test_visibility_question_requests_a_frame_before_any_activity_reply(store, monkeypatch):
    store.apply_activity_transition({"action": "set", "activity": "game", "step": 1})
    monkeypatch.setattr(main, "transcribe", AsyncMock(return_value={"text": "这里红色看得见吗"}))
    def unexpected(*args, **kwargs):
        raise AssertionError("a first-frame request must not run a model or activity reply")
    monkeypatch.setattr(main, "_stream_conversation", unexpected)
    monkeypatch.setattr(main, "llm", SimpleNamespace(describe_image=unexpected))
    response = TestClient(main.app).post("/api/conversation/stream",
        files={"audio": ("synthetic.wav", b"synthetic-audio", "audio/wav")})
    assert response.status_code == 200
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert events == [{"event": "vision_request", "text": "这里红色看得见吗"}]
    assert store.get_activity_state()["step"] == 1
    assert not store.get_history()
