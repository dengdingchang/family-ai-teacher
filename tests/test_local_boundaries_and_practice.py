"""Explicit parent topics and committed number answers; no real family/media."""

import asyncio
import json
import threading
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import app.main as main
from memory.store import MemoryStore


@pytest.fixture
def store(tmp_path, monkeypatch):
    data = tmp_path / "data"
    temporary = MemoryStore(data, data / "profile.json", data / "history.jsonl",
                            data / "events.jsonl", tmp_path / "missing.json")
    temporary.update_child_profile({"name": "规则测试宝贝", "brain_mode": "local_lessons_only"})
    monkeypatch.setattr(main, "memory", temporary)
    return temporary


def commit(store, text):
    reply, transition = main._activity_turn_reply(text, store.get_child_profile())
    main._record_turn(text, reply, activity_transition=transition)
    return reply, transition


def attempts(store):
    return [item["payload"] for item in store.get_recent_learning_events(limit=None)
            if item["event_type"] == "practice_attempt"]


@pytest.mark.parametrize("rule", ["不要讲恐龙", "禁止讨论恐龙", "不聊恐龙", "不要讲“恐龙”", "不要讲恐龙故事"])
def test_explicit_topic_blocks_local_entry_and_starts_a_real_alternative(store, rule):
    profile = store.update_child_profile({"content_boundaries": [rule]})
    reply, transition = main._activity_turn_reply("讲一个恐龙故事", profile)
    assert "恐龙" not in reply
    assert transition["activity"] == "numbers" and transition["step"] == 1
    assert store.get_activity_state()["status"] == "idle"
    main._record_turn("讲一个恐龙故事", reply, activity_transition=transition)
    _, next_step = main._activity_turn_reply("一二三", profile)
    assert next_step["step"] == 2


@pytest.mark.parametrize("text", ["左边", "爸爸老师，我回来了"])
@pytest.mark.parametrize("rule", ["不要讲恐龙", "不要讲恐龙故事"])
def test_new_boundary_also_applies_to_existing_story_or_welcome(store, text, rule):
    store.apply_activity_transition({"action": "set", "activity": "story", "step": 2, "topic": "恐龙"})
    profile = store.update_child_profile({"content_boundaries": [rule]})
    reply, transition = main._activity_turn_reply(text, profile)
    assert "恐龙" not in reply and transition["activity"] == "numbers"


def test_story_rule_covers_optional_particle_without_banning_drawing(store):
    profile = store.update_child_profile({"content_boundaries": ["不要讲恐龙故事"]})
    reply, transition = main._activity_turn_reply("讲一个恐龙的故事", profile)
    assert "恐龙" not in reply and transition["activity"] == "numbers"
    reply, transition = main._activity_turn_reply("教我画恐龙", profile)
    assert "恐龙" in reply and transition["activity"] == "drawing"


@pytest.mark.parametrize("text", ["讲一个飞机故事", "不要恐龙，我想听飞机故事"])
def test_allowed_nearby_topic_is_not_blocked(store, text):
    profile = store.update_child_profile({"content_boundaries": ["不要讲恐龙"]})
    reply, transition = main._activity_turn_reply(text, profile)
    assert "飞机" in reply and transition["activity"] == "story"


@pytest.mark.parametrize("rule", ["不要吃太多糖", "如果晚上就不要讲恐龙", "说话温柔一点"])
def test_unrelated_or_conditional_house_rules_are_not_guessed(store, rule):
    profile = store.update_child_profile({"content_boundaries": [rule]})
    assert not main._blocked_content_topic("恐龙", profile)
    assert main._activity_turn_reply("讲一个恐龙故事", profile)[1]["activity"] == "story"


def test_alternative_itself_respects_another_explicit_boundary(store):
    profile = store.update_child_profile({"content_boundaries": ["不要讲恐龙", "不学数字", "不要讲手指"]})
    reply, transition = main._activity_turn_reply("讲一个恐龙故事", profile)
    assert "恐龙" not in reply and "手指" not in reply
    assert transition["activity"] == "colors"


def test_urgent_help_wins_over_a_forbidden_topic(store):
    profile = store.update_child_profile({"content_boundaries": ["不要讲流血"]})
    reply, transition = main._activity_turn_reply("我流血了", profile)
    assert "身边可信任的大人" in reply and transition is None


def test_old_parent_invitation_cannot_restart_newly_forbidden_content(store):
    message = store.add_parent_message("今天可以陪他画恐龙")
    profile = store.get_child_profile()
    invitation = main._parent_message_reply(message, profile)
    main._record_turn("你好", invitation, parent_message_id=message["id"])
    profile = store.update_child_profile({"content_boundaries": ["不要讲恐龙"]})
    reply, transition = main._parent_activity_acceptance_reply("好呀", profile)
    assert "恐龙" not in reply and transition["activity"] == "numbers"


def test_blocked_parent_note_remains_pending_after_alternative_playback(store, monkeypatch):
    store.update_child_profile({"content_boundaries": ["不要讲恐龙"]})
    message = store.add_parent_message("今天可以陪他画恐龙")
    monkeypatch.setattr(main, "tts", SimpleNamespace(synthesize=lambda *a, **k: SimpleNamespace(avatar_cued=False)))
    monkeypatch.setattr(main, "_tts_payload", lambda *a, **k: {"audio_base64": "synthetic"})
    turn_id = uuid.uuid4().hex

    async def run():
        return [json.loads(frame.removeprefix("data: ")) async for frame in
                main._stream_conversation("讲一个恐龙故事", turn_id=turn_id)]

    try:
        events = asyncio.run(run())
        done = next(event for event in events if event["event"] == "done")
        assert done["ok"] and "恐龙" not in done["assistant_text"]
        assert main._stream_turns[turn_id]["parent_message_id"] == ""
        asyncio.run(main.complete_streaming_turn(turn_id))
        assert store.get_parent_messages()[0]["id"] == message["id"]
        assert store.get_parent_messages()[0]["status"] == "pending"
    finally:
        with main._stream_turn_lock:
            main._stream_turns.pop(turn_id, None)


def test_three_wrong_answers_enter_review_without_changing_parent_mastery(store):
    reviewed = store.update_skill("math.addition", {"status": "mastered", "mastery_score": 1,
                                                    "last_evidence": "合成家长评估：以前独立完成"})
    store.apply_activity_transition({"action": "set", "activity": "numbers", "step": 2, "topic": "积木"})
    for answer in ("四", "五"):
        commit(store, answer)
    assert not store.get_growth_journal()[0]["difficulties"]
    commit(store, "四")
    recorded = attempts(store)
    assert [item["answer"] for item in recorded] == ["四", "五", "四"]
    assert all(item["result"] == "incorrect" and item["question_id"] == "add_2_1" for item in recorded)
    assert all(item["step"] == 2 and item["question"] == "两加一，一共有几个？" for item in recorded)
    journal = store.get_growth_journal()[0]
    assert any("两加一" in difficulty and "3次" in difficulty for difficulty in journal["difficulties"])
    assert "两加一" in journal["recommendation"] and "积木" in journal["recommendation"]
    skill = next(item for item in store.get_skill_graph()["skills"] if item["id"] == "math.addition")
    for field in ("status", "mastery_score", "last_evidence", "evidence_count", "parent_reviewed_at"):
        assert skill[field] == reviewed[field]
    assert not journal["milestones"]
    commit(store, "三")
    assert attempts(store)[-1]["result"] == "correct"
    assert "最近一次已答对" in store.get_growth_journal()[0]["difficulties"][0]
    assert store.get_activity_state()["status"] == "idle"
    reloaded = MemoryStore(store.data_dir, store.profile_path, store.history_path,
                           store.learning_events_path, store.template_path)
    assert len(attempts(reloaded)) == 4
    assert "两加一" in reloaded.get_growth_journal()[0]["recommendation"]
    assert len([event for event in reloaded.export_bundle()["learning_events"]
                if event["event_type"] == "practice_attempt"]) == 4


@pytest.mark.parametrize("step,answer", [(1, "一二三"), (2, "三"), (3, "五"), (4, "十四"), (5, "十八"), (6, "二十")])
def test_correct_number_answer_records_only_the_current_exercise(store, step, answer):
    store.apply_activity_transition({"action": "set", "activity": "numbers", "step": step})
    commit(store, answer)
    assert len(attempts(store)) == 1
    assert attempts(store)[0]["result"] == "correct"
    assert attempts(store)[0]["step"] == step
    assert not store.get_growth_journal()[0]["difficulties"]
    assert all(skill["evidence_count"] == 0 and skill["mastery_score"] == 0
               for skill in store.get_skill_graph()["skills"])


@pytest.mark.parametrize("answer", ["继续吧", "我不知道", "四是吗", "三？", "三呢？", "五？", "三呢", "我想听飞机故事", "我想学数字"])
def test_nonanswers_questions_and_switches_are_not_scored(store, answer):
    store.apply_activity_transition({"action": "set", "activity": "numbers", "step": 2})
    commit(store, answer)
    assert not attempts(store)


def test_attempt_waits_for_playback_and_cancel_discards_it(store):
    store.apply_activity_transition({"action": "set", "activity": "numbers", "step": 2})
    profile = store.get_child_profile()
    reply, transition = main._activity_turn_reply("四", profile)
    for cancel in (True, False):
        turn_id = uuid.uuid4().hex
        try:
            main._register_stream_turn(turn_id, threading.Event())
            assert main._stage_stream_turn(turn_id, "四", reply, activity_transition=transition)
            assert not attempts(store)
            if cancel:
                main._cancel_stream_turn(turn_id)
                with pytest.raises(HTTPException):
                    asyncio.run(main.complete_streaming_turn(turn_id))
                assert not attempts(store) and not store.get_history()
            else:
                asyncio.run(main.complete_streaming_turn(turn_id))
                asyncio.run(main.complete_streaming_turn(turn_id))
                assert len(attempts(store)) == 1 and len(store.get_history()) == 1
        finally:
            with main._stream_turn_lock:
                main._stream_turns.pop(turn_id, None)
