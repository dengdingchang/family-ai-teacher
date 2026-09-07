"""Preserve a specific request to repeat unclear speech, without guessing ASR."""
from types import SimpleNamespace

import pytest

import app.main as main
from test_story_chess_routing import runtime, spoken_turn, complete


@pytest.mark.parametrize("entry", ["stream", "json"])
@pytest.mark.parametrize("transcript,clarification", [
    ("溜啊", "你刚才想说哪个数字，能再说一遍吗？"),
    ("做啦", "刚才“做啦”是什么意思，能换个说法吗？"),
    ("Lil", "我没听清刚才的词，可以再说一次吗？"),
])
def test_specific_clarification_survives_real_response_entry(runtime, entry, transcript, clarification):
    runtime.model.text = clarification
    def chat(messages, max_tokens):
        runtime.model.calls.append((messages, max_tokens))
        return SimpleNamespace(text=clarification, elapsed_s=.001)
    runtime.model.chat = chat
    if entry == "stream":
        turn_id, done = spoken_turn(runtime, transcript)
    else:
        response = runtime.client.post("/api/conversation/text", json={"text": transcript})
        assert response.status_code == 200
        done = response.json()
        turn_id = done["turn_id"]
        runtime.turn_ids.append(turn_id)
    assert done["assistant_text"] == clarification
    assert "".join(runtime.voice) == clarification
    assert runtime.model.calls[-1][0][-1]["content"] == transcript
    assert runtime.store.get_history() == []
    complete(runtime, turn_id)
    assert runtime.store.get_history()[0]["user_text"] == transcript
    assert runtime.store.get_history()[0]["assistant_text"] == clarification


def test_cancelled_clarification_never_becomes_a_completed_family_turn(runtime):
    runtime.model.text = "刚才的词没听清，可以再说一遍吗？"
    turn_id, done = spoken_turn(runtime, "Lil")
    assert done["assistant_text"] == runtime.model.text
    assert runtime.client.post(f"/api/conversation/turns/{turn_id}/cancel").status_code == 200
    assert runtime.client.post(f"/api/conversation/turns/{turn_id}/complete").status_code >= 400
    assert runtime.store.get_history() == []
    assert runtime.store.get_recent_learning_events(limit=None) == []


@pytest.mark.parametrize("reply", ["好。", "真棒！", "你想学什么？", "你愿意跟我说一次 Apple 吗？",
                                  "你刚才做得真棒，跟我再说一次 Apple 吗？",
                                  "刚才五加一等于几，你愿意再说一次吗？"])
def test_generic_acknowledgements_and_unspecific_questions_still_use_the_guard(reply):
    assert main._ensure_guided_reply("Lil", reply, {"name": ""}) != reply


def test_numeric_answers_and_explicit_activity_switch_keep_existing_receipt_rules(runtime):
    runtime.store.update_child_profile({"enabled_activities": ["drawing", "story", "game"]})
    runtime.store.apply_activity_transition({"action": "set", "activity": "numbers", "topic": "数数游戏", "step": 2})
    turn_id, wrong = spoken_turn(runtime, "四")
    assert wrong["activity_transition"]["step"] == 2
    assert "三根" in wrong["assistant_text"]
    complete(runtime, turn_id)
    turn_id, right = spoken_turn(runtime, "三")
    assert right["activity_transition"] == {"action": "clear"}
    assert "答对" in right["assistant_text"]
    complete(runtime, turn_id)
    runtime.store.apply_activity_transition({"action": "set", "activity": "numbers", "topic": "数数游戏", "step": 2})
    turn_id, switched = spoken_turn(runtime, "我不想学这个了，我想画飞机")
    assert switched["activity_transition"]["activity"] == "drawing"
    assert runtime.store.get_activity_state()["activity"] == "numbers"
    complete(runtime, turn_id)
    assert runtime.store.get_activity_state()["activity"] == "drawing"
    assert runtime.model.calls == []
