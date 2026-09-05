"""Weekly companionship wishes are sourced only from committed synthetic history."""

from datetime import datetime, timedelta

import pytest

from memory.store import MemoryStore


@pytest.fixture
def store(tmp_path):
    data = tmp_path / "data"
    return MemoryStore(data, data / "profile.json", data / "history.jsonl",
                       data / "events.jsonl", tmp_path / "missing.json")


def committed(store, text, *, minute=0, **fields):
    stamp = datetime(2026, 9, 1, 10, tzinfo=datetime.now().astimezone().tzinfo) + timedelta(minutes=minute)
    record = {"created_at": stamp.isoformat(), "user_text": text,
              "assistant_text": "可以把这个想法告诉家人。", **fields}
    store._append_jsonl(store.history_path, record)
    return record


def requests(store, week="2026-W36"):
    journal = next(item for item in store.get_growth_journal() if item["week"] == week)
    return journal.get("companionship_requests", [])


@pytest.mark.parametrize("texts,expected", [
    (["我想和爸爸一起搭积木。", "我还想跟爸爸一起搭积木！", "希望和爸爸一起搭积木。"], 1),
    (["我想和爸爸一起搭积木。", "我还想跟爸爸一起搭积木。"], 0),
    (["我不想和爸爸一起搭积木。", "我想和爸爸一起搭积木吗？", "小明说我想和爸爸一起搭积木。"], 0),
])
def test_three_clear_requests_are_needed(store, texts, expected):
    for minute, text in enumerate(texts):
        committed(store, text, minute=minute)
    result = requests(store)
    assert len(result) == expected
    if expected:
        assert result[0]["family_member"] == "爸爸"
        assert result[0]["activity"] == "搭积木"
        assert result[0]["count"] == 3
        assert [item["text"] for item in result[0]["examples"]] == texts


@pytest.mark.parametrize("text,activity", [
    ("我想和爸爸一起玩", "玩"),
    ("我想和爸爸一起", None),
])
def test_single_character_activity_is_allowed_but_activity_is_required(store, text, activity):
    for minute in range(3):
        committed(store, text, minute=minute)
    result = requests(store)
    if activity is None:
        assert result == []
    else:
        assert len(result) == 1
        assert result[0]["family_member"] == "爸爸"
        assert result[0]["activity"] == activity
        assert result[0]["count"] == 3


def test_parent_and_activity_groups_do_not_mix(store):
    for minute in range(3):
        committed(store, "我想和爸爸一起搭积木。", minute=minute)
        committed(store, "我想跟妈妈一起画画。", minute=minute + 10)
    for minute in range(2):
        committed(store, "我想和爸爸一起画画。", minute=minute + 20)
        committed(store, "我想和妈妈一起搭积木。", minute=minute + 30)
    result = requests(store)
    assert [(item["family_member"], item["activity"], item["count"]) for item in result] == [
        ("妈妈", "画画", 3), ("爸爸", "搭积木", 3),
    ]


def test_recent_three_examples_keep_original_text_and_time_sorted(store):
    records = [
        committed(store, "爸爸老师，我想和爸爸一起搭积木。", minute=4),
        committed(store, "我希望跟爸爸一起搭积木！", minute=1),
        committed(store, "还想和爸爸一起搭积木。", minute=3),
        committed(store, "我想和爸爸一起搭积木。", minute=2),
    ]
    result = requests(store)[0]
    assert result["count"] == 4
    assert result["examples"] == [{"text": records[index]["user_text"],
                                    "created_at": records[index]["created_at"]} for index in (3, 2, 0)]
    assert set(result) == {"family_member", "activity", "count", "examples"}


def test_negation_questions_quotations_and_ai_companions_are_excluded(store):
    excluded = [
        "我不想和爸爸一起搭积木。", "我想和爸爸一起搭积木，但现在不想了。",
        "我想和爸爸一起搭积木吗", "我想和爸爸一起搭积木？", "我想和爸爸一起搭积木还是画画？",
        "小明说我想和爸爸一起搭积木。", "我说小明想和爸爸一起搭积木。",
        "“我想和爸爸一起搭积木”是小明说的。", "我想和爸爸一起搭积木这句话是小明说的。",
        "我想和爸爸一起画画的愿望已经实现了。", "我希望和妈妈一起看书的小明今天开心。",
        "我想和爸爸一起画画只是举个例子。", "我想和爸爸老师一起搭积木。",
        "爸爸老师，我想和爸爸老师一起搭积木。", "如果我想和妈妈一起画画呢？",
    ]
    for index, text in enumerate(excluded):
        for repeat in range(3):
            committed(store, text, minute=index * 3 + repeat)
    assert requests(store) == []


def test_duplicate_records_cannot_reach_threshold(store):
    first = committed(store, "我想和爸爸一起搭积木。", id="same-receipt")
    second = committed(store, "我想和爸爸一起搭积木。", minute=1)
    store._append_jsonl(store.history_path, first)
    store._append_jsonl(store.history_path, {**first, "assistant_text": "重复导入的回执"})
    store._append_jsonl(store.history_path, second)
    assert requests(store) == []
    committed(store, "我想和爸爸一起搭积木。", minute=2)
    assert requests(store)[0]["count"] == 3


def test_local_week_boundaries_stay_separate(store):
    sunday = datetime(2026, 9, 6, 23, 58, tzinfo=datetime.now().astimezone().tzinfo)
    for minutes in (0, 1, 2):
        committed(store, "我想和爸爸一起搭积木。", created_at=(sunday + timedelta(minutes=minutes)).isoformat())
    assert requests(store, "2026-W36") == []
    assert requests(store, "2026-W37") == []
    for minutes in (3, 4):
        committed(store, "我想和爸爸一起搭积木。", created_at=(sunday + timedelta(minutes=minutes)).isoformat())
    assert requests(store, "2026-W36") == []
    assert requests(store, "2026-W37")[0]["count"] == 3


def test_assistant_words_and_uncommitted_event_text_are_not_child_requests(store):
    for minute in range(3):
        committed(store, "我画好了。", minute=minute, assistant_text="我想和爸爸一起搭积木。")
        store.save_learning_event("pending_turn", {"user_text": "我想和爸爸一起搭积木。"})
    assert requests(store) == []


def test_summary_reload_is_read_only_and_keeps_parent_connection_semantics(store):
    store.update_child_profile({"name": "临时测试孩子"})
    parent_message = store.add_parent_message("今天爸爸很想你。")
    store.mark_parent_message_delivered(parent_message["id"], "爸爸今天很想你。")
    for minute in range(3):
        committed(store, "我想和爸爸一起搭积木。", minute=minute)
    before = {path.name: path.read_bytes() for path in store.data_dir.iterdir() if path.is_file()}
    first = store.get_growth_journal()
    reloaded = MemoryStore(store.data_dir, store.profile_path, store.history_path,
                           store.learning_events_path, store.template_path)
    assert reloaded.get_growth_journal() == first
    assert all("companionship_requests" in week for week in first)
    assert any("今天爸爸很想你。" in week["parent_connections"] for week in first)
    assert before == {path.name: path.read_bytes() for path in store.data_dir.iterdir() if path.is_file()}
    assert not store.memories_path.exists() and not store.skills_path.exists()
