"""Real response routes must not speak a third identical remote question."""
from types import SimpleNamespace

import pytest

from app.repetition import RepeatedQuestionGuard
from test_story_chess_routing import runtime, spoken_turn, complete


def seed(runtime):
    runtime.store.save_session_turn("溜啊", "溜啊真快！那五加一等于几？")
    runtime.store.save_session_turn("做啦", "你做了！那五加一等于几？")


@pytest.mark.parametrize("entry", ["stream", "json"])
def test_third_question_and_invented_word_meaning_never_reach_voice_or_history(runtime, entry):
    seed(runtime)
    runtime.model.text = "Lil是英文词。那五加一等于几？"
    runtime.model.chat = lambda *args: SimpleNamespace(text=runtime.model.text, elapsed_s=.001)
    if entry == "stream":
        turn_id, done = spoken_turn(runtime, "Lil")
    else:
        response = runtime.client.post("/api/conversation/text", json={"text": "Lil"})
        assert response.status_code == 200
        done = response.json()
        turn_id = done["turn_id"]
        runtime.turn_ids.append(turn_id)
    assert "先放一放" in done["assistant_text"]
    assert "英文词" not in "".join(runtime.voice) and "五加一" not in "".join(runtime.voice)
    assert len(runtime.store.get_history()) == 2
    complete(runtime, turn_id)
    assert runtime.store.get_history()[-1]["user_text"] == "Lil"
    assert runtime.store.get_history()[-1]["assistant_text"] == done["assistant_text"]


def test_correct_answer_followed_by_new_question_is_not_blocked(runtime):
    seed(runtime)
    runtime.model.text = "对，五加一就是六。那七减一等于几？"
    _, done = spoken_turn(runtime, "六")
    assert "就是六" in done["assistant_text"] and "七减一" in done["assistant_text"]


def test_requested_repeat_and_only_one_previous_question_are_not_blocked():
    previous = {"role": "assistant", "content": "五加一等于几？"}
    reply = "再问一次。五加一等于几？"
    assert not RepeatedQuestionGuard([previous, {"role": "user", "content": "Lil"}]).replacement(reply)
    assert not RepeatedQuestionGuard([previous, previous, {"role": "user", "content": "再问我一次"}]).replacement(reply)


def test_cancelled_recovery_does_not_create_a_completed_turn(runtime):
    seed(runtime)
    runtime.model.text = "没听清。五加一等于几？"
    turn_id, done = spoken_turn(runtime, "Lil")
    assert "先放一放" in done["assistant_text"]
    runtime.client.post(f"/api/conversation/turns/{turn_id}/cancel")
    assert runtime.client.post(f"/api/conversation/turns/{turn_id}/complete").status_code >= 400
    assert len(runtime.store.get_history()) == 2
