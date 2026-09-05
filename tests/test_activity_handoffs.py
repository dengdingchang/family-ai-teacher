"""Parent invitations and current-frame inference only stage activity changes."""

import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.main as main
from memory.store import MemoryStore


PROFILE = {"name": "测试宝贝", "enabled_activities": ["drawing", "story", "game", "music", "vision_photo"]}


@pytest.fixture
def store(tmp_path):
    store = MemoryStore(tmp_path / "data", tmp_path / "profile.json",
                        tmp_path / "history.jsonl", tmp_path / "events.jsonl", tmp_path / "missing.json")
    with patch.object(main, "memory", store):
        yield store


def deliver_invitation(store):
    message = store.add_parent_message("今天可以陪他画一架飞机")
    invitation = main._parent_message_reply(message, PROFILE)
    main._record_turn("爸爸老师你好", invitation, parent_message_id=message["id"])
    return message


def test_parent_invitation_needs_delivery_acceptance_and_completed_playback(store):
    message = store.add_parent_message("今天可以陪他画一架飞机")
    assert main._parent_activity_acceptance_reply("机身", PROFILE) == ("", None)
    invitation = main._parent_message_reply(message, PROFILE)
    main._record_turn("你好", invitation, parent_message_id=message["id"])
    assert store.get_activity_state()["status"] == "idle"
    reply, transition = main._parent_activity_acceptance_reply("机身", PROFILE)
    assert "长长的机身" in reply and "先画机身还是翅膀" not in reply
    assert transition["activity"] == "drawing" and transition["topic"] == "飞机"
    assert store.get_activity_state()["status"] == "idle"
    for turn_id, cancel in [("invite-cancel-00001", True), ("invite-played-00001", False)]:
        main._register_stream_turn(turn_id, threading.Event())
        main._stage_stream_turn(turn_id, "机身", reply, activity_transition=transition)
        if cancel:
            main._cancel_stream_turn(turn_id)
            assert store.get_activity_state()["status"] == "idle"
            assert store.get_parent_messages()[0]["status"] == "delivered"
        else:
            asyncio.run(main.complete_streaming_turn(turn_id))
    assert store.get_activity_state()["activity"] == "drawing"
    assert store.get_parent_messages()[0]["child_response"] == "机身"
    reply, next_transition = main._activity_turn_reply("画好了", PROFILE)
    assert "翅膀" in reply and next_transition["step"] == 2


def test_parent_wing_choice_teaches_wings_then_fuselage_in_that_order(store):
    deliver_invitation(store)
    reply, transition = main._parent_activity_acceptance_reply("翅膀", PROFILE)
    assert "两片三角形翅膀" in reply and transition["step"] == 4
    store.apply_activity_transition(transition)
    reply, transition = main._activity_turn_reply("我还没画好", PROFILE)
    assert transition["step"] == 4
    reply, transition = main._activity_turn_reply("画好了", PROFILE)
    assert "接着" in reply and "机身" in reply and transition["step"] == 2


@pytest.mark.parametrize("answer", ["不要", "我不想画飞机", "我想听故事", "机身是什么", "月亮为什么跟着我", "这个红色的"])
def test_parent_offer_does_not_treat_any_reply_as_acceptance(store, answer):
    deliver_invitation(store)
    assert main._parent_activity_acceptance_reply(answer, PROFILE) == ("", None)
    assert store.get_activity_state()["status"] == "idle"


def test_expired_offer_and_disabled_activity_do_not_start(store):
    deliver_invitation(store)
    reply, transition = main._parent_activity_acceptance_reply("好呀", {"enabled_activities": []})
    assert "先休息" in reply and transition is None
    messages = store.get_parent_messages()
    messages[0]["delivered_at"] = "2020-01-01T00:00:00+00:00"
    store._write_json(store.parent_messages_path, messages)
    assert main._parent_activity_acceptance_reply("机身", PROFILE) == ("", None)


def observation(activity="colors", step=1, **changes):
    evidence = {"activity": activity, "step": step, "clear": True,
                "objects": [{"label": "积木", "color": "red", "count": 1}],
                "description": "桌上有一块红色积木。"}
    evidence.update(changes)
    return json.dumps(evidence, ensure_ascii=False)


def test_clear_current_frame_objects_advance_only_after_playback(store):
    state = {"action": "set", "activity": "colors", "step": 1, "topic": "恐龙"}
    store.apply_activity_transition(state)
    reply, transition = main._activity_vision_reply(observation(), store.get_activity_state(), PROFILE)
    assert "Red" in reply and "掌握" not in reply
    assert transition["step"] == 2 and transition["topic"] == "恐龙"
    assert store.get_activity_state()["step"] == 1
    main._register_stream_turn("vision-played-0001", threading.Event())
    main._stage_stream_turn("vision-played-0001", "爸爸你看", reply, activity_transition=transition)
    asyncio.run(main.complete_streaming_turn("vision-played-0001"))
    assert store.get_activity_state()["step"] == 2
    assert not any(item["status"] == "mastered" for item in store.get_skill_graph()["skills"])


@pytest.mark.parametrize("context", [
    "我找到了红色积木",
    observation(clear=False),
    observation(objects=[]),
    observation(objects=[{"label": "", "color": "red", "count": 1}]),
    observation(objects=[{"label": "积木", "color": "unknown", "count": 1}]),
    observation(objects=[{"label": "积木", "color": "blue", "count": 1}]),
    observation(objects=[{"label": "积木", "color": "red", "count": True}]),
    observation(objects=[{"label": "积木", "color": ["red"], "count": 1}]),
    observation(activity=["colors"]),
    observation(step=2),
    observation(clear="true"),
    observation(description=""),
    observation(color="red"),
    '{"color":"red"}',
])
def test_weak_malformed_wrong_or_stale_vision_never_advances(store, context):
    store.apply_activity_transition({"action": "set", "activity": "colors", "step": 1})
    reply, transition = main._activity_vision_reply(context, store.get_activity_state(), PROFILE)
    assert reply and transition is None
    assert store.get_activity_state()["step"] == 1


def test_game_requires_two_observed_blue_objects_not_only_the_color_word(store):
    store.apply_activity_transition({"action": "set", "activity": "game", "step": 2})
    for count in (1, 3):
        raw = observation("game", 2, objects=[{"label": "积木", "color": "blue", "count": count}])
        _, transition = main._activity_vision_reply(raw, store.get_activity_state(), PROFILE)
        assert transition is None
    raw = observation("game", 2, objects=[{"label": "积木", "color": "blue", "count": 2}],
                      description="桌上有两块蓝色积木。")
    reply, transition = main._activity_vision_reply(raw, store.get_activity_state(), PROFILE)
    assert "一共有几个" in reply and transition["step"] == 3
    assert main._activity_vision_description(raw) == "桌上有两块蓝色积木。"


def test_non_activity_photos_and_child_display_remain_plain_text(store):
    context = "这张画上有一架飞机。"
    assert main._activity_vision_prompt({"status": "idle"}) == ""
    assert main._activity_vision_reply(context, {"status": "idle"}, PROFILE) == ("", None)
    assert main._activity_vision_description(context) == context
    assert "{" not in main._activity_vision_description('{"color":"red"}')
    state = {"status": "active", "activity": "colors", "step": 1}
    assert '"objects"' in main._activity_vision_prompt(state)
    _, transition = main._activity_vision_reply(observation(), state, {"enabled_activities": []})
    assert transition is None


@pytest.fixture
def quiet_runtime(monkeypatch):
    audio = SimpleNamespace(audio_bytes=b"fixture", audio_mime="audio/ogg", duration_s=1,
                            elapsed_s=.1, backend="fixture", avatar_cued=False, avatar_audio_lead_ms=0,
                            gpu=SimpleNamespace(available=False, start_mib=None, peak_mib=None, end_mib=None, sample_count=0))
    monkeypatch.setattr(main, "tts", SimpleNamespace(synthesize=lambda *a, **k: audio))
    monkeypatch.setattr(main, "llm", SimpleNamespace(configured=False))
    monkeypatch.setattr(main, "_current_profile", lambda: {**PROFILE, "brain_mode": "local_lessons_only"})


@pytest.mark.parametrize("answer", ["机身", "我想先画机身"])
def test_json_answer_accepts_current_invitation_before_a_new_parent_message(store, quiet_runtime, answer):
    deliver_invitation(store)
    next_message = store.add_parent_message("告诉孩子晚上爸爸回来")
    response = asyncio.run(main._answer_text(answer))
    assert "长长的机身" in response["assistant_text"]
    assert store.get_activity_state()["status"] == "idle"
    asyncio.run(main.complete_streaming_turn(response["turn_id"]))
    assert store.get_activity_state()["activity"] == "drawing"
    messages = {item["id"]: item for item in store.get_parent_messages()}
    assert messages[next_message["id"]]["status"] == "pending"
    assert store.get_parent_messages()[0]["child_response"] == answer


def test_json_cancel_and_refusal_do_not_commit_an_invited_activity(store, quiet_runtime):
    deliver_invitation(store)
    response = asyncio.run(main._answer_text("翅膀"))
    main._cancel_stream_turn(response["turn_id"])
    assert store.get_activity_state()["status"] == "idle"
    assert store.get_parent_messages()[0]["status"] == "delivered"
    refusal = asyncio.run(main._answer_text("我不想画飞机"))
    asyncio.run(main.complete_streaming_turn(refusal["turn_id"]))
    assert store.get_activity_state()["status"] == "idle"
    assert store.get_parent_messages()[0]["child_response"] == "我不想画飞机"


def test_disabled_parent_invitation_does_not_ask_child_to_begin(store):
    message = store.add_parent_message("今天可以陪他画一架飞机")
    reply = main._parent_message_reply(message, {"enabled_activities": []})
    assert "先休息" in reply
    assert "机身还是翅膀" not in reply
    assert store.get_activity_state()["status"] == "idle"


@pytest.mark.parametrize("route", ["voice", "frame", "legacy"])
def test_image_api_uses_activity_contract_but_only_persists_and_displays_description(store, monkeypatch, route):
    store.apply_activity_transition({"action": "set", "activity": "colors", "step": 1})
    raw = observation()
    calls, streamed = [], []

    def describe(*args):
        calls.append(args)
        return SimpleNamespace(text=raw, elapsed_s=.1)

    async def fake_stream(text, **kwargs):
        streamed.append(kwargs)
        yield main._sse({"event": "done", "assistant_text": "观察完成"})

    monkeypatch.setattr(main, "_current_profile", lambda: PROFILE)
    monkeypatch.setattr(main.camera, "capture_frame", lambda *a, **k: None)
    monkeypatch.setattr(main, "llm", SimpleNamespace(configured=True, describe_image=describe))
    monkeypatch.setattr(main, "_stream_conversation", fake_stream)
    client = TestClient(main.app)
    if route == "voice":
        response = client.post("/api/conversation/stream", data={
            "transcript": "爸爸你看我的积木", "observation_attempted": "true",
        }, files={"frame": ("fixture.jpg", b"fixture", "image/jpeg")})
    elif route == "frame":
        response = client.post("/api/conversation/frame/stream", content=b"fixture", headers={"content-type": "image/jpeg"})
    else:
        response = client.post("/api/vision/describe-frame", content=b"fixture", headers={"content-type": "image/jpeg"})
    assert response.status_code == 200
    assert '"objects"' in calls[0][2] and calls[0][3] == 220
    assert '"clear"' not in response.text
    assert store.get_recent_learning_events()[-1]["payload"]["description"] == "桌上有一块红色积木。"
    assert store.get_activity_state()["step"] == 1
    if route == "legacy":
        assert response.json()["description"] == "桌上有一块红色积木。"
    else:
        assert streamed[0]["vision_context"] == raw


@pytest.mark.parametrize("malformed", ["{broken JSON", '观察结果：{"activity":"colors"}', '结果如下：```json {"clear":true} ```'])
def test_legacy_photo_hides_malformed_protocol_and_preserves_non_activity_description(store, monkeypatch, malformed):
    response_text = [malformed]
    monkeypatch.setattr(main, "_current_profile", lambda: PROFILE)
    monkeypatch.setattr(main.camera, "capture_frame", lambda *a, **k: None)
    monkeypatch.setattr(main, "llm", SimpleNamespace(configured=True, describe_image=lambda *a:
                        SimpleNamespace(text=response_text[0], elapsed_s=.1)))
    client = TestClient(main.app)
    response = client.post("/api/vision/describe-frame", content=b"fixture", headers={"content-type": "image/jpeg"})
    assert response.status_code == 200 and "{" not in response.json()["description"]
    response_text[0] = "画上有一架飞机。"
    response = client.post("/api/vision/describe-frame", content=b"fixture", headers={"content-type": "image/jpeg"})
    assert response.json()["description"] == "画上有一架飞机。"
