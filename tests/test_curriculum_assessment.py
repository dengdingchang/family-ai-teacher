from unittest.mock import patch

import app.main as main
from memory.store import MemoryStore


def make_store(root):
    return MemoryStore(root / "data", root / "profile.json", root / "history.jsonl",
                       root / "events.jsonl", root / "missing.json")


def test_recommendation_does_not_choose_mastered_skill_while_others_remain(tmp_path):
    store = make_store(tmp_path)
    store.update_skill("math.count_1_10", {"status": "mastered"})
    assert store.next_activity()["skill_id"] != "math.count_1_10"
    for skill in store.get_skill_graph()["skills"]:
        store.update_skill(skill["id"], {"status": "mastered"})
    assert "复习" in store.next_activity()["suggestion"]


def test_parent_assessment_changes_actual_number_lesson_and_continues(tmp_path):
    store = make_store(tmp_path)
    profile = {"name": "宝贝", "age": 4}
    with patch.object(main, "memory", store):
        _, initial = main._activity_turn_reply("我想学数字", profile)
        assert initial["step"] == 1
        store.update_skill("math.count_1_10", {"status": "mastered"})
        reply, transition = main._activity_turn_reply("我想学数字", profile)
        assert "十三后面" in reply
        assert transition["step"] == 4
        assert store.get_activity_state()["status"] == "idle"
        store.apply_activity_transition(transition)
        _, wrong = main._activity_turn_reply("不是十四", profile)
        assert wrong["step"] == 4
        for answer, expected_step in [("十四", 5), ("18", 6)]:
            _, transition = main._activity_turn_reply(answer, profile)
            assert transition["step"] == expected_step
            store.apply_activity_transition(transition)
        reply, transition = main._activity_turn_reply("二十", profile)
        assert transition["action"] == "clear"
        assert "掌握" not in reply
        skill = next(s for s in store.get_skill_graph()["skills"] if s["id"] == "math.count_11_20")
        assert skill["status"] == "not_started"
        store.update_skill("math.count_11_20", {"status": "mastered"})
        _, transition = main._activity_turn_reply("我想学数字", profile)
        assert transition["step"] == 3
        _, transition = main._activity_turn_reply("我想学数字，从一开始", profile)
        assert transition["step"] == 1
