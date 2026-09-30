"""Activity behavior uses temporary family state and never calls a model."""

from unittest.mock import patch

import pytest

import app.main as main
from memory.store import MemoryStore


PROFILE = {"name": "测试宝贝", "age": 4,
           "enabled_activities": ["drawing", "story", "game", "music", "vision_photo"]}


@pytest.fixture
def activity_store(tmp_path):
    store = MemoryStore(tmp_path / "data", tmp_path / "profile.json",
                        tmp_path / "history.jsonl", tmp_path / "events.jsonl", tmp_path / "missing.json")
    with patch.object(main, "memory", store):
        yield store


@pytest.mark.parametrize("utterance, activity, subject, content", [
    ("教我画恐龙", "drawing", "恐龙", "椭圆"),
    ("我要画飞机", "drawing", "飞机", "机身"),
    ("教我畫三角龍", "drawing", "三角龙", "椭圆"),
    ("讲一个恐龙故事", "story", "恐龙", "小恐龙"),
    ("恐龙故事", "story", "恐龙", "小恐龙"),
    ("我想听一个太空故事", "story", "太空", "小宇航员"),
    ("教我画火箭", "drawing", "火箭", "尖尖的头"),
    ("我想学恐龙英语", "english", "恐龙", "Dinosaur"),
    ("我想玩恐龙数数游戏", "numbers", "恐龙", "一、二、三"),
    ("我想玩飞机英语小游戏", "english", "飞机", "Plane"),
])
def test_explicit_activity_keeps_requested_subject(activity_store, utterance, activity, subject, content):
    reply, transition = main._activity_turn_reply(utterance, PROFILE)
    assert transition["activity"] == activity
    assert transition["topic"] == subject
    assert content in reply
    if subject != "小兔子":
        assert "小兔子" not in reply
    assert activity_store.get_activity_state()["status"] == "idle"


@pytest.mark.parametrize("activity, step, text", [
    ("colors", 1, "我没有找到红色"),
    ("colors", 1, "这是红色还是蓝色"),
    ("colors", 2, "我不会说 red"),
    ("english", 1, "我不会说 apple"),
    ("english", 1, "你刚才说 apple 吗"),
    ("english", 2, "我没说 red"),
    ("game", 1, "我没找到"),
    ("game", 2, "我只找到一个蓝色的"),
    ("music", 1, "我还没唱"),
    ("music", 1, "苹果"),
    ("music", 2, "我不会唱高低高"),
    ("drawing", 1, "我还没画好恐龙"),
])
def test_negative_uncertain_and_unrelated_answers_never_pass_a_step(activity_store, activity, step, text):
    activity_store.apply_activity_transition({"action": "set", "activity": activity,
                                           "topic": "恐龙" if activity == "drawing" else "", "step": step})
    reply, transition = main._activity_turn_reply(text, PROFILE)
    assert transition["action"] == "set"
    assert transition["activity"] == activity
    assert transition["step"] == step
    assert not any(claim in reply for claim in ("完成！", "说得很清楚", "我听见节奏", "观察得又快", "你会说"))


def test_dinosaur_drawing_keeps_subject_until_finished_and_after_reload(activity_store, tmp_path):
    reply, transition = main._activity_turn_reply("教我画恐龙", PROFILE)
    activity_store.apply_activity_transition(transition)
    reloaded = MemoryStore(tmp_path / "data", tmp_path / "profile.json",
                           tmp_path / "history.jsonl", tmp_path / "events.jsonl", tmp_path / "missing.json")
    with patch.object(main, "memory", reloaded):
        reply, transition = main._activity_turn_reply("我回来了", PROFILE)
        assert "恐龙" in reply
        assert transition["topic"] == "恐龙"
        reloaded.apply_activity_transition(transition)
        for answer, next_step in [("画好了", 2), ("先画尾巴", 3)]:
            reply, transition = main._activity_turn_reply(answer, PROFILE)
            assert "恐龙" in reply
            assert "太阳还是气球" not in reply
            assert transition["topic"] == "恐龙"
            assert transition["step"] == next_step
            reloaded.apply_activity_transition(transition)
        reply, transition = main._activity_turn_reply("绿色", PROFILE)
        assert "恐龙" in reply
        assert transition["action"] == "clear"


def test_plane_drawing_and_dinosaur_story_do_not_replace_subject_with_default(activity_store):
    _, transition = main._activity_turn_reply("我要画飞机", PROFILE)
    activity_store.apply_activity_transition(transition)
    reply, transition = main._activity_turn_reply("画好了", PROFILE)
    assert "翅膀" in reply and "飞机" in reply
    activity_store.apply_activity_transition(transition)
    reply, transition = main._activity_turn_reply("我不想画了我想听恐龙故事", PROFILE)
    assert "小恐龙" in reply
    assert transition["activity"] == "story"
    activity_store.apply_activity_transition(transition)
    for answer, step in [("小狗", 2), ("左边", 3)]:
        reply, transition = main._activity_turn_reply(answer, PROFILE)
        assert "小恐龙" in reply
        assert transition["topic"] == "恐龙" and transition["step"] == step
        activity_store.apply_activity_transition(transition)
    reply, transition = main._activity_turn_reply("我想和爸爸一起玩", PROFILE)
    assert "《小恐龙的星星》" in reply
    assert transition["action"] == "clear"


def test_story_character_named_dinosaur_is_an_answer_not_a_new_animal_lesson(activity_store):
    activity_store.apply_activity_transition({"action": "set", "activity": "story", "step": 1})
    reply, transition = main._activity_turn_reply("小恐龙", PROFILE)
    assert transition["activity"] == "story" and transition["step"] == 2
    assert "遇见了小恐龙" in reply


def test_explicit_observation_does_not_restart_drawing(activity_store):
    activity_store.apply_activity_transition({"action": "set", "activity": "drawing", "topic": "恐龙", "step": 2})
    reply, transition = main._activity_turn_reply("爸爸你看我画的恐龙", PROFILE)
    assert transition is None
    assert "没看清" in reply
    assert activity_store.get_activity_state()["step"] == 2


def test_reported_color_and_singing_are_not_claimed_as_observed_or_mastered(activity_store):
    for activity, text in [("colors", "我找到红色积木了"), ("game", "我找到红色积木了"), ("music", "我唱好了")]:
        activity_store.apply_activity_transition({"action": "set", "activity": activity, "step": 1})
        reply, transition = main._activity_turn_reply(text, PROFILE)
        assert transition["step"] == 2
        assert not any(claim in reply for claim in ("看见", "看到", "听见节奏", "唱得", "第一关完成", "掌握"))
        if activity != "music":
            assert "你说" in reply


def test_refusal_break_and_parent_disabled_activity_preserve_controls(activity_store):
    activity_store.apply_activity_transition({"action": "set", "activity": "story", "topic": "恐龙", "step": 1})
    _, transition = main._activity_turn_reply("不要换故事，继续这个", PROFILE)
    assert transition["activity"] == "story" and transition["topic"] == "恐龙"
    reply, transition = main._activity_turn_reply("不想听故事", PROFILE)
    assert transition["action"] == "clear"
    assert "想听故事" not in reply
    for utterance in ("我想休息一下", "我累了", "我不唱了", "我不想了"):
        reply, transition = main._activity_turn_reply(utterance, PROFILE)
        assert transition["action"] == "clear" and "？" not in reply
    reply, transition = main._activity_turn_reply("教我画恐龙", {"enabled_activities": []})
    assert transition is None and "今天先休息" in reply


def test_offline_lesson_also_keeps_specific_theme(activity_store):
    assert "机身" in main._explicit_lesson_reply("教我画飞机", PROFILE)
    assert "小恐龙" in main._explicit_lesson_reply("讲一个恐龙故事", PROFILE)
    assert main._explicit_lesson_reply("我不想学英语", PROFILE) == ""


def test_themed_english_answer_continues_same_activity(activity_store):
    _, transition = main._activity_turn_reply("我想学恐龙英语", PROFILE)
    activity_store.apply_activity_transition(transition)
    reply, transition = main._activity_turn_reply("Dinosaur", PROFILE)
    assert "Red" in reply
    assert transition["activity"] == "english" and transition["topic"] == "恐龙" and transition["step"] == 2


@pytest.mark.parametrize("reply_text", ["Rat", "R.A.D.", "已经说了呀", "我刚才说过了"])
def test_english_pronunciation_attempt_moves_on_without_claiming_mastery(activity_store, reply_text):
    activity_store.apply_activity_transition({"action": "set", "activity": "english", "step": 2})
    reply, transition = main._activity_turn_reply(reply_text, PROFILE)
    assert transition["action"] == "set" and transition["step"] == 5
    assert "不重复跟读" in reply and "Blue" in reply
    assert "说对" not in reply and "掌握" not in reply
    activity_store.apply_activity_transition(transition)
    reply, transition = main._activity_turn_reply("Blue", PROFILE)
    assert transition["action"] == "clear" and "蓝色" in reply


def test_themed_counting_stays_in_theme_but_does_not_claim_mastery(activity_store):
    _, transition = main._activity_turn_reply("我想玩恐龙数数游戏", PROFILE)
    activity_store.apply_activity_transition(transition)
    reply, transition = main._activity_turn_reply("一二三", PROFILE)
    assert "恐龙" in reply and transition["topic"] == "恐龙" and transition["step"] == 2
    activity_store.apply_activity_transition(transition)
    reply, transition = main._activity_turn_reply("三个", PROFILE)
    assert "恐龙" in reply and transition["action"] == "clear"
    assert "掌握" not in reply and "学会" not in reply
