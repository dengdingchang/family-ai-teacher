"""A current request to see learning media must escape an old lesson.

All adapters use RAM fixtures and all family records live under pytest tmp_path.
"""

import pytest
import app.main as main
from app.media import explicit_media_request

from test_story_chess_routing import runtime, spoken_turn, complete, request_turn, events


@pytest.mark.parametrize("text,topic", [
    ("我想看大蝴蝶", "蝴蝶"),
    ("爸爸老师，给我看看飞机图片", "飞机"),
    ("我想看一下彩虹", "彩虹"),
    ("看看彩虹", "彩虹"),
    ("看一下月亮", "月亮"),
    ("爸爸老师，看一看蝴蝶吧", "蝴蝶"),
])
def test_image_request_does_not_speak_old_color_hint(runtime, text, topic):
    runtime.store.apply_activity_transition({"action": "set", "activity": "game", "step": 1})
    turn_id, done = spoken_turn(runtime, text)
    assert topic in done["assistant_text"]
    assert "找到红色" not in "".join(runtime.voice)
    assert done["activity_transition"] == {"action": "clear"}
    assert runtime.store.get_activity_state()["status"] == "active"
    assert runtime.store.get_history() == []
    complete(runtime, turn_id)
    assert runtime.store.get_activity_state()["status"] == "idle"
    assert runtime.store.get_history()[-1]["user_text"] == text


@pytest.mark.parametrize("entry", ["audio", "json"])
def test_media_intent_has_same_voice_reply_across_routes(runtime, entry):
    runtime.store.apply_activity_transition({"action": "set", "activity": "story", "step": 2})
    if entry == "audio":
        turn_id, response = request_turn(runtime, "我想看一下月亮的图片", entry)
        done = next(item for item in events(response) if item["event"] == "done")
    else:
        response = runtime.client.post("/api/conversation/text", json={"text": "我想看一下月亮的图片"})
        assert response.status_code == 200
        done = response.json()
        turn_id = done["turn_id"]
        runtime.turn_ids.append(turn_id)
    assert "月亮的图片" in done["assistant_text"]
    assert "月亮的图片" in "".join(runtime.voice)
    assert runtime.model.calls == []
    assert runtime.store.get_activity_state()["step"] == 2
    complete(runtime, turn_id)
    assert runtime.store.get_activity_state()["status"] == "idle"


@pytest.mark.parametrize("text", [
    "我不想看蝴蝶", "不要给我看蝴蝶", "昨天我想看蝴蝶", "如果我想看蝴蝶",
    "妈妈说我想看蝴蝶", "妈妈说：我想看蝴蝶", "我说过我想看蝴蝶", "你想看蝴蝶吗",
    "我看到蝴蝶了", "爸爸你看我手里的蝴蝶", "我想看蝴蝶为什么飞", "我想看妈妈的蝴蝶照片",
    "我想画蝴蝶", "我想看蝴蝶，然后我想听故事", "我想看蝴蝶，我想听故事",
    "我不想看蝴蝶我想看彩虹", "我想看蝴蝶是不是红色的", "故事里说“我想看蝴蝶”",
    "妈妈说，我想看蝴蝶", "我昨天说，我想看蝴蝶", "我想看蝴蝶，不想看了",
    "我想看蝴蝶，算了", "妈妈说，给我看蝴蝶的图片",
    "看看衣服玩具", "看看你手里的蝴蝶", "别看看彩虹", "昨天看看彩虹",
])
def test_negated_reported_historical_and_other_intents_are_not_media_commands(text):
    assert explicit_media_request(text) is None


@pytest.mark.parametrize("text,topic,kind,replay", [
    ("不要蝴蝶，我想看彩虹", "彩虹", "image", False),
    ("爸爸老師，給我看月球圖片", "月亮", "image", False),
    ("能不能给我看看飞机图片", "飞机", "image", False),
    ("我想看鲸鱼的图片", "鲸鱼", "image", False),
    ("给我看看刷牙的视频", "刷牙", "video", False),
    ("爸爸老师，再给我看刚才的图片", "", "image", True),
    ("再给我看刚才那张图", "", "image", True),
    ("妈妈说，不过我想看彩虹", "彩虹", "image", False),
])
def test_explicit_request_keeps_current_topic_kind_and_replay_boundary(text, topic, kind, replay):
    request = explicit_media_request(text)
    assert request is not None
    assert (request.topic, request.kind, request.replay) == (topic, kind, replay)


def test_cancelled_media_ack_does_not_leave_activity_or_write_history(runtime):
    runtime.store.apply_activity_transition({"action": "set", "activity": "game", "step": 2})
    original = runtime.store.get_activity_state()
    turn_id, _ = spoken_turn(runtime, "我想看大蝴蝶")
    assert runtime.client.post(f"/api/conversation/turns/{turn_id}/cancel").json()["cancelled"]
    assert runtime.client.post(f"/api/conversation/turns/{turn_id}/complete").status_code == 409
    assert runtime.store.get_history() == []
    assert runtime.store.get_activity_state() == original


def test_media_request_does_not_mark_pending_parent_message_as_delivered(runtime):
    runtime.store.add_parent_message("今天可以一起画飞机")
    turn_id, done = spoken_turn(runtime, "我想看彩虹")
    assert "彩虹" in done["assistant_text"]
    complete(runtime, turn_id)
    assert runtime.store.get_parent_messages()[0]["status"] == "pending"


def test_parent_boundary_and_child_safety_still_take_precedence(runtime):
    runtime.store.update_child_profile({"content_boundaries": ["不要看蝴蝶"]})
    _, blocked = spoken_turn(runtime, "我想看大蝴蝶")
    assert "这个话题今天先放一放" in blocked["assistant_text"]
    assert "蝴蝶" not in "".join(runtime.voice)
    profile = runtime.store.get_child_profile()
    text = "我流血了，我想看彩虹"
    priority = main._child_priority_reply(text)
    assert priority
    assert main._activity_turn_reply(text, profile) == (priority, None)


def test_open_chess_board_does_not_trap_media_request(runtime):
    response = runtime.client.post("/api/conversation/text/stream", json={
        "text": "给我看彩虹的图片", "chess_context": "白兵e2，能到e3。"})
    done = next(item for item in events(response) if item["event"] == "done")
    runtime.turn_ids.append(done["turn_id"])
    assert "彩虹的图片" in done["assistant_text"]
    assert not runtime.model.calls
