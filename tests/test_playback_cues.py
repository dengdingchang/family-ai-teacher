"""Playback-owned avatar cues must not run ahead or survive cancellation."""

import asyncio
import json
import threading
from dataclasses import replace
from unittest.mock import patch

import app.main as main
from audio.metrics import unavailable_gpu_measurement
from tts.adapter import TTSResult


def test_stream_defers_cues_until_player_and_rejects_replay_or_cancel():
    class Tts:
        def __init__(self):
            self.cues = []
            self.syntheses = 0

        def synthesize(self, text, **kwargs):
            assert kwargs["defer_avatar"]
            self.syntheses += 1
            return TTSResult(b"audio", 1.0, 0.1, unavailable_gpu_measurement(),
                             backend="self-host", audio_mime="audio/webm",
                             avatar_cue_id=f"cue-{self.syntheses:016d}")

        def cue_avatar(self, result, *, avatar_flush):
            self.cues.append((result.avatar_cue_id, avatar_flush))
            return replace(result, avatar_cued=True, avatar_cue_id="")

    async def run():
        events = []
        async for chunk in main._stream_conversation("我想学英语", turn_id=turn_id, playback_cues=True):
            events.extend(json.loads(line[6:]) for line in chunk.splitlines() if line.startswith("data: "))
        return events

    turn_id = "test-playback-cue-0001"
    tts = Tts()
    with patch.object(main, "tts", tts), \
         patch.object(main, "_capture_parent_response"), \
         patch.object(main, "_pending_parent_message", return_value=None), \
         patch.object(main, "_current_profile", return_value={"name": "宝贝"}), \
         patch.object(main, "_activity_turn_reply", return_value=("先说你好。你想试一试吗？", None)):
        try:
            events = asyncio.run(run())
            audios = [event for event in events if event["event"] == "audio"]
            assert len(audios) == 2
            assert all(event["avatar_pending"] and not event["avatar_cued"] for event in audios)
            assert not tts.cues  # synthesis alone never starts motion
            assert asyncio.run(main.cue_streaming_avatar(turn_id, 1))["cued"]
            assert len(tts.cues) == 1
            assert tts.cues[0][1] is True
            assert not asyncio.run(main.cue_streaming_avatar(turn_id, 1))["cued"]
            main._cancel_stream_turn(turn_id)
            assert not asyncio.run(main.cue_streaming_avatar(turn_id, 2))["cued"]
            assert len(tts.cues) == 1
        finally:
            with main._stream_turn_lock:
                main._stream_turns.pop(turn_id, None)


def test_cancellation_during_cue_flushes_late_motion():
    turn_id = "test-playback-cue-cancel"
    stop = threading.Event()
    result = TTSResult(b"audio", 1, 0.1, unavailable_gpu_measurement())
    main._register_stream_turn(turn_id, stop)
    main._stream_turns[turn_id]["avatar_cues"] = {1: (result, True)}
    try:
        with patch.object(main, "tts") as tts:
            def cue(*args, **kwargs):
                main._cancel_stream_turn(turn_id)
                return replace(result, avatar_cued=True)
            tts.cue_avatar.side_effect = cue
            assert not asyncio.run(main.cue_streaming_avatar(turn_id, 1))["cued"]
            tts.flush_avatar.assert_called_once()
    finally:
        with main._stream_turn_lock:
            main._stream_turns.pop(turn_id, None)
