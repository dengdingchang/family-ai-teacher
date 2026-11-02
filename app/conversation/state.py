"""Shared state of one streaming conversation turn.

A streaming turn runs two worker threads: the producer
(:mod:`.model_reply`) decides the reply text and queues speech jobs, and the
speaker (:mod:`.speech`) turns those jobs into audio events. Both publish
browser events on one queue that :mod:`.pipeline` relays. A
:class:`StreamTurn` is the only object they share.
"""

from __future__ import annotations

import queue
import threading
from dataclasses import dataclass, field
from typing import Any

from ..text_utils import _child_nickname, _spoken_chunks


@dataclass
class StreamTurn:
    # Request inputs, fixed once the turn starts.
    turn_id: str
    clean_text: str
    profile: dict[str, Any]
    parent_message: dict[str, Any] | None = None
    stt_result: Any = None
    vision_context: str = ""
    visual_source: str = "camera"
    drawing_observation: bool = False
    activity_reply: tuple[str, dict[str, Any] | None] | None = None
    chess_context: str = ""
    playback_cues: bool = False
    audio_streaming: bool = False
    started: float = 0.0

    # Channels between the workers and the event relay.
    events: queue.Queue[dict[str, Any]] = field(default_factory=queue.Queue)
    speech_jobs: queue.Queue[dict[str, Any]] = field(default_factory=queue.Queue)
    lock: threading.Lock = field(default_factory=threading.Lock)
    stop_event: threading.Event = field(default_factory=threading.Event)

    # Reply state, written by the producer.
    assistant_text: str = ""
    llm_elapsed_s: float | None = None
    parent_message_id: str = ""
    activity_transition: dict[str, Any] | None = None
    response_stream: Any = None
    response_job_queued: bool = False

    # Voice state, written by the speaker.
    tts_error: str | None = None
    audio_count: int = 0
    avatar_started: bool = False
    acknowledgement_emitted: bool = False

    def __post_init__(self) -> None:
        if self.parent_message:
            self.parent_message_id = str(self.parent_message.get("id", ""))

    @property
    def nickname(self) -> str:
        return _child_nickname(self.profile)

    @property
    def stopped(self) -> bool:
        return self.stop_event.is_set()

    def emit(self, payload: dict[str, Any]) -> None:
        self.events.put(payload)

    def queue_speech(self, text: str) -> None:
        with self.lock:
            self.response_job_queued = True
            self.speech_jobs.put({"kind": "response", "text": text})

    def speak_all(self, text: str) -> None:
        for chunk in _spoken_chunks(text, self.nickname):
            self.queue_speech(chunk)

    def finish_speech(self) -> None:
        self.speech_jobs.put({"kind": "finish"})

    def cancel_speech(self) -> None:
        self.speech_jobs.put({"kind": "cancel"})
