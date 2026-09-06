"""Parent-reviewed English/color progression; no model or real family data."""

import asyncio
import threading
import uuid
from unittest.mock import patch

import pytest

import app.main as main
from memory.store import MemoryStore


PROFILE = {"name": "测试宝贝", "age": 4, "interests": ["恐龙"],
           "enabled_activities": ["drawing", "story", "game", "music"]}
ASSESSMENT_FIELDS = ("status", "mastery_score", "last_evidence", "evidence_count", "parent_reviewed_at")


@pytest.fixture
def store(tmp_path):
    temporary = MemoryStore(tmp_path / "data", tmp_path / "profile.json",
                            tmp_path / "history.jsonl", tmp_path / "events.jsonl",
                            tmp_path / "missing.json")
    with patch.object(main, "memory", temporary):
        yield temporary


def parent_mastered(store, skill_id):
    return store.update_skill(skill_id, {
        "status": "mastered", "mastery_score": 1.0,
        "last_evidence": "合成家长确认：入门词能独立使用",
    })


def commit_turn(store, utterance):
    reply, transition = main._activity_turn_reply(utterance, PROFILE)
    assert transition is not None
    main._record_turn(utterance, reply, activity_transition=transition)
    return reply, transition


@pytest.mark.parametrize("skill_id,start_text,opening,answers", [
    ("english.words", "我想学英语", "I like dinosaurs",
     [("I like dinosaurs.", 4, "I like blue"), ("I like blue!", None, "说进句子")]),
    ("english.colors", "我想学颜色", "颜色一样，还是不一样",
     [("不一样", 4, "哪个词表示蓝色"), ("Blue", None, "Blue 是蓝色")]),
])
def test_parent_review_upgrades_the_whole_lesson_without_awarding_mastery(
    store, skill_id, start_text, opening, answers,
):
    _, basic = main._activity_turn_reply(start_text, PROFILE)
    assert basic["step"] == 1
    expected = parent_mastered(store, skill_id)
    ids_before = {item["id"] for item in store.get_skill_graph()["skills"]}
    reply, transition = main._activity_turn_reply(start_text, PROFILE)
    assert opening in reply and transition["step"] == 3
    assert store.get_activity_state()["status"] == "idle"
    if skill_id == "english.words":
        assert transition["topic"] == "恐龙"
    main._record_turn(start_text, reply, activity_transition=transition)
    for answer, next_step, expected_reply in answers:
        reply, transition = commit_turn(store, answer)
        assert expected_reply in reply
        assert "掌握" not in reply and "听见" not in reply and "看见" not in reply
        if next_step is None:
            assert transition["action"] == "clear"
            assert store.get_activity_state()["status"] == "idle"
        else:
            assert transition["step"] == next_step
            assert store.get_activity_state()["step"] == next_step
    graph = store.get_skill_graph()["skills"]
    assert {item["id"] for item in graph} == ids_before
    actual = next(item for item in graph if item["id"] == skill_id)
    assert {field: actual[field] for field in ASSESSMENT_FIELDS} == {
        field: expected[field] for field in ASSESSMENT_FIELDS
    }
    assert all(item["evidence_count"] == 0 and item["mastery_score"] == 0
               for item in graph if item["id"] != skill_id)


@pytest.mark.parametrize("activity,step,answers", [
    ("english", 3, ["Dinosaur", "Apple", "I like", "我不会说 I like dinosaurs", "I don't like dinosaurs", "好呀"]),
    ("english", 4, ["Red", "Blue", "I like dinosaurs", "我还没说 I like blue", "好呀"]),
    ("colors", 3, ["一样", "红色", "Red", "我不知道", "不是不一样", "好呀"]),
    ("colors", 4, ["Red", "不一样", "我不会说 Blue", "好呀"]),
])
def test_advanced_questions_reject_old_answers_negation_and_resume_cues(store, activity, step, answers):
    store.apply_activity_transition({"action": "set", "activity": activity, "step": step, "topic": "恐龙"})
    for answer in answers:
        reply, transition = main._activity_turn_reply(answer, PROFILE)
        assert transition["action"] == "set"
        assert transition["activity"] == activity and transition["step"] == step
        assert "掌握" not in reply
        assert store.get_activity_state()["step"] == step


@pytest.mark.parametrize("answer", [
    "我选 Blue", "蓝色叫 Blue", "Blue 是蓝色", "蓝色的英文是 Blue",
])
def test_clear_color_answers_finish_only_after_playback_without_awarding_mastery(store, answer):
    expected = parent_mastered(store, "english.colors")
    store.apply_activity_transition({"action": "set", "activity": "colors", "step": 4})
    reply, transition = main._activity_turn_reply(answer, PROFILE)
    assert transition["action"] == "clear"
    assert "Blue 是蓝色" in reply
    assert store.get_activity_state()["step"] == 4
    assert store.get_history() == []
    turn_id = uuid.uuid4().hex
    main._register_stream_turn(turn_id, threading.Event())
    try:
        assert main._stage_stream_turn(turn_id, answer, reply, activity_transition=transition)
        assert store.get_activity_state()["step"] == 4
        assert store.get_history() == []
        result = asyncio.run(main.complete_streaming_turn(turn_id))
        assert result["ok"]
        assert store.get_activity_state()["status"] == "idle"
        assert len(store.get_history()) == 1
        actual = next(item for item in store.get_skill_graph()["skills"] if item["id"] == "english.colors")
        assert {field: actual[field] for field in ASSESSMENT_FIELDS} == {
            field: expected[field] for field in ASSESSMENT_FIELDS
        }
    finally:
        with main._stream_turn_lock:
            main._stream_turns.pop(turn_id, None)


@pytest.mark.parametrize("answers", [
    ["不是 Blue", "我不知道 Blue", "Red 不是 Blue"],
    ["可能是 Blue", "我猜 Blue", "不知道"],
    ["Blue？", "Blue 呢", "蓝色叫 Blue 吗？"],
    ["老师说 Blue", "“Blue 是蓝色”"],
    ["红色叫 Blue", "Blue 是红色", "蓝色的英文是 Red"],
    ["我选 Blue 或 Red", "Blue 是蓝色，Red 也是蓝色"],
    ["我喜欢蓝色，blue", "我喜欢蓝色不露"],
])
def test_color_choice_rejects_uncertain_quoted_wrong_and_conflicting_answers(store, answers):
    store.apply_activity_transition({"action": "set", "activity": "colors", "step": 4})
    for answer in answers:
        reply, transition = main._activity_turn_reply(answer, PROFILE)
        assert transition["action"] == "set"
        assert transition["activity"] == "colors" and transition["step"] == 4
        assert "哪个词表示蓝色" in reply
        assert store.get_activity_state()["step"] == 4
    assert store.get_history() == []


def test_natural_color_choices_do_not_relax_the_english_sentence_lesson(store):
    store.apply_activity_transition({"action": "set", "activity": "english", "step": 4})
    for answer in ("我选 Blue", "蓝色叫 Blue", "Blue 是蓝色", "蓝色的英文是 Blue", "Blue"):
        reply, transition = main._activity_turn_reply(answer, PROFILE)
        assert transition["action"] == "set" and transition["step"] == 4
        assert "I like blue" in reply
    _, transition = main._activity_turn_reply("I like blue", PROFILE)
    assert transition["action"] == "clear"
    assert store.get_activity_state()["step"] == 4


@pytest.mark.parametrize("skill_id,start_text,review,expected", [
    ("english.words", "我想学恐龙英语", "从头来", "Dinosaur 是恐龙"),
    ("english.words", "我想学英语", "我想复习英语", "Dinosaur 是恐龙"),
    ("english.colors", "我想学颜色", "复习", "红色"),
    ("english.colors", "我想学颜色", "复习颜色", "红色"),
])
def test_explicit_review_returns_to_a_real_basic_lesson(store, skill_id, start_text, review, expected):
    parent_mastered(store, skill_id)
    _, advanced = commit_turn(store, start_text)
    assert advanced["step"] == 3
    reply, basic = commit_turn(store, review)
    assert expected in reply and basic["step"] == 1
    if basic["activity"] == "english":
        assert basic["topic"] == "恐龙"
        _, next_step = commit_turn(store, "Dinosaur")
    else:
        _, next_step = commit_turn(store, "我找到了红色积木")
    assert next_step["step"] == 2
    _, finished = commit_turn(store, "Red")
    assert finished["action"] == "clear"


@pytest.mark.parametrize("skill_id,start_text", [
    ("english.words", "我想学英语"), ("english.colors", "我想学颜色"),
])
def test_unreviewed_or_practicing_skill_does_not_upgrade(store, skill_id, start_text):
    graph = store.get_skill_graph()
    prerequisite = next(item for item in graph["skills"] if item["id"] == skill_id)
    prerequisite["status"] = "mastered"
    prerequisite.pop("parent_reviewed_at", None)
    with patch.object(store, "get_skill_graph", return_value=graph):
        _, transition = main._activity_turn_reply(start_text, PROFILE)
        assert transition["step"] == 1
    store.update_skill(skill_id, {"status": "practicing"})
    _, transition = main._activity_turn_reply(start_text, PROFILE)
    assert transition["step"] == 1


def test_advanced_lesson_keeps_refusal_switch_and_no_switch_controls(store):
    parent_mastered(store, "english.words")
    commit_turn(store, "我想学英语")
    _, keep = main._activity_turn_reply("不要换，继续这个", PROFILE)
    assert keep["activity"] == "english" and keep["step"] == 3
    _, stopped = main._activity_turn_reply("我不想学了，我累了", PROFILE)
    assert stopped["action"] == "clear"
    _, switched = main._activity_turn_reply("我不想学英语了，我想听恐龙故事", PROFILE)
    assert switched["activity"] == "story" and switched["topic"] == "恐龙"
    _, declined_review = main._activity_turn_reply("我不想复习", PROFILE)
    assert declined_review["action"] == "clear"


@pytest.mark.parametrize("skill_id,start_text,answer,expected_reply", [
    ("english.words", "我想学飞机英语", "I like planes", "I like blue"),
    ("english.colors", "我想学颜色", "不一样", "哪个词表示蓝色"),
])
def test_reloaded_advanced_checkpoint_keeps_its_question(store, tmp_path, skill_id, start_text, answer, expected_reply):
    parent_mastered(store, skill_id)
    commit_turn(store, start_text)
    commit_turn(store, answer)
    reloaded = MemoryStore(tmp_path / "data", tmp_path / "profile.json",
                           tmp_path / "history.jsonl", tmp_path / "events.jsonl",
                           tmp_path / "missing.json")
    with patch.object(main, "memory", reloaded):
        reply, resumed = main._activity_turn_reply("好呀", PROFILE)
        assert resumed["step"] == 4 and expected_reply in reply
        if skill_id == "english.words":
            assert resumed["topic"] == "飞机"
