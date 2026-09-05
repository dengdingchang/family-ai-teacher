from memory.store import MemoryStore


def make_store(root):
    return MemoryStore(root / "data", root / "profile.json", root / "history.jsonl",
                       root / "events.jsonl", root / "missing.json")


def test_profile_interest_wins_and_candidate_is_not_confirmed_theme(tmp_path):
    store = make_store(tmp_path)
    store.add_memory("喜欢恐龙", category="interest", tags=["恐龙"])
    assert store.next_activity()["theme"] == "身边的东西"
    store.add_memory("喜欢飞机", category="interest", status="durable", tags=["飞机"])
    assert store.next_activity()["theme"] == "飞机"
    store.update_child_profile({"interests": ["太空"]})
    assert store.next_activity()["theme"] == "太空"


def test_corrected_summary_does_not_reuse_old_interest_tags(tmp_path):
    store = make_store(tmp_path)
    item = store.add_memory("喜欢恐龙", category="interest", status="durable", tags=["恐龙"])
    assert store.update_memory(item["id"], {"summary": "喜欢恐龙"})["tags"] == ["恐龙"]
    corrected = store.update_memory(item["id"], {"summary": "之前听错了，不喜欢恐龙"})
    assert corrected["summary"] == "之前听错了，不喜欢恐龙"
    assert corrected["tags"] == []
    assert store.next_activity()["theme"] == "身边的东西"
    assert store.get_continuity_cue()["kind"] == "none"
    store.update_memory(item["id"], {"summary": "喜欢太空", "tags": ["太空"]})
    assert store.next_activity()["theme"] == "太空"


def test_disabled_drawing_is_not_recommended_even_if_only_active_skill(tmp_path):
    store = make_store(tmp_path)
    store.update_skill("creativity.drawing", {"status": "practicing"})
    store.update_child_profile({"enabled_activities": []})
    suggestion = store.next_activity()
    assert suggestion["skill_id"] != "creativity.drawing"
    assert "画" not in suggestion["suggestion"]
    assert "小游戏" not in suggestion["suggestion"]
