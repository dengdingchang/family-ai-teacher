"""Family records must distinguish observed speech, candidates and playback."""

import asyncio
import io
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient

from app import main
from memory.store import MemoryStore


@pytest.fixture
def store(tmp_path):
    template = tmp_path / "template.json"
    template.write_text(json.dumps({"name": "宝贝", "brain_mode": "local_lessons_only"}), encoding="utf-8")
    data = tmp_path / "data"
    return MemoryStore(data, data / "profile.json", data / "history.jsonl", data / "events.jsonl", template)


def deliver(store):
    message = store.add_parent_message("告诉宝贝爸爸很想他")
    store.save_session_turn("你好", "爸爸说很想你，你想对爸爸说什么？")
    store.mark_parent_message_delivered(message["id"], "爸爸说很想你，你想对爸爸说什么？")
    return message


def test_legacy_sse_without_header_still_requires_successful_playback(store):
    parent = store.add_parent_message("告诉宝贝爸爸很想他")
    voice = SimpleNamespace(synthesize=lambda *args, **kwargs: SimpleNamespace(avatar_cued=False))
    with patch.object(main, "memory", store), patch.object(main, "tts", voice), \
         patch.object(main, "_tts_payload", return_value={"audio_base64": "synthetic", "audio_mime": "audio/ogg"}):
        client = TestClient(main.app)
        response = client.post("/api/conversation/text/stream", json={"text": "你好"})
        assert response.status_code == 200
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        done = next(item for item in events if item["event"] == "done")
        turn_id = done["turn_id"]
        try:
            assert done["ok"] and done["commit_required"] and turn_id
            assert not store.get_history()
            assert store.get_parent_messages()[0]["id"] == parent["id"]
            assert store.get_parent_messages()[0]["status"] == "pending"
            assert client.post(f"/api/conversation/turns/{turn_id}/complete").status_code == 200
            assert len(store.get_history()) == 1
            assert store.get_parent_messages()[0]["status"] == "delivered"
        finally:
            with main._stream_turn_lock:
                main._stream_turns.pop(turn_id, None)


def test_unrelated_or_old_message_is_not_a_response(store):
    deliver(store)
    assert store.capture_parent_message_response("月亮为什么跟着我") is None
    assert store.capture_parent_message_response("我想学画画") is None
    messages = store.get_parent_messages()
    messages[0]["delivered_at"] = "2020-01-01T00:00:00+00:00"
    store._write_json(store.parent_messages_path, messages)
    assert store.capture_parent_message_response("我也想爸爸") is None
    assert store.get_parent_messages()[0]["status"] == "delivered"


def test_committed_reply_is_associated_once_and_never_with_later_turn(store):
    deliver(store)
    with patch.object(main, "memory", store):
        main._record_turn("我也想爸爸", "晚上和爸爸说吧。")
        main._record_turn("我们画画吧", "先画一个圆。")
    message = store.get_parent_messages()[0]
    assert message["status"] == "responded"
    assert message["child_response"] == "我也想爸爸"


def test_cancelled_stream_does_not_capture_a_parent_response(store):
    deliver(store)
    async def start_then_cancel():
        stream = main._stream_conversation("我也想爸爸", turn_id="receipt-cancel-0001")
        await anext(stream)
        main._cancel_stream_turn("receipt-cancel-0001")
        await stream.aclose()
    # The cancellation boundary is under test, never the real GPU runtime.
    fake_tts = SimpleNamespace(synthesize=lambda *a, **k: None)
    with patch.object(main, "memory", store), patch.object(main, "tts", fake_tts):
        asyncio.run(start_then_cancel())
    assert store.get_parent_messages()[0]["status"] == "delivered"
    assert len(store.get_history()) == 1


def test_candidate_is_not_a_confirmed_milestone(store):
    store.observe_turn("我第一次完整数到二十", "我们一起数一次。")
    journal = store.get_growth_journal()[0]
    assert not journal["milestones"]
    assert journal["milestone_candidates"]
    candidate = store.get_memories()[0]
    store.update_memory(candidate["id"], {"status": "durable"})
    journal = store.get_growth_journal()[0]
    assert journal["milestones"]
    assert not journal["milestone_candidates"]


def test_unreadable_family_data_remains_recoverable(store):
    store.get_child_profile()
    store.profile_path.write_bytes(b"\xff\xfe damaged")
    assert store.get_child_profile()["age"] == 4
    with pytest.raises(OSError):
        store.update_child_profile({"name": "new"})
    assert store.profile_path.read_bytes() == b"\xff\xfe damaged"
    store.history_path.write_bytes(b"\xff\n" + json.dumps({"user_text": "valid"}).encode() + b"\n")
    assert store.get_history() == [{"user_text": "valid"}]


def test_video_observation_survives_memory_failure(store):
    result = SimpleNamespace(text="一块红色积木", elapsed_s=0.1)
    with (patch.object(main, "memory", store),
          patch.object(main.camera, "extract_video_keyframes", return_value=[b"image"]),
          patch.object(main, "llm", SimpleNamespace(configured=True, describe_images=lambda *a: result)),
          patch.object(store, "save_learning_event", side_effect=OSError("disk unavailable"))):
        response = asyncio.run(main.describe_video(UploadFile(file=io.BytesIO(b"clip"), filename="clip.webm")))
    assert response["description"] == "一块红色积木"
    assert response["persisted_video"] is False


def test_old_memories_and_messages_survive_updates_beyond_display_limits(store):
    memories = [{"id": f"m{i}", "summary": f"回忆{i}", "category": "episodic", "status": "durable"}
                for i in range(10005)]
    store._write_json(store.memories_path, memories)
    store.update_memory("m0", {"summary": "最早的回忆更正"})
    store.add_memory("今天的新回忆")
    assert len(store.get_memories(limit=None)) == 10006
    assert store.get_memories(limit=None)[0]["summary"] == "最早的回忆更正"
    assert store.get_memories(limit=0) == []
    messages = [{"id": f"p{i}", "text": f"留言{i}", "status": "pending"} for i in range(10005)]
    store._write_json(store.parent_messages_path, messages)
    store.cancel_parent_message("p0")
    store.add_parent_message("今天的留言")
    bundle = store.export_bundle()
    assert len(bundle["memories"]) == 10006
    assert len(bundle["parent_messages"]) == 10006
    assert bundle["parent_messages"][0]["status"] == "cancelled"


def test_recall_finds_an_old_relevant_memory_and_never_a_candidate(store):
    oldest = store.add_memory("第一次和爸爸画了一架绿色飞机", status="durable", tags=["飞机"])
    for i in range(12):
        store.add_memory(f"一次新的其他活动{i}", status="durable")
    store.add_memory("我自己造了飞机飞上天", tags=["飞机"])
    recalled = store.recall_memories("你还记得我画的飞机吗？")
    assert recalled[0]["id"] == oldest["id"]
    assert all(item["status"] == "durable" for item in recalled)


def test_legacy_json_client_also_requires_playback_receipt(store):
    message = store.add_parent_message("告诉宝贝爸爸想他")
    audio = SimpleNamespace(audio_bytes=b"fixture", audio_mime="audio/ogg", duration_s=1,
                            elapsed_s=.1, backend="fixture", avatar_cued=False, avatar_audio_lead_ms=0,
                            gpu=SimpleNamespace(available=False, start_mib=None, peak_mib=None, end_mib=None, sample_count=0))
    with patch.object(main, "memory", store), patch.object(main, "tts", SimpleNamespace(synthesize=lambda *a: audio)):
        response = asyncio.run(main._answer_text("你好"))
        assert response["commit_required"] and response["history"] is None
        assert store.get_pending_parent_message()["id"] == message["id"]
        asyncio.run(main.complete_streaming_turn(response["turn_id"]))
    assert store.get_parent_messages()[0]["status"] == "delivered"


def test_parent_skill_reviews_form_a_recoverable_growth_trail(store):
    store.update_skill("math.count_1_10", {"status": "practicing", "last_evidence": "练习数积木"})
    store.update_skill("math.count_1_10", {"status": "mastered", "last_evidence": "爸爸看到独立数完十块"})
    reviews = store.get_growth_journal()[0]["skill_reviews"]
    assert [review["status"] for review in reviews] == ["practicing", "mastered"]
    assert reviews[-1]["previous_status"] == "practicing"
    assert reviews[-1]["evidence"] == "爸爸看到独立数完十块"
