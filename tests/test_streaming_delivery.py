"""Chunk delivery must precede synthesis completion without committing partial turns."""

import asyncio
import io
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import wave
from unittest.mock import patch

import pytest

import app.main as main
from audio.metrics import unavailable_gpu_measurement
from tts.adapter import TTSAdapterError, TTSResult


def voice_chunk():
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
        target.writeframes(b"\x01\x00" * 15360)
    return TTSResult(output.getvalue(), .64, .1, unavailable_gpu_measurement(), backend="local-streaming")


def test_cancelled_stream_closes_without_exhausting_the_default_executor():
    release_model = threading.Event()
    turn_id = "queue-cancel-fixture"

    def slow_model(*args, **kwargs):
        release_model.wait(2)
        yield "下一句。"

    async def run():
        asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=1))
        stream = main._stream_conversation("测试开放问题", turn_id=turn_id, audio_streaming=True)
        await anext(stream)  # user_text, before the remote model replies
        pending = asyncio.create_task(anext(stream))
        await asyncio.sleep(.05)
        main._cancel_stream_turn(turn_id)
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(pending, .8)
        # This would remain blocked behind an unbounded Queue.get after cancel.
        assert await asyncio.wait_for(asyncio.to_thread(lambda: "available"), .5) == "available"

    with patch.object(main, "_current_profile", return_value={}), \
         patch.object(main, "_parent_activity_acceptance_reply", return_value=("", None)), \
         patch.object(main, "_pending_parent_message", return_value=None), \
         patch.object(main, "_activity_turn_reply", return_value=("", None)), \
         patch.object(main, "llm", SimpleNamespace(configured=True, stream_chat=slow_model)), \
         patch.object(main, "_messages_for", return_value=[]), \
         patch.object(main, "tts", SimpleNamespace(synthesize_stream=lambda *a, **k: iter(()))):
        try:
            asyncio.run(run())
        finally:
            release_model.set()
            with main._stream_turn_lock:
                main._stream_turns.pop(turn_id, None)


@pytest.mark.parametrize("outcome", ["complete", "truncated", "cancelled"])
def test_chunk_arrives_while_synthesizer_is_waiting_and_partial_output_never_commits(outcome):
    release = threading.Event()
    turn_id = f"chunk-delivery-{outcome}"

    class Voice:
        def synthesize_stream(self, text, *, cancel_event, **kwargs):
            yield voice_chunk()
            assert release.wait(3), "SSE waited for the entire synthesis"
            if outcome == "truncated":
                raise TTSAdapterError("incomplete synthetic stream")
            if cancel_event.is_set():
                return
            yield voice_chunk()

    async def run():
        events = []
        stream = main._stream_conversation("测试问题", turn_id=turn_id, audio_streaming=True)
        async for frame in stream:
            event = json.loads(frame.removeprefix("data: "))
            events.append(event)
            if event["event"] == "audio" and not release.is_set():
                if outcome == "cancelled":
                    main._cancel_stream_turn(turn_id)
                    release.set()
                    await stream.aclose()
                    break
                release.set()
        return events

    with patch.object(main, "tts", Voice()), \
         patch.object(main, "_current_profile", return_value={}), \
         patch.object(main, "_parent_activity_acceptance_reply", return_value=("", None)), \
         patch.object(main, "_pending_parent_message", return_value=None), \
         patch.object(main, "_activity_turn_reply", return_value=("请说苹果。", None)), \
         patch.object(main, "_record_turn") as record:
        try:
            events = asyncio.run(asyncio.wait_for(run(), timeout=5))
            chunks = [item for item in events if item["event"] == "audio"]
            assert [item["sequence"] for item in chunks] == list(range(1, len(chunks) + 1))
            assert all(item["audio_stream"] and item["semantic"] for item in chunks)
            assert all(item["avatar_pcm_base64"] and not item.get("avatar_pending") for item in chunks)
            record.assert_not_called()
            if outcome == "complete":
                assert len(chunks) == 2
                done = next(item for item in events if item["event"] == "done")
                assert done["ok"] and done["commit_required"]
                assert main._stream_turns[turn_id]["status"] == "ready"
            elif outcome == "truncated":
                done = next(item for item in events if item["event"] == "done")
                assert not done["ok"] and not done["commit_required"]
                assert main._stream_turns[turn_id]["status"] != "ready"
            else:
                assert not any(item["event"] == "done" for item in events)
                assert main._stream_turns[turn_id]["status"] == "cancelled"
        finally:
            release.set()
            with main._stream_turn_lock:
                main._stream_turns.pop(turn_id, None)
