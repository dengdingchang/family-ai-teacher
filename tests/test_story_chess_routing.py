"""Story/chess orchestration using RAM audio and a temporary family store only."""

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
from stt.adapter import STTResult
from tts.adapter import TTSResult


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    data = tmp_path / "data"
    store = MemoryStore(data, data / "profile.json", data / "history.jsonl",
                        data / "events.jsonl", tmp_path / "missing-template.json")
    store.update_child_profile({"name": "临时测试宝贝", "age": 4,
                                "brain_mode": "ai_station",
                                "enabled_activities": ["story", "game"]})
    model = SimpleNamespace(configured=True, calls=[], fail=False,
                            text="小企鹅请海豹来帮忙，把木板稳稳搭成小船。你想先检查船底还是船边？")

    def stream(messages, **kwargs):
        model.calls.append((messages, kwargs))
        if model.fail:
            raise LLMError("Synthetic remote narrator unavailable")
        yield model.text

    model.stream_chat = stream
    audio = io.BytesIO()
    with wave.open(audio, "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\0\0" * 1600)
    wav_bytes = audio.getvalue()
    voice = []
    recognition = SimpleNamespace(text="", calls=[])

    def speak(text, **kwargs):
        voice.append(text)
        return TTSResult(wav_bytes, .1, .001, unavailable_gpu_measurement(), backend="test")

    def recognize(raw, **kwargs):
        assert raw == wav_bytes
        recognition.calls.append(len(raw))
        return STTResult(recognition.text, "zh", .1, .001, unavailable_gpu_measurement())

    monkeypatch.setattr(main, "memory", store)
    monkeypatch.setattr(main, "llm", model)
    monkeypatch.setattr(main, "tts", SimpleNamespace(synthesize=speak, flush_avatar=lambda: None))
    monkeypatch.setattr(main, "stt", SimpleNamespace(transcribe_bytes=recognize))
    # No lifespan context: importing the app and mocking adapters must not warm models.
    session = SimpleNamespace(store=store, model=model, voice=voice, stt=recognition,
                              wav=wav_bytes, client=TestClient(main.app), turn_ids=[])
    yield session
    session.client.close()
    with main._stream_turn_lock:
        for turn_id in session.turn_ids:
            main._stream_turns.pop(turn_id, None)


def request_turn(runtime, text, entry="text"):
    turn_id = f"story-chess-{uuid.uuid4().hex}"
    runtime.turn_ids.append(turn_id)
    headers = {"x-conversation-turn-id": turn_id}
    if entry == "audio":
        runtime.stt.text = text
        response = runtime.client.post("/api/conversation/stream", headers=headers,
                                       files={"audio": ("synthetic.wav", runtime.wav, "audio/wav")})
    else:
        response = runtime.client.post("/api/conversation/text/stream", headers=headers,
                                       json={"text": text})
    return turn_id, response


def events(response):
    assert response.status_code == 200, response.text
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def spoken_turn(runtime, text):
    turn_id, response = request_turn(runtime, text)
    observed = events(response)
    done = next(event for event in observed if event["event"] == "done")
    assert done["ok"] and done["commit_required"]
    assert any(event["event"] == "audio" for event in observed)
    return turn_id, done


def complete(runtime, turn_id):
    response = runtime.client.post(f"/api/conversation/turns/{turn_id}/complete")
    assert response.status_code == 200, response.text
    return response.json()


def test_explicit_continue_advances_a_catalog_story_even_offline(runtime):
    runtime.store.update_child_profile({"brain_mode": "local_lessons_only"})
    turn_id, first = spoken_turn(runtime, "讲一个故事吧")
    complete(runtime, turn_id)
    turn_id, second = spoken_turn(runtime, "继续讲吧")
    assert second["assistant_text"] != first["assistant_text"]
    assert second["activity_transition"]["step"] == 2
    assert runtime.store.get_activity_state()["step"] == 1
    complete(runtime, turn_id)
    assert runtime.store.get_activity_state()["step"] == 2


def test_partial_remote_story_failure_uses_a_complete_plan(runtime):
    def broken(*args, **kwargs):
        yield "小企鹅刚拿起"
        raise LLMError("Synthetic midway failure")
    runtime.model.stream_chat = broken
    _, done = spoken_turn(runtime, "讲一个故事吧")
    assert "冰桥" in done["assistant_text"] and done["assistant_text"].endswith("？")
    assert "小企鹅刚拿起" not in "".join(runtime.voice)


@pytest.mark.parametrize("entry", ["text", "audio"])
def test_open_board_question_has_current_legal_moves_and_cannot_advance_old_story(runtime, entry):
    runtime.store.apply_activity_transition({"action": "set", "activity": "story", "step": 1, "topic": "企鹅的冰桥"})
    context = "玩法：跟爸爸学。白马d4，目标f5。合法走法：d4到f5。"
    runtime.model.text = "马可以跳过棋子，走一个日字。试着点白马，再点 f5，好吗？"
    turn_id = uuid.uuid4().hex
    runtime.turn_ids.append(turn_id)
    headers = {"x-conversation-turn-id": turn_id}
    if entry == "audio":
        runtime.stt.text = "你看这个马可以跳吗"
        response = runtime.client.post("/api/conversation/stream", headers=headers,
            data={"chess_context": context}, files={"audio": ("test.wav", runtime.wav, "audio/wav")})
    else:
        response = runtime.client.post("/api/conversation/text/stream", headers=headers,
            json={"text": "马可以跳吗", "chess_context": context})
    done = next(item for item in events(response) if item["event"] == "done")
    assert done["ok"] and "马" in done["assistant_text"]
    assert not done.get("activity_transition")
    assert any(context in item["content"] for item in runtime.model.calls[-1][0])
    assert "忽略旧故事" in runtime.model.calls[-1][0][0]["content"]
    complete(runtime, turn_id)
    assert runtime.store.get_activity_state()["step"] == 1
    assert context not in json.dumps(runtime.store.export_bundle(), ensure_ascii=False)


@pytest.mark.parametrize("text", ["我想听故事", "我累了休息一下"])
def test_explicit_board_exit_still_honors_activity_controls(runtime, text):
    turn_id = uuid.uuid4().hex
    runtime.turn_ids.append(turn_id)
    response = runtime.client.post("/api/conversation/text/stream",
        headers={"x-conversation-turn-id": turn_id}, json={"text": text, "chess_context": "白兵在e2，能到e3。"})
    done = next(item for item in events(response) if item["event"] == "done")
    assert done["ok"]
    if "故事" in text:
        assert done["activity_transition"]["activity"] == "story"
    else:
        assert "休息" in done["assistant_text"]
        assert done["activity_transition"] == {"action": "clear"}


def test_board_context_is_bounded_and_game_permission_is_required(runtime):
    response = runtime.client.post("/api/conversation/text/stream", json={"text": "怎么走", "chess_context": "棋" * 3001})
    assert response.status_code == 422
    runtime.store.update_child_profile({"enabled_activities": ["story"]})
    response = runtime.client.post("/api/conversation/text/stream", json={"text": "怎么走", "chess_context": "白兵e2"})
    assert response.status_code == 403 and not runtime.model.calls


def test_chess_clarification_is_preserved_instead_of_old_generic_lesson(runtime):
    runtime.model.text = "你想问白马怎么跳，还是白兵怎么走？"
    response = runtime.client.post("/api/conversation/text/stream", json={
        "text": "这个怎么走", "chess_context": "白马d4，白兵e2；当前没有选中棋子。"})
    done = next(item for item in events(response) if item["event"] == "done")
    runtime.turn_ids.append(done["turn_id"])
    assert done["assistant_text"] == runtime.model.text
    assert not done.get("activity_transition")


@pytest.mark.parametrize("mode,remote_failure", [("local_lessons_only", False), ("ai_station", True)])
def test_repeated_story_starts_speak_different_concrete_plots(runtime, mode, remote_failure):
    runtime.store.update_child_profile({"brain_mode": mode})
    runtime.model.fail = remote_failure
    topics, replies = [], []
    for _ in range(3):
        history_count = len(runtime.store.get_history())
        turn_id, done = spoken_turn(runtime, "我想听一个故事")
        assert len(runtime.store.get_history()) == history_count
        replies.append(done["assistant_text"])
        assert done["assistant_text"] in "".join(runtime.voice)
        assert "声音" not in done["assistant_text"] and "连接" not in done["assistant_text"]
        complete(runtime, turn_id)
        topics.append(runtime.store.get_activity_state()["topic"])
    assert len(set(topics)) == 3
    assert len(set(replies)) == 3
    # Distinct plot facts, rather than just different titles or a generic invitation.
    assert any("冰桥" in reply for reply in replies)
    assert any("包裹" in reply for reply in replies)
    assert any("音乐会" in reply for reply in replies)
    assert len(runtime.model.calls) == (3 if remote_failure else 0)


@pytest.mark.parametrize("mode,expected_calls", [("ai_station", 1), ("local_lessons_only", 0)])
def test_remote_story_uses_narrator_but_local_story_remains_available(runtime, mode, expected_calls):
    runtime.store.update_child_profile({"brain_mode": mode})
    _, done = spoken_turn(runtime, "我想听一个故事")
    assert len(runtime.model.calls) == expected_calls
    if expected_calls:
        assert done["assistant_text"] == runtime.model.text
        messages, _ = runtime.model.calls[0]
        assert messages[-1]["content"] == "我想听一个故事"
        assert "本轮是共同讲故事" in messages[0]["content"]
    else:
        assert "冰桥" in done["assistant_text"]
    assert runtime.store.get_history() == []
    assert runtime.store.get_activity_state()["status"] == "idle"


def test_cancelled_story_does_not_consume_a_topic_and_complete_is_idempotent(runtime):
    runtime.store.update_child_profile({"brain_mode": "local_lessons_only"})
    first_id, first = spoken_turn(runtime, "我想听一个故事")
    assert runtime.client.post(f"/api/conversation/turns/{first_id}/cancel").json()["cancelled"]
    assert runtime.client.post(f"/api/conversation/turns/{first_id}/complete").status_code == 409
    assert runtime.store.get_activity_state()["status"] == "idle"
    assert runtime.store.get_history() == []
    second_id, second = spoken_turn(runtime, "我想听一个故事")
    assert first["assistant_text"] == second["assistant_text"]
    complete(runtime, second_id)
    assert complete(runtime, second_id)["already_completed"]
    assert len(runtime.store.get_history()) == 1
    assert runtime.store.get_activity_state()["step"] == 1


@pytest.mark.parametrize("cancel", [False, True])
def test_story_continuation_advances_only_after_complete(runtime, cancel):
    runtime.store.update_child_profile({"brain_mode": "local_lessons_only"})
    start_id, _ = spoken_turn(runtime, "我想听一个故事")
    complete(runtime, start_id)
    original = runtime.store.get_activity_state()
    turn_id, done = spoken_turn(runtime, "你接着讲吧")
    assert "小船" in done["assistant_text"]
    assert runtime.store.get_activity_state() == original
    if cancel:
        runtime.client.post(f"/api/conversation/turns/{turn_id}/cancel")
        assert runtime.client.post(f"/api/conversation/turns/{turn_id}/complete").status_code == 409
    else:
        complete(runtime, turn_id)
    assert runtime.store.get_activity_state()["step"] == (1 if cancel else 2)
    assert len(runtime.store.get_history()) == (1 if cancel else 2)


def test_repeated_unclear_syllables_are_not_accepted_as_a_story_direction(runtime):
    runtime.store.update_child_profile({"brain_mode": "local_lessons_only"})
    runtime.store.apply_activity_transition({"action": "set", "activity": "story", "step": 2, "topic": "恐龙"})
    turn_id, done = spoken_turn(runtime, "娃娃娃娃")
    assert "娃娃娃娃" not in done["assistant_text"]
    assert "走向" not in done["assistant_text"]
    assert "左" in done["assistant_text"] and "右" in done["assistant_text"]
    complete(runtime, turn_id)
    assert runtime.store.get_activity_state()["step"] == 2


@pytest.mark.parametrize("text", ["我想学国际象棋", "我想学游泳"])
def test_explicit_new_subject_is_not_used_to_finish_an_old_story(runtime, text):
    runtime.store.apply_activity_transition({"action": "set", "activity": "story", "step": 3, "topic": "恐龙"})
    reply, transition = main._activity_turn_reply(text, runtime.store.get_child_profile())
    assert reply == ""
    assert transition == {"action": "clear"}
    assert runtime.store.get_activity_state()["step"] == 3


def test_new_swimming_subject_reaches_remote_model_and_clears_story_only_on_complete(runtime):
    runtime.store.apply_activity_transition({"action": "set", "activity": "story", "step": 3, "topic": "恐龙"})
    runtime.model.text = "学游泳要和大人在浅水区练习。你想先练习踢水还是吹泡泡？"
    turn_id, done = spoken_turn(runtime, "我想学游泳")
    assert "游泳" in done["assistant_text"] and "星星" not in done["assistant_text"]
    assert len(runtime.model.calls) == 1
    assert runtime.model.calls[0][0][-1]["content"] == "我想学游泳"
    assert "本轮是共同讲故事" not in runtime.model.calls[0][0][0]["content"]
    assert runtime.store.get_activity_state()["step"] == 3
    complete(runtime, turn_id)
    assert runtime.store.get_activity_state()["status"] == "idle"


@pytest.mark.parametrize("entry", ["text", "audio"])
@pytest.mark.parametrize("text", ["我想学国际象棋", "我想下国际象棋", "我想學國際象棋", "爸爸老师，教我国际象棋吧！"])
def test_explicit_chess_opens_board_without_a_story_turn_or_family_receipt(runtime, entry, text):
    runtime.store.apply_activity_transition({"action": "set", "activity": "story", "step": 3, "topic": "恐龙"})
    before = runtime.store.get_activity_state()
    turn_id, response = request_turn(runtime, text, entry)
    assert events(response) == [{"event": "chess_request", "text": text}]
    assert runtime.model.calls == [] and runtime.voice == []
    assert len(runtime.stt.calls) == (1 if entry == "audio" else 0)
    assert runtime.store.get_history() == []
    assert runtime.store.get_activity_state() == before
    assert turn_id not in main._stream_turns
    assert not runtime.store.learning_events_path.exists()


@pytest.mark.parametrize("entry", ["text", "audio"])
@pytest.mark.parametrize("text", ["我不想学国际象棋", "不要下国际象棋", "昨天我想学国际象棋",
                                  "我以前下过国际象棋", "我想学国际相启", "国际象棋是什么？"])
def test_negation_history_and_misrecognition_do_not_open_chess(runtime, entry, text):
    _, response = request_turn(runtime, text, entry)
    assert not any(event["event"] == "chess_request" for event in events(response))
    assert runtime.store.get_history() == []


@pytest.mark.parametrize("entry", ["text", "audio"])
def test_disabled_game_cannot_be_opened_through_chess_requests(runtime, entry):
    runtime.store.update_child_profile({"enabled_activities": ["story"]})
    turn_id, response = request_turn(runtime, "我想学国际象棋", entry)
    assert response.status_code == 403
    assert "chess_request" not in response.text
    assert runtime.model.calls == [] and runtime.voice == []
    assert runtime.store.get_history() == []
    assert turn_id not in main._stream_turns
