"""Corrupt skill storage cannot break read-only views or duplicate played turns."""

import json
import uuid
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import app.main as main
from memory.store import DEFAULT_SKILLS, MemoryStore


@pytest.fixture
def family(tmp_path, monkeypatch):
    data = tmp_path / "data"
    store = MemoryStore(data, data / "profile.json", data / "history.jsonl",
                        data / "events.jsonl", tmp_path / "absent.json")
    store.update_child_profile({"name": "临时验证", "brain_mode": "local_lessons_only"})
    monkeypatch.setattr(main, "memory", store)
    monkeypatch.setattr(main, "llm", SimpleNamespace(configured=False))
    monkeypatch.setattr(main, "tts", SimpleNamespace(synthesize=lambda *args, **kwargs: SimpleNamespace(
        audio_bytes=b"synthetic-mock", audio_mime="audio/ogg", duration_s=.1,
        elapsed_s=.001, backend="memory-test", avatar_cued=False, avatar_audio_lead_ms=0,
        gpu=SimpleNamespace(available=False, start_mib=None, peak_mib=None, end_mib=None, sample_count=0),
    )))
    ids = []
    client = TestClient(main.app, raise_server_exceptions=False)

    def stream(text="我想画一只恐龙。"):
        turn_id = str(uuid.uuid4())
        ids.append(turn_id)
        response = client.post("/api/conversation/text/stream", json={"text": text},
                               headers={"X-Conversation-Turn-Id": turn_id})
        assert response.status_code == 200
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        done = next(event for event in events if event["event"] == "done")
        assert done["ok"] and done["commit_required"]
        assert any(event["event"] == "audio" and event["semantic"] for event in events)
        return turn_id

    yield SimpleNamespace(store=store, client=client, stream=stream)
    with main._stream_turn_lock:
        for turn_id in ids:
            main._stream_turns.pop(turn_id, None)


@pytest.mark.parametrize("damage", [
    b"{broken JSON", b'{"skills":null}', b'{"skills":"wrong"}',
    b'{"skills":[null,17,"wrong",[],{}]}',
    b'{"skills":[{"id":"math.count_1_10","keywords":null}]}',
    b'{"skills":[{"id":"math.count_1_10","practice_count":"broken"}]}',
    b"\xff\xfeinvalid UTF8", b"[]",
])
def test_bad_graph_keeps_parent_reads_and_repeated_audio_commit_available_without_overwrite(family, damage):
    store, client = family.store, family.client
    store.skills_path.write_bytes(damage)
    dashboard = client.get("/api/parent/dashboard")
    assert dashboard.status_code == 200
    assert len(dashboard.json()["skill_graph"]["skills"]) == len(DEFAULT_SKILLS)
    assert dashboard.json()["skill_graph"]["recovery_required"] is True
    skills_response = client.get("/api/skills")
    assert skills_response.status_code == 200
    assert skills_response.json()["recovery_required"] is True
    assert client.get("/api/curriculum/next").status_code == 200
    assert store.skills_path.read_bytes() == damage

    turn_id = family.stream()
    assert not store.get_history(), "generated audio is not yet a playback receipt"
    first = client.post(f"/api/conversation/turns/{turn_id}/complete")
    repeated = client.post(f"/api/conversation/turns/{turn_id}/complete")
    assert first.status_code == repeated.status_code == 200
    assert first.json()["history"] == repeated.json()["history"]
    assert first.json()["history"]["user_text"] == "我想画一只恐龙。"
    assert repeated.json()["already_completed"] is True
    assert len(store.get_history()) == 1
    assert len([event for event in store.get_recent_learning_events(limit=None)
                if event["event_type"] == "conversation"]) == 1
    assert all(skill["practice_count"] == 0 for skill in store.get_skill_graph()["skills"])

    with pytest.raises(OSError, match="recovery"):
        store.update_skill("math.count_1_10", {"status": "mastered", "mastery_score": 1})
    assert not any(event["event_type"] == "skill_review" for event in store.get_recent_learning_events(limit=None))
    assert store.skills_path.read_bytes() == damage
    assert client.get("/api/parent/dashboard").status_code == 200


def test_corrupt_graph_cannot_turn_cancelled_audio_into_a_saved_turn(family):
    damage = b'{"skills":null}'
    family.store.skills_path.write_bytes(damage)
    turn_id = family.stream()
    assert family.client.post(f"/api/conversation/turns/{turn_id}/cancel").json()["cancelled"]
    assert family.client.post(f"/api/conversation/turns/{turn_id}/complete").status_code == 409
    assert not family.store.get_history()
    assert not family.store.get_recent_learning_events(limit=None)
    assert family.store.skills_path.read_bytes() == damage


def test_read_only_skill_initialization_returns_defaults_without_claiming_updates(family, monkeypatch):
    original = family.store._write_json

    def unavailable(path, value):
        if path == family.store.skills_path:
            raise PermissionError("synthetic read-only storage")
        return original(path, value)

    monkeypatch.setattr(family.store, "_write_json", unavailable)
    dashboard = family.client.get("/api/parent/dashboard")
    assert dashboard.status_code == 200
    assert dashboard.json()["skill_graph"]["recovery_required"] is False
    assert not family.store.skills_path.exists()
    with pytest.raises(PermissionError):
        family.store.update_skill("math.count_1_10", {"status": "mastered"})
    assert not family.store.get_recent_learning_events(limit=None)


def test_one_invalid_entry_preserves_valid_parent_assessment_without_rewriting_the_source(family):
    skill = family.store.get_skill_graph()["skills"][0]
    skill.update(status="mastered", mastery_score=1, evidence_count=2, last_evidence="临时家长观察")
    damage = json.dumps({"skills": [skill, None]}, ensure_ascii=False).encode("utf-8")
    family.store.skills_path.write_bytes(damage)
    result = family.client.get("/api/parent/dashboard")
    assert result.status_code == 200
    assert result.json()["skill_graph"]["recovery_required"] is True
    actual = next(item for item in result.json()["skill_graph"]["skills"] if item["id"] == skill["id"])
    for key in ("status", "mastery_score", "evidence_count", "last_evidence"):
        assert actual[key] == skill[key]
    assert family.store.skills_path.read_bytes() == damage


def test_missing_and_healthy_graphs_are_not_recovery_cases_and_flag_is_never_persisted(family):
    store = family.store
    assert not store.skills_path.exists()
    assert store.get_skill_graph()["recovery_required"] is False
    assert "recovery_required" not in json.loads(store.skills_path.read_text(encoding="utf-8"))
    assert family.client.get("/api/parent/dashboard").json()["skill_graph"]["recovery_required"] is False
    store.update_skill("math.count_1_10", {"status": "practicing"})
    assert "recovery_required" not in json.loads(store.skills_path.read_text(encoding="utf-8"))
    store.update_learning_state("我们数数字", "一二三")
    assert "recovery_required" not in json.loads(store.skills_path.read_text(encoding="utf-8"))


def test_duplicate_skill_ids_require_recovery_without_choosing_or_rewriting_an_assessment(family):
    store = family.store
    first = {"id": "math.count_1_10", "status": "mastered", "mastery_score": 1,
             "evidence_count": 2, "last_evidence": "临时冲突证据A", "parent_reviewed_at": "2026-09-06T00:00:00Z"}
    second = {"id": first["id"], "status": "practicing", "mastery_score": .5,
              "evidence_count": 1, "last_evidence": "临时冲突证据B", "parent_reviewed_at": "2026-09-06T01:00:00Z"}
    unaffected = {**first, "id": "english.words", "last_evidence": "临时合法英语评估"}
    for conflicting in ([first, second], [second, first]):
        damage = json.dumps({"skills": [*conflicting, unaffected]}, ensure_ascii=False).encode("utf-8")
        store.skills_path.write_bytes(damage)
        response = family.client.get("/api/parent/dashboard")
        assert response.status_code == 200
        graph = response.json()["skill_graph"]
        assert graph["recovery_required"] is True
        skills = {item["id"]: item for item in graph["skills"]}
        provisional = skills[first["id"]]
        assert provisional["status"] == "not_started"
        assert provisional["mastery_score"] == provisional["evidence_count"] == 0
        assert not provisional["last_evidence"] and not provisional.get("parent_reviewed_at")
        assert skills[unaffected["id"]]["last_evidence"] == unaffected["last_evidence"]
        assert skills[unaffected["id"]]["status"] == "mastered"
        assert store.skills_path.read_bytes() == damage
        assert family.client.patch(f"/api/skills/{first['id']}", json={"status": "mastered"}).status_code >= 400
        assert store.skills_path.read_bytes() == damage
        assert not any(item["event_type"] == "skill_review" for item in store.get_recent_learning_events(limit=None))


def test_optional_learning_and_activity_failures_do_not_duplicate_history_or_award_practice(family, monkeypatch):
    store = family.store
    store.apply_activity_transition({"action": "set", "activity": "numbers", "step": 1, "topic": "数字"})

    def bad_learning(*args, **kwargs):
        raise TypeError("synthetic corrupt learning metadata")

    def bad_activity(*args, **kwargs):
        raise OSError("synthetic unavailable activity storage")

    monkeypatch.setattr(store, "observe_turn", bad_learning)
    monkeypatch.setattr(store, "apply_activity_transition", bad_activity)
    turn_id = family.stream("一二三")
    first = family.client.post(f"/api/conversation/turns/{turn_id}/complete")
    repeated = family.client.post(f"/api/conversation/turns/{turn_id}/complete")
    assert first.status_code == repeated.status_code == 200
    assert first.json()["history"] == repeated.json()["history"]
    assert len(store.get_history()) == 1
    assert store.get_activity_state()["step"] == 1
    assert not any(event["event_type"] in {"practice_attempt", "skill_review", "activity"}
                   for event in store.get_recent_learning_events(limit=None))


@pytest.mark.parametrize("failure_type", [TypeError, KeyError])
def test_optional_parent_response_failure_cannot_reopen_a_saved_turn(family, monkeypatch, failure_type):
    store = family.store
    message = store.add_parent_message("临时爸爸留言")
    store.mark_parent_message_delivered(message["id"], "已播放的临时留言")
    monkeypatch.setattr(store, "parent_message_response_target", lambda text: message["id"])
    capture = Mock(side_effect=failure_type("synthetic parent response metadata"))
    monkeypatch.setattr(store, "capture_parent_message_response", capture)
    turn_id = family.stream()
    first = family.client.post(f"/api/conversation/turns/{turn_id}/complete")
    repeated = family.client.post(f"/api/conversation/turns/{turn_id}/complete")
    assert first.status_code == repeated.status_code == 200
    assert first.json()["history"] == repeated.json()["history"]
    assert repeated.json()["already_completed"] is True
    assert len(store.get_history()) == 1
    capture.assert_called_once()
    assert store.get_parent_messages()[0]["status"] == "delivered"
