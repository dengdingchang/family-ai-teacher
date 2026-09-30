"""Use a temporary family log for activity and symbolic gift receipts."""

import uuid

from fastapi.testclient import TestClient

import app.main as main
from memory.store import MemoryStore


def test_play_time_challenge_unlock_and_parent_redemption(tmp_path, monkeypatch):
    data = tmp_path / "family"
    store = MemoryStore(data, data / "profile.json", data / "history.jsonl",
                        data / "events.jsonl", tmp_path / "template.json")
    monkeypatch.setattr(main, "memory", store)
    client = TestClient(main.app)
    session = {"event_id": str(uuid.uuid4()), "activity": "drawing", "kind": "session",
               "step": "画板", "duration_seconds": 95}
    assert client.post("/api/activities/event", json=session).json()["recorded"] is True
    assert client.post("/api/activities/event", json=session).json()["recorded"] is False
    assert client.post("/api/activities/event", json={**session, "duration_seconds": 96}).status_code == 400
    quiz = {"event_id": str(uuid.uuid4()), "activity": "chess", "kind": "stage",
            "step": "换个办法认棋", "independent": False}
    assert client.post("/api/activities/event", json=quiz).status_code == 200
    assert store.get_activity_summary()["rewards"] == []
    assert client.post("/api/activities/event", json={"event_id": str(uuid.uuid4()), "activity": "chess",
                                                    "kind": "challenge", "step": "高级爸爸", "level": "advanced", "result": "win"}).status_code == 400
    win = {"event_id": str(uuid.uuid4()), "activity": "chess", "kind": "challenge",
           "step": "初级爸爸", "level": "beginner", "result": "win"}
    response = client.post("/api/activities/event", json=win)
    assert response.status_code == 200
    assert response.json()["summary"]["unlocked_chess_level"] == "intermediate"
    dashboard = client.get("/api/parent/dashboard").json()["play_summary"]
    assert dashboard["activities"]["drawing"]["seconds"] == 95
    assert dashboard["activities"]["chess"]["step"] == "初级爸爸"
    assert dashboard["rewards"][0]["status"] == "pending"
    path = f"/api/parent/rewards/{win['event_id']}/redeem"
    assert client.post(path).status_code == 403
    headers = {"origin": "http://testserver", "x-family-parent-action": "redeem"}
    assert client.post(path, headers=headers).json()["redeemed"] is True
    assert client.post(path, headers=headers).json()["redeemed"] is False
    assert store.get_activity_summary()["rewards"][0]["status"] == "redeemed"
    assert all(event["event_type"] != "activity_play" for event in
               main.memory.get_recent_learning_events(limit=None, exclude_types=("activity_play", "activity_reward_redeemed")))
