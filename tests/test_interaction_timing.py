"""Timing receipts use temporary event logs, never real sessions or media."""

import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app.main as main
import memory.interaction as interaction
import memory.store as memory_module
from memory.store import MemoryStore


@pytest.fixture
def timing(tmp_path, monkeypatch):
    clock = SimpleNamespace(now=datetime.now(timezone.utc).replace(microsecond=0))

    class ClockDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.now.astimezone(tz) if tz else clock.now.astimezone().replace(tzinfo=None)

    data = tmp_path / "data"
    store = MemoryStore(data, data / "profile.json", data / "history.jsonl",
                        data / "events.jsonl", tmp_path / "missing.json")
    store.update_child_profile({"name": "计时测试宝贝"})
    monkeypatch.setattr(memory_module, "datetime", ClockDateTime)
    monkeypatch.setattr(main, "memory", store)
    sid = str(uuid.uuid4())

    def payload(start=-15, end=-5, *, session=sid, sequence=1):
        return {"session_id": session, "sequence": sequence,
                "start_at": (clock.now + timedelta(seconds=start)).isoformat(),
                "end_at": (clock.now + timedelta(seconds=end)).isoformat()}

    return SimpleNamespace(store=store, clock=clock, payload=payload, client=TestClient(main.app))


def post(timing, payload=None):
    return timing.client.post("/api/conversation/interaction-interval", json=payload or timing.payload())


def test_elapsed_interval_is_idempotent_with_canonical_timestamps(timing):
    assert post(timing).json() == {"ok": True, "recorded": True}
    repeated = timing.payload()
    repeated["start_at"] = repeated["start_at"].replace("+00:00", "Z")
    assert post(timing, repeated).json() == {"ok": True, "recorded": False}
    assert len(timing.store.get_recent_learning_events(limit=None)) == 1
    today = timing.store.get_parent_dashboard()["today"]
    assert today["interaction_seconds"] == 10
    assert today["interaction_timing_available"] is True
    assert today["conversation_turns"] == 0
    assert not timing.store.get_history()


def test_positive_interval_rounded_to_zero_still_has_available_data(timing):
    assert timing.store.get_today_interaction()["interaction_timing_available"] is False
    assert post(timing, timing.payload(start=-1, end=-0.999999)).json()["recorded"]
    assert timing.store.get_today_interaction() == {
        "interaction_seconds": 0.0, "interaction_timing_available": True,
    }


def test_timing_receipts_do_not_displace_learning_context_or_reach_model(timing):
    timing.store.save_learning_event("practice_attempt", {
        "question": "2 + 1 = ?", "answer": "4", "result": "incorrect",
    })
    timing.store.save_learning_event("vision_observation", {"description": "桌上有一块红色积木。"})
    for sequence in range(1, 16):
        assert post(timing, timing.payload(sequence=sequence)).json()["recorded"]
    context = json.dumps(main._messages_for("我想继续练习"), ensure_ascii=False)
    assert "2 + 1 = ?" in context and "桌上有一块红色积木。" in context
    assert "session_id" not in context and "interaction_interval" not in context
    assert timing.payload()["session_id"] not in context
    assert len(timing.store.get_recent_learning_events(limit=None)) == 17
    assert len(timing.store.export_bundle()["learning_events"]) == 17
    assert timing.store.get_today_interaction()["interaction_seconds"] == 10


def test_same_receipt_with_changed_content_is_a_conflict(timing):
    assert post(timing).status_code == 200
    response = post(timing, timing.payload(start=-14))
    assert response.status_code == 409
    assert len(timing.store.get_recent_learning_events(limit=None)) == 1
    assert timing.store.get_today_interaction()["interaction_seconds"] == 10


@pytest.mark.parametrize("change", [
    {"sequence": 0}, {"sequence": -1}, {"sequence": True}, {"sequence": 1.5},
    {"session_id": "not-a-valid-uuid-not-a-valid-uuid-000"},
    {"start_at": "2026-09-06T12:00:00"}, {"end_at": "NaN"}, {"end_at": "Infinity"},
    {"start_at": None}, {"start_at": "2026-09-06T12:00:00+08:00"},
])
def test_invalid_contract_never_writes_events(timing, change):
    assert post(timing, {**timing.payload(), **change}).status_code in {400, 422}
    assert not timing.store.get_recent_learning_events(limit=None)


@pytest.mark.parametrize("start,end", [(-5, -5), (-1, -5), (-16, 0), (-1, 3), (1, 2), (-312, -301)])
def test_zero_negative_oversized_future_or_stale_intervals_are_rejected(timing, start, end):
    assert post(timing, timing.payload(start=start, end=end)).status_code == 400
    assert timing.store.get_today_interaction() == {
        "interaction_seconds": 0.0, "interaction_timing_available": False,
    }


def test_small_fast_clock_never_counts_its_future_tail_even_later(timing):
    payload = timing.payload(start=-10, end=1)
    assert post(timing, payload).json()["recorded"]
    assert timing.store.get_today_interaction()["interaction_seconds"] == 10
    timing.clock.now += timedelta(seconds=20)
    assert timing.store.get_today_interaction()["interaction_seconds"] == 10
    assert post(timing, payload).json()["recorded"] is False


def test_multiple_sessions_and_duplicate_ranges_count_the_union(timing):
    for start, end in [(-20, -10), (-15, -5), (-14, -12), (-20, -10)]:
        assert post(timing, timing.payload(start=start, end=end, session=str(uuid.uuid4()))).status_code == 200
    assert timing.store.get_today_interaction()["interaction_seconds"] == 15


def test_cross_midnight_is_clipped_into_each_local_calendar_day(timing, monkeypatch):
    day_start, day_end = interaction.local_day_bounds(timing.clock.now)
    timing.clock.now = day_start + timedelta(seconds=5)
    payload = timing.payload(start=-10, end=0)
    assert post(timing, payload).status_code == 200
    assert timing.store.get_today_interaction()["interaction_seconds"] == 5
    monkeypatch.setattr(interaction, "local_day_bounds", lambda _now: (day_start - timedelta(days=1), day_start))
    assert timing.store.get_today_interaction()["interaction_seconds"] == 5


def test_old_text_turns_or_prior_day_data_do_not_invent_today_time(timing):
    timing.store.save_session_turn("虚构旧对话", "虚构回答")
    assert timing.store.get_parent_dashboard()["today"]["interaction_timing_available"] is False
    original = timing.clock.now
    timing.clock.now -= timedelta(days=1)
    assert post(timing).status_code == 200
    timing.clock.now = original
    assert timing.store.get_today_interaction() == {"interaction_seconds": 0.0, "interaction_timing_available": False}


def test_reload_export_and_known_retry_after_five_minutes_preserve_receipts(timing, monkeypatch):
    payload = timing.payload()
    assert post(timing, payload).json()["recorded"]
    old = timing.store
    reloaded = MemoryStore(old.data_dir, old.profile_path, old.history_path, old.learning_events_path, old.template_path)
    monkeypatch.setattr(main, "memory", reloaded)
    timing.clock.now += timedelta(minutes=6)
    assert post(timing, payload).json() == {"ok": True, "recorded": False}
    exported = reloaded.export_bundle()
    assert len(exported["learning_events"]) == 1
    assert exported["learning_events"][0]["payload"]["session_id"] == payload["session_id"]
    assert exported["raw_media_included"] is False
    assert reloaded.get_today_interaction()["interaction_seconds"] == 10


def test_clear_events_resets_totals_and_receipt_index(timing):
    assert post(timing).json()["recorded"]
    result = timing.client.post("/api/parent/data/delete", json={
        "scopes": ["learning_events"], "confirmation": "计时测试宝贝",
    })
    assert result.status_code == 200
    assert not timing.store._interaction_receipts.receipts
    assert timing.store.get_today_interaction()["interaction_timing_available"] is False
    # Deletion clears the receipt namespace; a fresh valid packet may be saved.
    assert post(timing, timing.payload(start=-4, end=-1)).json()["recorded"]
    assert timing.store.get_today_interaction()["interaction_seconds"] == 3


def test_other_scope_deletion_keeps_timing_receipts(timing):
    assert post(timing).json()["recorded"]
    timing.store.delete_family_data(["history"])
    assert post(timing).json()["recorded"] is False
    assert timing.store.get_today_interaction()["interaction_seconds"] == 10


def test_bounded_cache_keeps_old_idempotency_and_conflict_checks(timing):
    timing.store._interaction_receipts = interaction.InteractionReceiptIndex(
        timing.store.learning_events_path, session_limit=2, receipt_limit=2,
    )
    first = timing.payload()
    assert post(timing, first).json()["recorded"]
    for _ in range(4):
        assert post(timing, timing.payload(session=str(uuid.uuid4()))).json()["recorded"]
    index = timing.store._interaction_receipts
    assert len(index.sessions) <= 2 and len(index.receipts) <= 2
    assert post(timing, first).json()["recorded"] is False
    conflict = {**first, "end_at": (timing.clock.now - timedelta(seconds=4)).isoformat()}
    assert post(timing, conflict).status_code == 409
    assert len(timing.store.export_bundle()["learning_events"]) == 5


def test_advancing_session_reads_only_appended_bytes(timing, monkeypatch):
    for _ in range(30):
        timing.store.save_learning_event("fixture", {"text": "historical synthetic event"})
    assert post(timing).json()["recorded"]
    index = timing.store._interaction_receipts
    index.sync()
    reads = []
    original = index._parse_line
    monkeypatch.setattr(index, "_parse_line", lambda line: (reads.append(line), original(line))[1])
    assert post(timing, timing.payload(sequence=2)).json()["recorded"]
    assert not reads  # No existing lines scanned by the next 15-second batch.
    timing.store.save_learning_event("fixture", {"text": "new unrelated event"})
    assert post(timing, timing.payload(sequence=3)).json()["recorded"]
    assert len(reads) == 2  # Only the prior timing receipt plus new event.


def test_malformed_or_unaccepted_log_entries_do_not_count(timing):
    timing.store.save_learning_event("interaction_interval", {"start_at": "NaN"})
    timing.store.save_learning_event("interaction_interval", timing.payload(start=-1000, end=-990))
    assert timing.store.get_today_interaction()["interaction_timing_available"] is False


def test_complete_last_receipt_without_newline_is_still_idempotent(timing, monkeypatch):
    payload = timing.payload()
    assert post(timing, payload).json()["recorded"]
    path = timing.store.learning_events_path
    path.write_bytes(path.read_bytes().rstrip(b"\n"))
    timing.store._interaction_receipts.reset()
    assert post(timing, payload).json()["recorded"] is False
    assert post(timing, timing.payload(sequence=2)).json()["recorded"]
    assert len(timing.store.get_recent_learning_events(limit=None)) == 2


def test_truncated_crash_tail_is_preserved_without_losing_next_receipt(timing):
    path = timing.store.learning_events_path
    partial = b'{"event_type":"interaction_interval","payload":'
    path.write_bytes(partial)
    assert post(timing).json()["recorded"]
    assert path.read_bytes().startswith(partial + b"\n")
    assert post(timing).json()["recorded"] is False
    assert timing.store.get_today_interaction()["interaction_seconds"] == 10


def test_timing_storage_failure_is_an_independent_optional_api(timing, monkeypatch):
    def fail(_payload):
        raise OSError("synthetic disk failure")
    monkeypatch.setattr(timing.store, "record_interaction_interval", fail)
    assert post(timing).status_code == 503
    assert timing.client.get("/health").json()["interaction_timing_supported"] is True
    assert timing.client.get("/api/profile").status_code == 200
    assert not timing.store.get_history()
