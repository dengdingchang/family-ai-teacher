"""Exercise product orchestration with temporary family files and simulated media.

This is software integration evidence, never a real child's microphone/camera
or a real Nathan voice/avatar acceptance test.
"""

import asyncio
import io
import json
import uuid
import wave
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.main as main
import memory.store as memory_module
from audio.metrics import unavailable_gpu_measurement
from memory.store import MemoryStore
from tts.adapter import TTSResult


@pytest.fixture
def journey(tmp_path, monkeypatch):
    clock = SimpleNamespace(value=datetime(2026, 9, 6, 1, 0, tzinfo=timezone.utc))

    class FamilyClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.value.astimezone(tz) if tz else clock.value.astimezone().replace(tzinfo=None)

    template = tmp_path / "template.json"
    template.write_text(json.dumps({"name": "旅程测试宝贝", "age": 4, "brain_mode": "ai_station",
                                    "enabled_activities": list(memory_module.DEFAULT_ENABLED_ACTIVITIES)}, ensure_ascii=False), encoding="utf-8")

    def make_store():
        data = tmp_path / "data"
        return MemoryStore(data, data / "profile.json", data / "history.jsonl", data / "events.jsonl", template)

    model_prompts = []
    media_calls = []
    audio_buffer = io.BytesIO()
    with wave.open(audio_buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * 1600)

    class TeacherModel:
        configured = True

        def stream_chat(self, messages, **kwargs):
            model_prompts.append(messages)
            yield "你给积木塔加上了自己的想法。你想给它起什么名字？"

    class SimulatedVoice:
        def synthesize(self, text, **kwargs):
            media_calls.append(text)
            return TTSResult(audio_buffer.getvalue(), .1, .001, unavailable_gpu_measurement(), backend="software-journey-fixture")

        def flush_avatar(self):
            return None

    monkeypatch.setattr(memory_module, "datetime", FamilyClock)
    monkeypatch.setattr(main, "memory", make_store())
    monkeypatch.setattr(main, "llm", TeacherModel())
    monkeypatch.setattr(main, "tts", SimulatedVoice())
    turn_ids = []

    async def async_turn(text, *, commit=True, interrupt=False, vision_context=""):
        # Preserve real conversational ordering under the simulated date clock.
        clock.value += timedelta(seconds=1)
        turn_id = f"journey-{uuid.uuid4().hex}"
        turn_ids.append(turn_id)
        before = len(main.memory.get_history())
        stream = main._stream_conversation(text, turn_id=turn_id, vision_context=vision_context)
        events = []
        async for chunk in stream:
            batch = [json.loads(line[6:]) for line in chunk.splitlines() if line.startswith("data: ")]
            events.extend(batch)
            if interrupt and any(item["event"] == "audio" for item in batch):
                main._cancel_stream_turn(turn_id)
                await stream.aclose()
                assert len(main.memory.get_history()) == before
                with pytest.raises(HTTPException) as error:
                    await main.complete_streaming_turn(turn_id)
                assert error.value.status_code == 409
                return {"turn_id": turn_id, "events": events, "interrupted": True}
        done = next(item for item in events if item["event"] == "done")
        assert done["ok"] and done["commit_required"], [event for event in events if event["event"] == "error"]
        assert any(item["event"] == "audio" for item in events)
        assert len(main.memory.get_history()) == before
        if commit:
            await main.complete_streaming_turn(turn_id)
            assert len(main.memory.get_history()) == before + 1
        return {**done, "events": events}

    def reload_store():
        monkeypatch.setattr(main, "memory", make_store())
        return main.memory

    session = SimpleNamespace(clock=clock, turn=lambda text, **kw: asyncio.run(async_turn(text, **kw)),
                              reload=reload_store, client=TestClient(main.app),
                              model_prompts=model_prompts, media_calls=media_calls, root=tmp_path)
    yield session
    with main._stream_turn_lock:
        for turn_id in turn_ids:
            main._stream_turns.pop(turn_id, None)


def test_family_journey_conversation_cancel_activities_parent_control_and_archive(journey):
    """The full logical journey uses real stream/receipts and real parent APIs."""
    welcome = journey.turn("爸爸老师，我回来了")
    assert "旅程测试宝贝" in welcome["assistant_text"]
    chat = journey.turn("今天我搭了一个很高的积木塔")
    assert "积木塔" in chat["assistant_text"] and journey.model_prompts
    assert "旅程测试宝贝" in journey.model_prompts[-1][0]["content"]

    interrupted = journey.turn("教我画飞机", interrupt=True)
    assert interrupted["interrupted"] and main.memory.get_activity_state()["status"] == "idle"
    assert not any(item["user_text"] == "教我画飞机" for item in main.memory.get_history())
    drawing = journey.turn("教我画恐龙")
    assert "恐龙" in drawing["assistant_text"]
    journey.turn("画好了")
    assert main.memory.get_activity_state()["step"] == 2
    story = journey.turn("我不想画了我想听恐龙故事")
    assert "小恐龙" in story["assistant_text"]
    journey.turn("小狗")
    assert main.memory.get_activity_state()["activity"] == "story"
    assert main.memory.get_activity_state()["step"] == 2

    journey.clock.value += timedelta(days=1)
    journey.reload()
    returned = journey.turn("爸爸老师，我回来了")
    assert "恐龙" in returned["assistant_text"]
    assert main.memory.get_activity_state()["activity"] == "story"
    assert main.memory.get_activity_state()["step"] == 2
    consent = journey.turn("好呀")
    assert "走向好呀" not in consent["assistant_text"]
    assert main.memory.get_activity_state()["step"] == 2
    journey.turn("左边")
    journey.turn("我想和爸爸一起玩")
    assert main.memory.get_activity_state()["status"] == "idle"

    candidate = journey.client.post("/api/memories", json={"summary": "第一次数到了二十", "category": "episodic"}).json()
    assert candidate["status"] == "candidate"
    assert not any("第一次数到了二十" in week["milestones"] for week in main.memory.get_growth_journal())
    corrected = journey.client.patch(f"/api/memories/{candidate['id']}", json={"summary": "爸爸确认独立数到了十", "status": "durable"})
    assert corrected.status_code == 200
    obsolete = journey.client.post("/api/memories", json={"summary": "需要删除的测试回忆", "status": "durable"}).json()
    assert journey.client.delete(f"/api/memories/{obsolete['id']}").status_code == 200
    all_memories = journey.client.get("/api/memories").json()["memories"]
    assert any(item["id"] == candidate["id"] and item["summary"] == "爸爸确认独立数到了十" for item in all_memories)
    assert all(item["id"] != obsolete["id"] for item in all_memories)

    message = journey.client.post("/api/parent/messages", json={"text": "告诉宝贝爸爸很想他"}).json()
    delivered_turn = journey.turn("爸爸老师你好", commit=False)
    assert "爸爸很想你" in delivered_turn["assistant_text"]
    assert main.memory.get_pending_parent_message()["id"] == message["id"]
    asyncio.run(main.complete_streaming_turn(delivered_turn["turn_id"]))
    assert main.memory.get_parent_messages()[0]["status"] == "delivered"
    journey.turn("我也想爸爸")
    assert main.memory.get_parent_messages()[0]["child_response"] == "我也想爸爸"

    invitation = journey.client.post("/api/parent/messages", json={"text": "今天可以陪他画一架飞机"}).json()
    journey.turn("接下来做什么")
    assert main.memory.get_activity_state()["status"] == "idle"
    accepted = journey.turn("我想先画机身")
    assert "长长的机身" in accepted["assistant_text"]
    assert main.memory.get_activity_state()["topic"] == "飞机"
    assert next(item for item in main.memory.get_parent_messages() if item["id"] == invitation["id"])["child_response"] == "我想先画机身"

    review = journey.client.patch("/api/skills/math.count_1_10", json={"status": "practicing", "last_evidence": "爸爸确认正在练习十以内数数"})
    assert review.status_code == 200
    journey.clock.value += timedelta(days=14)
    journey.reload()
    dashboard = journey.client.get("/api/parent/dashboard").json()
    archive = dashboard["growth_journal"]
    assert len(archive) >= 3
    assert any("爸爸确认独立数到了十" in week["milestones"] for week in archive)
    assert any(any("我也想爸爸" in entry for entry in week["parent_connections"]) for week in archive)
    assert any(week["skill_reviews"] for week in archive)
    export = journey.client.get("/api/parent/export").json()
    assert export["raw_media_included"] is False
    assert [turn["user_text"] for turn in export["history"]] == [
        "爸爸老师，我回来了", "今天我搭了一个很高的积木塔", "教我画恐龙", "画好了",
        "我不想画了我想听恐龙故事", "小狗", "爸爸老师，我回来了", "好呀", "左边", "我想和爸爸一起玩",
        "爸爸老师你好", "我也想爸爸", "接下来做什么", "我想先画机身",
    ]
    assert all(item["id"] != obsolete["id"] for item in export["memories"])
    assert any(item["id"] == candidate["id"] and item["status"] == "durable" for item in export["memories"])
    assert not list(journey.root.rglob("*.wav")) and not list(journey.root.rglob("*.jpg"))


def test_overnight_unfinished_activity_preserves_checkpoint_but_explicit_finish_does_not_resurrect_it(journey):
    journey.turn("教我画恐龙")
    journey.turn("画好了")
    journey.clock.value += timedelta(hours=24)
    journey.reload()
    assert main.memory.get_activity_state()["status"] == "idle"
    greeting = journey.turn("我回来啦")
    assert "上次的恐龙" in greeting["assistant_text"]
    state = main.memory.get_activity_state()
    assert state["activity"] == "drawing" and state["topic"] == "恐龙" and state["step"] == 2
    journey.turn("尾巴")
    journey.turn("绿色")
    assert main.memory.get_activity_state()["status"] == "idle"
    journey.clock.value += timedelta(hours=24)
    journey.reload()
    journey.turn("我回来啦")
    assert main.memory.get_activity_state()["activity"] != "drawing"


def test_actual_stream_uses_current_image_evidence_and_defers_progress_to_receipt(journey):
    journey.turn("教我认颜色")
    assert main.memory.get_activity_state()["activity"] == "colors"
    evidence = json.dumps({"activity": "colors", "step": 1, "clear": True,
                           "objects": [{"label": "积木", "color": "red", "count": 1}],
                           "description": "桌上有一块红色积木。"}, ensure_ascii=False)
    observed = journey.turn("爸爸你看我的积木", vision_context=evidence, commit=False)
    assert "Red" in observed["assistant_text"]
    assert main.memory.get_activity_state()["step"] == 1
    assert not any('"objects"' in json.dumps(event, ensure_ascii=False) for event in observed["events"])
    asyncio.run(main.complete_streaming_turn(observed["turn_id"]))
    assert main.memory.get_activity_state()["step"] == 2
    assert not any(item["status"] == "mastered" for item in main.memory.get_skill_graph()["skills"])


def test_uncertain_visual_turn_and_cancelled_parent_invitation_never_advance(journey):
    journey.turn("教我认颜色")
    uncertain = json.dumps({"activity": "colors", "step": 1, "clear": False,
                            "objects": [], "description": "物体颜色看不清。"}, ensure_ascii=False)
    result = journey.turn("爸爸你看", vision_context=uncertain)
    assert "不能确认" in result["assistant_text"]
    assert main.memory.get_activity_state()["step"] == 1
    journey.turn("我想休息一下")
    message = journey.client.post("/api/parent/messages", json={"text": "今天可以陪他画一架飞机"}).json()
    journey.turn("爸爸老师你好", interrupt=True)
    assert main.memory.get_pending_parent_message()["id"] == message["id"]
    assert main.memory.get_activity_state()["status"] == "idle"


@pytest.mark.parametrize("activity, subject, step, cue, expected, real_answer, next_step", [
    ("story", "恐龙", 2, "好呀", "往左还是往右", "左边", 3),
    ("drawing", "恐龙", 1, "可以呀", "椭圆身体", "画好了", 2),
    ("numbers", "数数游戏", 2, "继续吧", "一共有几根", "三", None),
])
def test_welcome_consent_repeats_pending_action_without_passing_it(journey, activity, subject, step, cue, expected, real_answer, next_step):
    main.memory.apply_activity_transition({"action": "set", "activity": activity, "topic": subject, "step": step})
    journey.clock.value += timedelta(days=1)
    journey.reload()
    journey.turn("我回来了")
    reply = journey.turn(cue)
    state = main.memory.get_activity_state()
    assert state["activity"] == activity and state["step"] == step
    assert expected in reply["assistant_text"]
    assert not any(claim in reply["assistant_text"] for claim in ("遇见了好呀", "走向好呀", "答对", "完成啦"))
    journey.turn(real_answer)
    if next_step is None:
        assert main.memory.get_activity_state()["status"] == "idle"
    else:
        assert main.memory.get_activity_state()["step"] == next_step
