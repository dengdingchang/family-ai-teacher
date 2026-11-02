"""In-memory registry for in-flight streaming conversation turns.

Each browser turn registers a stop event so the client can cancel a reply, and
stages playback cues (avatar frames, early speech) ahead of the audio that
consumes them. The registry is process-local and pruned by TTL.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from typing import Any

from fastapi import HTTPException, Request


_STREAM_TURN_TTL_S = 15 * 60


_stream_turn_lock = threading.Lock()


_stream_turns: dict[str, dict[str, Any]] = {}


def _validate_stream_turn_id(turn_id: str) -> str:
    turn_id = turn_id.strip()
    if turn_id and not re.fullmatch(r"[A-Za-z0-9_-]{12,80}", turn_id):
        raise HTTPException(status_code=400, detail="invalid conversation turn id")
    return turn_id


def _stream_turn_id(request: Request) -> str:
    """Every client gets a receipt id, including legacy clients with no header."""

    return _validate_stream_turn_id(request.headers.get("x-conversation-turn-id", "")) or uuid.uuid4().hex


def _prune_stream_turns(now: float) -> None:
    expired = [
        turn_id
        for turn_id, turn in _stream_turns.items()
        if now - float(turn.get("updated_at", now)) > _STREAM_TURN_TTL_S
    ]
    for turn_id in expired:
        turn = _stream_turns.pop(turn_id, None)
        stop_event = turn.get("stop_event") if turn else None
        if isinstance(stop_event, threading.Event):
            stop_event.set()


def _register_stream_turn(turn_id: str, stop_event: threading.Event) -> None:
    if not turn_id:
        return
    now = time.monotonic()
    with _stream_turn_lock:
        _prune_stream_turns(now)
        previous = _stream_turns.get(turn_id)
        previous_stop = previous.get("stop_event") if previous else None
        if isinstance(previous_stop, threading.Event):
            previous_stop.set()
        _stream_turns[turn_id] = {
            "status": "active",
            "stop_event": stop_event,
            "updated_at": now,
        }


def _stage_stream_turn(
    turn_id: str,
    user_text: str,
    assistant_text: str,
    parent_message_id: str = "",
    activity_transition: dict[str, Any] | None = None,
) -> bool:
    """Hold text in RAM until the browser confirms playback completed."""

    if not turn_id:
        return False
    with _stream_turn_lock:
        turn = _stream_turns.get(turn_id)
        if turn is None or turn.get("status") != "active":
            return False
        stop_event = turn.get("stop_event")
        if isinstance(stop_event, threading.Event) and stop_event.is_set():
            turn["status"] = "cancelled"
            turn["updated_at"] = time.monotonic()
            return False
        turn.update(
            {
                "status": "ready",
                "user_text": user_text,
                "assistant_text": assistant_text,
                "parent_message_id": parent_message_id,
                "activity_transition": activity_transition,
                "updated_at": time.monotonic(),
            }
        )
        return True


def _cancel_stream_turn(turn_id: str) -> bool:
    with _stream_turn_lock:
        turn = _stream_turns.get(turn_id)
        if turn is None:
            return False
        if turn.get("status") == "completed":
            return False
        stop_event = turn.get("stop_event")
        if isinstance(stop_event, threading.Event):
            stop_event.set()
        turn["status"] = "cancelled"
        turn.pop("user_text", None)
        turn.pop("assistant_text", None)
        turn.pop("parent_message_id", None)
        turn.pop("activity_transition", None)
        turn.pop("avatar_cues", None)
        turn["updated_at"] = time.monotonic()
        return True


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
