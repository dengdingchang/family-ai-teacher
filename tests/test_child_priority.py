"""An ongoing lesson or pending parent note must not hide a child's urgent request."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app import main


@pytest.mark.parametrize("text", ["我受伤了", "爸爸老师，我很害怕", "我找不到妈妈", "我的肚子很疼", "有人欺负我"])
def test_personal_distress_stops_the_lesson_and_requests_a_trusted_adult(text):
    assert "身边可信任的大人" in main._child_priority_reply(text)


@pytest.mark.parametrize("text", ["故事里的小恐龙受伤了", "我想听一个害怕的故事", "小狗找不到妈妈", "我没有受伤", "我不害怕"])
def test_stories_and_negated_distress_are_not_claimed_to_be_personal_emergencies(text):
    assert not main._child_priority_reply(text)


def test_identity_and_attachment_have_honest_local_answers():
    assert "AI" in main._child_priority_reply("你是我爸爸吗")
    assert "爸爸妈妈也很重要" in main._child_priority_reply("我只要你，不要爸爸妈妈")


def test_priority_reply_does_not_deliver_pending_message_or_advance_lesson():
    turn_id = "child-priority-fixture"

    async def run():
        return [json.loads(frame.removeprefix("data: ")) async for frame in
                main._stream_conversation("我流血了", turn_id=turn_id)]

    voice = SimpleNamespace(synthesize=lambda *a, **k: SimpleNamespace(avatar_cued=False))
    with patch.object(main, "tts", voice), \
         patch.object(main, "_tts_payload", return_value={"audio_base64": "synthetic"}), \
         patch.object(main, "_current_profile", return_value={}), \
         patch.object(main, "_pending_parent_message", return_value={"id": "pending-fixture"}), \
         patch.object(main, "_parent_message_reply") as parent, \
         patch.object(main, "_activity_turn_reply") as activity:
        try:
            events = asyncio.run(run())
            assert events[-1]["ok"]
            assert "身边可信任的大人" in events[-1]["assistant_text"]
            assert main._stream_turns[turn_id]["parent_message_id"] == ""
            assert main._stream_turns[turn_id]["activity_transition"] is None
            parent.assert_not_called()
            activity.assert_not_called()
        finally:
            with main._stream_turn_lock:
                main._stream_turns.pop(turn_id, None)
