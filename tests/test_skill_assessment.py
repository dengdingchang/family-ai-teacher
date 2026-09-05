"""Conversation exposure is not demonstrated mastery or a parent assessment."""

from memory.store import MemoryStore


def store_at(root):
    return MemoryStore(root / "data", root / "profile.json", root / "history.jsonl",
                       root / "events.jsonl", root / "missing-template.json")


def test_repeated_topic_and_self_report_do_not_award_mastery(tmp_path):
    store = store_at(tmp_path)
    skill = store.get_skill_graph()["skills"][0]
    keyword = skill["keywords"][0]
    for _ in range(12):
        store.update_learning_state(f"我会{keyword}了", "我们再试一次")
    actual = next(item for item in store.get_skill_graph()["skills"] if item["id"] == skill["id"])
    assert actual["practice_count"] == 12
    assert actual["mastery_score"] == 0
    assert actual["evidence_count"] == 0
    assert actual["last_evidence"] == ""


def test_parent_mastery_and_evidence_survive_following_chat(tmp_path):
    store = store_at(tmp_path)
    skill = store.get_skill_graph()["skills"][0]
    expected = store.update_skill(skill["id"], {
        "status": "mastered", "mastery_score": 1.0,
        "last_evidence": "家长观察到独立完成三次",
    })
    store.update_learning_state(f"我会{skill['keywords'][0]}了", "再玩一次吧")
    actual = next(item for item in store.get_skill_graph()["skills"] if item["id"] == skill["id"])
    for field in ("status", "mastery_score", "last_evidence", "evidence_count"):
        assert actual[field] == expected[field]
    assert actual["parent_reviewed_at"]


def test_parent_reset_to_not_started_is_not_overridden_by_exposure(tmp_path):
    store = store_at(tmp_path)
    skill = store.get_skill_graph()["skills"][0]
    store.update_skill(skill["id"], {"status": "not_started"})
    store.update_learning_state(skill["keywords"][0], "我们看看")
    reloaded = store_at(tmp_path).get_skill_graph()["skills"]
    actual = next(item for item in reloaded if item["id"] == skill["id"])
    assert actual["status"] == "not_started"
    assert actual["practice_count"] == 1
