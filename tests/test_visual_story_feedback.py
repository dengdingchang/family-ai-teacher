"""Real orchestration with synthetic frames, text, and a temporary family store."""

import asyncio
import io
import json
import uuid
import wave
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app.main as main
from audio.metrics import unavailable_gpu_measurement
from llm.client import LLMError
from memory.store import MemoryStore
from tts.adapter import TTSResult


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    template = tmp_path / "template.json"
    profile = {"name": "临时测试宝贝", "enabled_activities": ["drawing", "story", "vision_photo"]}
    template.write_text(json.dumps(profile, ensure_ascii=False), encoding="utf-8")
    data = tmp_path / "data"
    store = MemoryStore(data, data / "profile.json", data / "history.jsonl", data / "events.jsonl", template)
    store.get_child_profile()  # Complete synthetic first-run setup before read-only byte checks.
    model = SimpleNamespace(configured=True, calls=[], text="手里有一块蓝色积木。", text_calls=0)

    def describe(*args):
        model.calls.append(args)
        return SimpleNamespace(text=model.text, elapsed_s=.01)

    def stream(*args, **kwargs):
        model.text_calls += 1
        raise LLMError("Synthetic second text request failed")

    model.describe_image = describe
    model.stream_chat = stream
    voice_texts = []
    wav = io.BytesIO()
    with wave.open(wav, "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 1600)

    def speak(text, **kwargs):
        voice_texts.append(text)
        return TTSResult(wav.getvalue(), .1, .001, unavailable_gpu_measurement(), backend="test")

    monkeypatch.setattr(main, "memory", store)
    monkeypatch.setattr(main, "llm", model)
    monkeypatch.setattr(main, "tts", SimpleNamespace(synthesize=speak, flush_avatar=lambda: None))
    # TestClient without a context manager does not start real model workers.
    result = SimpleNamespace(store=store, model=model, voice=voice_texts, profile=profile,
                             client=TestClient(main.app), turn_ids=[])
    yield result
    with main._stream_turn_lock:
        for turn_id in result.turn_ids:
            main._stream_turns.pop(turn_id, None)


def events(response):
    assert response.status_code == 200, response.text
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


@pytest.mark.parametrize("text", ["爸爸你看。", "爸爸老师，你看！", "我手里拿的是什么？", "手里拿的是什么",
                                  "爸爸你看手里拿的是什么。", "手里拿的是什么呀？", "你看得到我吗", "你看到我了吗",
                                  "这是什么", "这张照片是什么呀？"])
def test_current_object_requests_and_asr_sentence_punctuation_request_a_frame(text):
    assert main._explicit_visual_request(text)


def test_successful_photo_is_spoken_without_a_second_text_model(runtime):
    turn_id = uuid.uuid4().hex
    runtime.turn_ids.append(turn_id)
    response = runtime.client.post("/api/conversation/frame/stream", content=b"\xff\xd8\xffsynthetic",
                                   headers={"content-type": "image/jpeg", "x-conversation-turn-id": turn_id})
    observed = events(response)
    done = next(item for item in observed if item["event"] == "done")
    assert "蓝色积木" in done["assistant_text"]
    assert "没看清" not in done["assistant_text"]
    assert runtime.model.text_calls == 0
    assert any(item["event"] == "audio" for item in observed)
    assert runtime.store.get_history() == []
    assert done["commit_required"]


def test_story_button_instruction_is_not_a_story_hero(runtime):
    reply, transition = main._activity_turn_reply("爸爸老师，讲一个让我也能接着说的故事吧。", runtime.profile)
    assert "让我也能接着说" not in reply and "让我也能接着说" not in transition["topic"]
    assert "你" in reply and reply.endswith("？")


def test_child_can_ask_teacher_to_continue_the_existing_story(runtime):
    runtime.store.apply_activity_transition({"action": "set", "activity": "story", "step": 1, "topic": "恐龙"})
    reply, transition = main._activity_turn_reply("你接着讲吧", runtime.profile)
    assert "小恐龙" in reply and "遇见了你" not in reply
    assert transition["step"] == 2 and transition["topic"] == "恐龙"
    assert "你" in reply and reply.endswith("？")


@pytest.mark.parametrize("text", ["昨天我手里拿的是什么", "故事里爸爸手里拿的是什么", "不要看我手里的东西"])
def test_hand_mentions_in_history_story_or_refusal_do_not_request_a_frame(text):
    assert not main._explicit_visual_request(text)


def test_stored_story_instruction_is_recovered_and_child_can_take_a_turn(runtime):
    runtime.store.apply_activity_transition({"action": "set", "activity": "story", "step": 1,
                                            "topic": "让我也能接着说"})
    reply, transition = main._activity_turn_reply("让我也能接着说", runtime.profile)
    assert "轮流讲" in reply and "你来接一句" in reply and "遇见了让我" not in reply
    assert transition["step"] == 1 and "让我也能接着说" not in transition["topic"]
    # A real character answer still advances the same story.
    reply, transition = main._activity_turn_reply("小狗", runtime.profile)
    assert "小兔子遇见了小狗" in reply and transition["step"] == 2


def drawing_frame(runtime, **data):
    turn_id = uuid.uuid4().hex
    runtime.turn_ids.append(turn_id)
    response = runtime.client.post("/api/conversation/stream",
        data={"visual_source": "drawing", "drawing_observation": "true", **data},
        files={"frame": ("drawing.png", b"\x89PNG\r\n\x1a\nsynthetic", "image/png")},
        headers={"x-conversation-turn-id": turn_id})
    return response, turn_id


def file_bytes(store):
    return {path.name: path.read_bytes() for path in store.data_dir.iterdir() if path.is_file()}


def test_automatic_drawing_observation_never_becomes_a_child_turn_or_parent_receipt(runtime):
    runtime.store.add_parent_message("爸爸想听你讲今天的故事。")
    runtime.store.apply_activity_transition({"action": "set", "activity": "story", "step": 2, "topic": "恐龙"})
    runtime.model.text = "画板上有两条蓝色线。"
    before = file_bytes(runtime.store)
    response, turn_id = drawing_frame(runtime, transcript="系统自动提示，不是孩子说的话")
    observed = events(response)
    done = next(item for item in observed if item["event"] == "done")
    assert done["ok"] and done["commit_required"] is False and done["user_text"] == ""
    assert "蓝色线" in done["assistant_text"] and runtime.model.text_calls == 0
    assert not any(item["event"] == "user_text" for item in observed)
    assert any(item["event"] == "audio" for item in observed)
    assert "画板快照" in runtime.model.calls[0][2]
    assert "孩子刚刚说" not in runtime.model.calls[0][2]
    assert before == file_bytes(runtime.store)
    assert runtime.client.post(f"/api/conversation/turns/{turn_id}/complete").status_code == 409
    assert runtime.client.post(f"/api/conversation/turns/{turn_id}/cancel").json()["cancelled"]
    assert before == file_bytes(runtime.store)


def test_failed_drawing_observation_speaks_uncertainty_without_consuming_parent_message(runtime):
    runtime.store.add_parent_message("爸爸今晚回来。")
    before = file_bytes(runtime.store)
    def failed(*args):
        raise LLMError("Synthetic vision timeout")
    runtime.model.describe_image = failed
    response, _ = drawing_frame(runtime)
    observed = events(response)
    done = next(item for item in observed if item["event"] == "done")
    assert done["ok"] and "没看清画板" in done["assistant_text"]
    assert "今晚" not in done["assistant_text"] and "蓝色" not in done["assistant_text"]
    assert done["commit_required"] is False and runtime.model.text_calls == 0
    assert before == file_bytes(runtime.store)


@pytest.mark.parametrize("form,with_frame,with_audio,status", [
    ({"visual_source": "other"}, True, False, 422),
    ({"visual_source": "camera", "drawing_observation": "true"}, True, False, 400),
    ({"visual_source": "drawing", "drawing_observation": "true"}, False, False, 400),
    ({"visual_source": "drawing", "drawing_observation": "true"}, True, True, 400),
])
def test_drawing_observation_flags_are_strict(runtime, form, with_frame, with_audio, status):
    files = {}
    if with_frame:
        files["frame"] = ("drawing.png", b"\x89PNG\r\n\x1a\nsynthetic", "image/png")
    if with_audio:
        files["audio"] = ("speech.wav", b"synthetic", "audio/wav")
    response = runtime.client.post("/api/conversation/stream", data=form, files=files)
    assert response.status_code == status
    assert not runtime.model.calls


def test_drawing_and_camera_capabilities_are_separate(runtime):
    runtime.store.update_child_profile({"enabled_activities": ["vision_photo"]})
    response, _ = drawing_frame(runtime)
    assert response.status_code == 403 and not runtime.model.calls
    runtime.store.update_child_profile({"enabled_activities": ["drawing"]})
    response, _ = drawing_frame(runtime)
    assert response.status_code == 200
    camera = runtime.client.post("/api/conversation/frame/stream", content=b"\xff\xd8\xffsynthetic")
    assert camera.status_code == 403


def test_real_child_drawing_request_keeps_normal_playback_receipt(runtime):
    runtime.model.text = "画板上有一个蓝色圆圈。"
    runtime.store.apply_activity_transition({"action": "set", "activity": "colors", "step": 1})
    response, turn_id = drawing_frame(runtime, drawing_observation="false",
                                     transcript="你看我画的圆圈", observation_attempted="true")
    observed = events(response)
    done = next(item for item in observed if item["event"] == "done")
    assert done["commit_required"] and "蓝色圆圈" in done["assistant_text"]
    assert next(item for item in observed if item["event"] == "user_text")["text"] == "你看我画的圆圈"
    assert runtime.store.get_history() == []
    assert runtime.client.post(f"/api/conversation/turns/{turn_id}/complete").json()["ok"]
    assert runtime.store.get_history()[0]["user_text"] == "你看我画的圆圈"
    assert runtime.store.get_activity_state()["step"] == 1


def test_drawing_observation_can_be_cancelled_before_done(runtime):
    turn_id = uuid.uuid4().hex
    runtime.turn_ids.append(turn_id)
    async def cancel_after_audio():
        stream = main._stream_conversation("自动画板提示", vision_context="有一条蓝色线。",
            visual_source="drawing", drawing_observation=True, turn_id=turn_id)
        async for chunk in stream:
            if '"event": "audio"' in chunk:
                main._cancel_stream_turn(turn_id)
                await stream.aclose()
                break
    asyncio.run(cancel_after_audio())
    assert runtime.client.post(f"/api/conversation/turns/{turn_id}/complete").status_code == 409
    assert runtime.store.get_history() == [] and runtime.store.get_recent_learning_events() == []


def test_direct_observation_preserves_uncertainty_and_explicit_content_boundaries():
    evidence = json.dumps({"activity": "colors", "step": 1, "clear": False,
        "objects": [], "description": "也许有一块红色积木。"}, ensure_ascii=False)
    reply = main._observed_scene_reply(evidence)
    assert "没看清" in reply and "红色积木" not in reply
    reply = main._observed_scene_reply("画上有一只恐龙。", {"content_boundaries": ["不要讲恐龙"]})
    assert "恐龙" not in reply
