"""Speaker thread: speech jobs in, audio events out.

Each queued sentence is synthesized with the configured TTS adapter and sent
as one ``audio`` event per chunk. This module also owns the latency aids
around that work -- a short acknowledgement that covers silence, and avatar
mouth cues that wait for real playback -- and closes the turn with ``done``.
"""

from __future__ import annotations

import time
from typing import Any, Iterator

from tts.adapter import TTSAdapterError

from .. import deps
from ..stream_turns import _park_avatar_cue, _stage_stream_turn
from .state import StreamTurn


def acknowledge_if_slow(turn: StreamTurn) -> None:
    """Queue a short acknowledgement if no speech is ready after a moment."""

    if turn.audio_streaming and callable(getattr(deps.tts, "synthesize_stream", None)):
        # A cached 1-2 second filler would occupy the audio timeline while
        # the first real PCM chunks are already ready to play.
        return
    if turn.stop_event.wait(deps.REMOTE_ACK_DELAY_S):
        return
    with turn.lock:
        if turn.response_job_queued or turn.audio_count or turn.acknowledgement_emitted:
            return
        turn.speech_jobs.put({"kind": "acknowledgement", "text": deps.ACKNOWLEDGEMENT_TEXT})


def speak_response(turn: StreamTurn) -> None:
    vocative = f"{turn.nickname}，" if turn.nickname else ""
    while True:
        job = turn.speech_jobs.get()
        kind = job.get("kind")
        if kind == "cancel" or turn.stopped:
            return
        if kind == "finish":
            _finish_turn(turn)
            return
        if turn.tts_error is not None:
            continue  # Drain the remaining jobs; ``done`` reports the failure.
        try:
            spoken_text = str(job.get("text", ""))
            if kind == "acknowledgement":
                if turn.audio_count == 0 and not turn.acknowledgement_emitted:
                    if not _synthesize_and_emit(turn, spoken_text, vocative, acknowledgement=True):
                        return
                continue
            if _cached_acknowledgement_first(turn, spoken_text, vocative):
                if not _synthesize_and_emit(turn, deps.ACKNOWLEDGEMENT_TEXT, vocative, acknowledgement=True):
                    return
            if not _synthesize_and_emit(turn, spoken_text, vocative):
                return
        except Exception as exc:
            if turn.stopped:
                return
            turn.tts_error = str(exc)
            turn.emit({"event": "error", "message": str(exc)[:280] or "TTS failed"})


def _cached_acknowledgement_first(turn: StreamTurn, spoken_text: str, vocative: str) -> bool:
    """A cached acknowledgement covers the wait for an uncached first sentence."""

    acknowledgement = deps.ACKNOWLEDGEMENT_TEXT
    cache_check = getattr(deps.tts, "is_cached", None)
    return (
        turn.audio_count == 0
        and not turn.acknowledgement_emitted
        and spoken_text != acknowledgement
        and spoken_text != vocative
        and callable(cache_check)
        and deps.settings.tts_mode != "streaming"
        and not cache_check(spoken_text)
        and cache_check(acknowledgement)
    )


def _synthesis_results(turn: StreamTurn, spoken_text: str) -> tuple[Iterator[Any], bool]:
    """Start synthesis, returning its results and whether they are PCM stream chunks."""

    tts = deps.tts
    avatar_flush = not turn.avatar_started
    stream_voice = getattr(tts, "synthesize_stream", None)
    if turn.audio_streaming and callable(stream_voice):
        return stream_voice(spoken_text, cancel_event=turn.stop_event,
                            avatar_flush=avatar_flush, defer_avatar=True), True
    cancellable = getattr(tts, "synthesize_cancellable", None)
    if callable(cancellable):
        result = cancellable(spoken_text, cancel_event=turn.stop_event,
                             avatar_flush=avatar_flush, defer_avatar=True)
    else:
        result = tts.synthesize(spoken_text, avatar_flush=avatar_flush, defer_avatar=True)
    return iter((result,)), False


def _synthesize_and_emit(turn: StreamTurn, spoken_text: str, vocative: str, *,
                         acknowledgement: bool = False) -> bool:
    """Speak one job. Returns False when the turn stopped and the speaker should exit."""

    tts = deps.tts
    synthesis_started = time.perf_counter()
    results, use_stream = _synthesis_results(turn, spoken_text)
    semantic = not acknowledgement and spoken_text != vocative
    emitted = 0
    try:
        for result in results:
            start_avatar = not turn.avatar_started
            synthesis_elapsed = time.perf_counter() - synthesis_started
            if turn.stopped:
                discard_avatar = getattr(tts, "discard_avatar", None)
                if discard_avatar is not None:
                    discard_avatar(result)
                return False
            cue_avatar = getattr(tts, "cue_avatar", None)
            pending_cue = bool(not use_stream and turn.playback_cues and getattr(result, "avatar_cue_id", ""))
            # Streaming clients feed PCM to the avatar once, as chunks arrive.
            # Never also cue the same audio on the server.
            if not use_stream and cue_avatar is not None and not pending_cue:
                result = cue_avatar(result, avatar_flush=start_avatar)
            if turn.stopped:
                return False
            turn.audio_count += 1
            emitted += 1
            if acknowledgement:
                turn.acknowledgement_emitted = True
            serialized = deps._tts_payload(result)
            if result.avatar_cued or serialized.get("avatar_pcm_base64"):
                turn.avatar_started = True
            payload = {
                "event": "audio",
                "semantic": semantic,
                "sequence": turn.audio_count,
                "tts_started_s": round(synthesis_started - turn.started, 3),
                "tts_call_s": round(synthesis_elapsed, 3),
                **serialized,
            }
            if use_stream:
                payload["audio_stream"] = True
            if pending_cue:
                # The browser starts the mouth cue when this audio really plays.
                if not _park_avatar_cue(turn.turn_id, turn.audio_count, (result, start_avatar), turn.stop_event):
                    tts.discard_avatar(result)
                    return False
                payload["avatar_pending"] = True
                payload["turn_id"] = turn.turn_id
                turn.avatar_started = True
            if acknowledgement:
                payload["acknowledgement"] = True
            turn.emit(payload)
        if not emitted:
            raise TTSAdapterError("Speech generation returned no audio")
        return True
    finally:
        close = getattr(results, "close", None)
        if close is not None:
            close()


def _finish_turn(turn: StreamTurn) -> None:
    """Stage the playback receipt, then report the finished turn."""

    assistant_text = str(turn.assistant_text).strip()
    turn_staged = False
    if turn.tts_error is None and assistant_text and not turn.drawing_observation:
        turn_staged = _stage_stream_turn(
            turn.turn_id,
            turn.clean_text,
            assistant_text,
            turn.parent_message_id,
            turn.activity_transition,
        )
        if not turn_staged:
            return  # Cancelled meanwhile; the relay is already stopping.
    turn.emit(
        {
            "event": "done",
            "ok": turn.tts_error is None and bool(assistant_text),
            "user_text": "" if turn.drawing_observation else turn.clean_text,
            "assistant_text": assistant_text,
            # History is written by the playback receipt, never by the stream.
            "history": None,
            "turn_id": turn.turn_id,
            "commit_required": turn_staged,
            "activity_transition": None if turn.drawing_observation else turn.activity_transition,
            "audio_count": turn.audio_count,
            "stt_elapsed_s": getattr(turn.stt_result, "elapsed_s", None),
            "llm_elapsed_s": turn.llm_elapsed_s,
            "total_elapsed_s": round(time.perf_counter() - turn.started, 3),
        }
    )
    turn.emit({"event": "end"})
