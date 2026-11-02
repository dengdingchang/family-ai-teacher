"""Deterministic replies that answer a streaming turn without the model.

The order follows the child-first product rules: safety, then explicit media
requests, button-driven activity replies, what the camera or drawing board
showed, a parent's invitation, and the activity flow. Only when none of them
applies does the turn reach the language model.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .. import deps
from ..activity_flow import (
    _activity_start_requested,
    _activity_vision_reply,
    _blocked_content_topic,
    _child_priority_reply,
    _content_boundary_alternative,
    _observed_scene_reply,
    _offline_safe_reply,
    _requested_lesson,
    _story_fallback,
)
from .state import StreamTurn


CHESS_OFFLINE_HINT = "刚才这句没能讲清。你可以先点一枚白棋，看看亮起的格子，再点“给我提示”。"
CHESS_RETRY_HINT = "刚才这句没能讲清。先点一枚白棋，看看亮起的格子，也可以点“给我提示”。"
_CHESS_PAUSE = r"休息|累了|困了|不玩了|停下来|停一下"


@dataclass(frozen=True)
class ReplyPlan:
    # A ready local reply; empty means the model answers.
    text: str = ""
    # A local story beat the model should narrate around.
    story_fallback: str = ""
    # Board facts for the model; empty once the turn leaves the board.
    chess_context: str = ""


def model_unavailable(profile: dict[str, Any]) -> bool:
    return profile.get("brain_mode") == "local_lessons_only" or not deps.llm.configured


def plan_reply(turn: StreamTurn) -> ReplyPlan:
    """Pick this turn's reply, recording its activity transition on ``turn``."""

    text, profile = turn.clean_text, turn.profile
    chess_context = turn.chess_context
    if turn.drawing_observation:
        local = _observed_scene_reply(turn.vision_context, profile, visual_source="drawing", drawing_observation=True)
    else:
        local = _child_priority_reply(text)
    if not local and not turn.drawing_observation:
        local, turn.activity_transition = deps._media_request_turn(text, profile)
    if not local and turn.activity_reply and not turn.drawing_observation:
        local, turn.activity_transition = turn.activity_reply
    if not local and turn.vision_context and turn.visual_source == "camera":
        local, turn.activity_transition = _activity_vision_reply(
            turn.vision_context, deps._current_activity_state(), profile,
        )
    if not local and turn.vision_context:
        local = _observed_scene_reply(turn.vision_context, profile, visual_source=turn.visual_source)
    elif not local and not turn.drawing_observation:
        local, turn.activity_transition = deps._parent_activity_acceptance_reply(text, profile)
    if local:
        turn.parent_message_id = ""
    elif turn.parent_message:
        local = deps._parent_message_reply(turn.parent_message, profile)
    if not local:
        turn.parent_message_id = ""
        if not turn.vision_context:
            if turn.chess_context:
                local, chess_context = _chess_turn_reply(turn)
            else:
                local, turn.activity_transition = deps._activity_turn_reply(text, profile)
    if not local and not turn.vision_context and model_unavailable(profile):
        local = CHESS_OFFLINE_HINT if turn.chess_context else _offline_safe_reply(text, profile)
    story_fallback = _story_fallback(local, turn.activity_transition)
    if story_fallback and not model_unavailable(profile):
        local = ""
    return ReplyPlan(text=local, story_fallback=story_fallback, chess_context=chess_context)


def _chess_turn_reply(turn: StreamTurn) -> tuple[str, str]:
    """Only explicit activity controls leave the board.

    Ordinary chess questions never advance an old lesson. Returns the local
    reply and the board facts still meant for the model.
    """

    text, profile = turn.clean_text, turn.profile
    requested = _requested_lesson(text)
    if _blocked_content_topic(text, profile):
        reply, turn.activity_transition = _content_boundary_alternative(profile)
        return reply, ""
    if _activity_start_requested(text, requested) or re.search(_CHESS_PAUSE, text):
        reply, turn.activity_transition = deps._activity_turn_reply(text, profile)
        if reply and turn.activity_transition is None and re.search(_CHESS_PAUSE, text):
            turn.activity_transition = {"action": "clear"}
        return reply, ""
    return "", turn.chess_context
