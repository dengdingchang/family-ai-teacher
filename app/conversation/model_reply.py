"""Producer thread: decide the reply text and queue it for speech.

A deterministic reply from :mod:`.local_reply` is used as-is. Otherwise the
language model streams; deltas go to the browser as they arrive, and the first
complete sentence goes to the speaker early so the child hears the voice
before the model finishes. A model failure still ends in a child-safe reply.
"""

from __future__ import annotations

import logging
import threading
import time

from llm.client import LLMError

from .. import deps
from ..activity_flow import (
    _activity_vision_description,
    _ensure_guided_reply,
    _guided_question,
    _offline_safe_reply,
    _teaching_turn_complete,
)
from ..repetition import RepeatedQuestionGuard
from ..story import clean_narration, narration_messages
from ..text_utils import _compact_assistant_text, _early_spoken_chunk
from .local_reply import CHESS_RETRY_HINT, ReplyPlan, plan_reply
from .speech import acknowledge_if_slow
from .state import StreamTurn


logger = logging.getLogger(__name__)


def produce_reply(turn: StreamTurn) -> None:
    llm_started = time.perf_counter()
    plan = ReplyPlan(chess_context=turn.chess_context)
    buffer = ""
    spoken_prefix = ""
    guard = RepeatedQuestionGuard([])
    response_stream = None
    try:
        plan = plan_reply(turn)
        if plan.text:
            turn.assistant_text = plan.text
            turn.llm_elapsed_s = 0.0
            turn.emit({"event": "assistant_delta", "text": plan.text})
            turn.speak_all(plan.text)
            turn.finish_speech()
            return
        threading.Thread(target=acknowledge_if_slow, args=(turn,), name="family-remote-ack", daemon=True).start()
        messages = deps._messages_for(turn.clean_text, _activity_vision_description(turn.vision_context),
                                      plan.chess_context)
        if plan.story_fallback:
            messages = narration_messages(messages, plan.story_fallback, turn.activity_transition)
        elif not plan.chess_context:
            guard = RepeatedQuestionGuard(messages)
        response_stream = deps.llm.stream_chat(messages, max_tokens=180 if plan.story_fallback else 72)
        turn.response_stream = response_stream
        for delta in response_stream:
            if turn.stopped:
                break
            delta_text = str(delta)
            buffer += delta_text
            turn.emit({"event": "assistant_delta", "text": delta_text})
            # Stories and chess explanations are spoken whole; a repeated
            # question is about to be replaced, so none of them speak early.
            if not spoken_prefix and not plan.story_fallback and not plan.chess_context and not guard.repeated:
                spoken_prefix = _early_spoken_chunk(buffer)
                if spoken_prefix:
                    turn.queue_speech(spoken_prefix)
            if not plan.story_fallback and _teaching_turn_complete(buffer):
                break
        if turn.stopped:
            turn.cancel_speech()
            return
        assistant_text = _final_model_text(turn, plan, buffer, guard)
        if not assistant_text:
            raise LLMError("AI Station returned empty assistant text")
        turn.assistant_text = _keep_spoken_prefix(turn, spoken_prefix, assistant_text)
        turn.speak_all(turn.assistant_text[len(spoken_prefix):].strip())
        turn.llm_elapsed_s = round(time.perf_counter() - llm_started, 3)
        turn.finish_speech()
    except Exception as exc:
        turn.llm_elapsed_s = round(time.perf_counter() - llm_started, 3)
        if turn.stopped:
            turn.cancel_speech()
            return
        logger.warning("AI Station stream failed; continuing with local child-safe turn: %s", exc)
        assistant_text = _keep_spoken_prefix(turn, spoken_prefix, _fallback_text(turn, plan, buffer, guard))
        turn.assistant_text = assistant_text
        if not buffer:
            turn.emit({"event": "assistant_delta", "text": assistant_text})
        elif assistant_text.startswith(buffer):
            suffix = assistant_text[len(buffer):]
            if suffix:
                turn.emit({"event": "assistant_delta", "text": suffix})
        turn.speak_all(assistant_text[len(spoken_prefix):].strip())
        turn.finish_speech()
    finally:
        turn.response_stream = None
        close = getattr(response_stream, "close", None) if response_stream is not None else None
        if close is not None:
            close()


def _final_model_text(turn: StreamTurn, plan: ReplyPlan, buffer: str, guard: RepeatedQuestionGuard) -> str:
    if plan.story_fallback:
        return clean_narration(buffer, plan.story_fallback)
    if plan.chess_context:
        return _compact_assistant_text(buffer, max_chars=90)
    return guard.replacement(buffer) or _ensure_guided_reply(turn.clean_text, buffer, turn.profile)


def _fallback_text(turn: StreamTurn, plan: ReplyPlan, buffer: str, guard: RepeatedQuestionGuard) -> str:
    if plan.story_fallback:
        return plan.story_fallback
    if plan.chess_context:
        return CHESS_RETRY_HINT
    if buffer.strip():
        return guard.replacement(buffer) or _ensure_guided_reply(turn.clean_text, buffer, turn.profile)
    return CHESS_RETRY_HINT if turn.chess_context else _offline_safe_reply(turn.clean_text, turn.profile)


def _keep_spoken_prefix(turn: StreamTurn, spoken_prefix: str, text: str) -> str:
    """The early sentence is already playing, so the final text must start with it."""

    if spoken_prefix and not text.startswith(spoken_prefix):
        return _compact_assistant_text(
            f"{spoken_prefix}{_guided_question(f'{turn.clean_text} {spoken_prefix}')}",
        )
    return text
