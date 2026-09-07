"""Interest memories describe the child, never a quoted or hypothetical speaker."""

import pytest

from memory.store import MemoryStore


@pytest.fixture
def store(tmp_path):
    data = tmp_path / "data"
    return MemoryStore(data, data / "profile.json", data / "history.jsonl",
                       data / "events.jsonl", tmp_path / "missing.json")


@pytest.mark.parametrize("text", [
    "妈妈喜欢恐龙。", "你喜欢恐龙吗？", "我喜欢恐龙吗？", "如果我喜欢恐龙，你会开心吗？",
    "妈妈说：我喜欢恐龙。", "妈妈说，我喜欢恐龙。", "“我喜欢恐龙。”", '老师说"我想学恐龙"。',
    "我以前喜欢恐龙。", "我不知道是不是喜欢恐龙。", "我不喜欢恐龙。",
    "如果有时间，我想画恐龙。", "我想知道妈妈喜欢什么恐龙。",
])
def test_other_speakers_questions_negations_and_hypotheses_never_become_child_interest(store, text):
    for _ in range(3):
        store.observe_turn(text, "我们可以聊聊别的。")
    assert not [item for item in store.get_memories() if item["category"] == "interest"]
    assert store.get_continuity_cue()["kind"] == "none"


@pytest.mark.parametrize("text,topic", [
    ("我喜欢恐龙。", "恐龙"), ("爸爸老师，我最近很喜欢太空。", "太空"),
    ("我想学恐龙", "恐龙"), ("我想画飞机", "飞机"),
    ("教我画恐龙", "恐龙"), ("请讲一个恐龙故事", "恐龙"),
    ("我不喜欢恐龙，但是我喜欢太空。", "太空"),
])
def test_explicit_child_preferences_and_requests_can_form_repeated_interest(store, text, topic):
    for count in range(1, 4):
        store.observe_turn(text, "我们慢慢来。")
        item = next(item for item in store.get_memories() if item["tags"] == [topic])
        assert item["occurrences"] == count
        assert item["status"] == ("durable" if count == 3 else "candidate")
    if text.startswith("我不喜欢"):
        assert not any(item["tags"] == ["恐龙"] for item in store.get_memories())


def test_precision_fix_does_not_rewrite_existing_family_memory(store):
    item = store.add_memory("最近对恐龙感兴趣", category="interest", status="durable",
                            tags=["恐龙"], evidence="已有待家长纠正的旧记录")
    before = store.memories_path.read_bytes()
    store.observe_turn("妈妈喜欢恐龙", "我听到了。")
    assert store.memories_path.read_bytes() == before
    assert store.get_memories()[0]["id"] == item["id"]


def test_parent_can_classify_a_saved_memory_as_a_milestone_without_losing_other_categories(store):
    other = [store.add_memory(category + "合成记忆", category=category, status="durable")
             for category in ("parent", "profile", "learning", "interest")]
    item = store.add_memory("今天第一次独立完整数到了二十", category="parent", status="durable")
    assert not store.get_growth_journal()[0]["milestones"]
    updated = store.update_memory(item["id"], {"category": "episodic"})
    assert updated["created_at"] == item["created_at"] and updated["id"] == item["id"]
    assert store.get_growth_journal()[0]["milestones"] == [item["summary"]]
    assert store.get_memories()[:-1] == other
