"""Server-sent event stream for one conversation turn.

:func:`stream_conversation` is the entry point the conversation routes use.
It builds the turn's shared state, starts the producer and speaker threads and
relays their events. When the browser leaves early it stops both workers,
cancels the playback receipt and silences the avatar.
"""

from __future__ import annotations

import asyncio
import queue
import threading
import time
import uuid
from typing import Any, AsyncIterator

from .. import deps
from ..activity_flow import _activity_vision_description
from ..stream_turns import _cancel_stream_turn, _register_stream_turn, _sse
from .model_reply import produce_reply
from .speech import speak_response
from .state import StreamTurn


async def stream_conversation(
    clean_text: str,
    stt_result: Any | None = None,
    vision_context: str = "",
    turn_id: str = "",
    playback_cues: bool = False,
    audio_streaming: bool = False,
    visual_source: str = "camera",
    drawing_observation: bool = False,
    activity_reply: tuple[str, dict[str, Any] | None] | None = None,
    chess_context: str = "",
) -> AsyncIterator[str]:
    """Stream text and, when negotiated, PCM chunks from the persistent voice."""

    turn_id = turn_id or uuid.uuid4().hex
    profile = deps._current_profile()
    # A parent's pending message waits for an ordinary child turn: seeing,
    # drawing and button-driven activity turns never deliver it.
    delivers_parent_message = not vision_context and not drawing_observation and not activity_reply
    turn = StreamTurn(
        turn_id=turn_id,
        clean_text=clean_text,
        profile=profile,
        parent_message=deps._pending_parent_message() if delivers_parent_message else None,
        stt_result=stt_result,
        vision_context=vision_context,
        visual_source=visual_source,
        drawing_observation=drawing_observation,
        activity_reply=activity_reply,
        chess_context=chess_context,
        playback_cues=playback_cues,
        audio_streaming=audio_streaming,
    )
    _register_stream_turn(turn_id, turn.stop_event)
    turn.started = time.perf_counter()
    if not drawing_observation:
        turn.emit({"event": "user_text", "text": clean_text, "turn_id": turn_id})
    if vision_context:
        turn.emit({"event": "vision_context", "description": _activity_vision_description(vision_context)})

    threading.Thread(target=speak_response, args=(turn,), name="family-tts-stream", daemon=True).start()
    threading.Thread(target=produce_reply, args=(turn,), name="family-llm-stream", daemon=True).start()
    completed_normally = False
    try:
        while not turn.stopped:
            try:
                payload = await asyncio.to_thread(turn.events.get, True, 0.2)
            except queue.Empty:
                # Cancelling the asyncio wait cannot cancel a blocking Queue
                # get in its worker thread. Bound that wait so repeated
                # interruptions do not exhaust the shared thread pool.
                continue
            if payload.get("event") == "end":
                completed_normally = True
                break
            yield _sse(payload)
    finally:
        if not completed_normally:
            await _abandon_turn(turn)


async def _abandon_turn(turn: StreamTurn) -> None:
    turn.stop_event.set()
    _cancel_stream_turn(turn.turn_id)
    turn.cancel_speech()
    close = getattr(turn.response_stream, "close", None)
    if close is not None:
        try:
            close()
        except Exception:
            pass
    flush_avatar = getattr(deps.tts, "flush_avatar", None)
    if flush_avatar is not None:
        await asyncio.to_thread(flush_avatar)
