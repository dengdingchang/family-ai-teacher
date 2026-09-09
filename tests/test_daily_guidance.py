from __future__ import annotations

import json
from datetime import datetime

from fastapi.testclient import TestClient

import app.main as main
from memory.store import MemoryStore


def make_store(tmp_path):
    template = tmp_path / "profile.example.json"
    template.write_text(json.dumps({"name": "测试宝贝", "age": 4}, ensure_ascii=False), encoding="utf-8")
    data = tmp_path / "data"
    return MemoryStore(data, data / "profile.json", data / "history.jsonl", data / "events.jsonl", template)


def test_api_uses_service_date_for_save_stale_and_clear(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    monkeypatch.setattr(main, "memory", store)
    client = TestClient(main.app)
    today = datetime.now().astimezone().date().isoformat()

    saved = client.patch("/api/profile", json={"daily_guidance": "  练 刷牙  ", "daily_guidance_date": "2000-01-01"}).json()
    assert saved["daily_guidance_date"] == today
    assert saved["daily_guidance_active"] is True

    store.update_child_profile({"daily_guidance_date": "2000-01-01"})
    stale = client.get("/api/profile").json()
    assert stale["daily_guidance"] == "练 刷牙"
    assert stale["daily_guidance_active"] is False

    cleared = client.patch("/api/profile", json={"daily_guidance": ""}).json()
    assert cleared["daily_guidance"] == ""
    assert cleared["daily_guidance_date"] == ""
    assert cleared["daily_guidance_active"] is False


def test_explicit_activity_beats_welcome_and_daily_guidance(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    monkeypatch.setattr(main, "memory", store)
    profile = store.update_child_profile({
        "enabled_activities": ["game"],
        "daily_guidance": "练刷牙",
        "daily_guidance_date": datetime.now().astimezone().date().isoformat(),
    })
    text = "我回来了，我想下棋"
    assert main._explicit_chess_request(text) is True
    response = main._chess_request_response(text)
    assert response is not None


def test_chess_request_remains_narrow():
    assert main._explicit_chess_request("我想下棋") is True
    assert main._explicit_chess_request("我回来了，我想下国际象棋") is True
    assert main._explicit_chess_request("我不想下棋") is False
    assert main._explicit_chess_request("昨天我下棋了") is False
    assert main._explicit_chess_request("你会下棋吗") is False


def test_media_endpoint_accepts_only_a_short_canonical_topic(monkeypatch):
    requested = []

    class FakeSearch:
        def search(self, topic):
            requested.append(topic)
            return {"topic": topic, "cards": []}

    monkeypatch.setattr(main, "media_search", FakeSearch())
    client = TestClient(main.app)
    assert client.post("/api/media/suggestions", json={"topic": "刷牙"}).status_code == 200
    assert requested == ["刷牙"]
    assert client.post("/api/media/suggestions", json={"topic": "孩子刚才说了一整句包含家庭信息的原话"}).status_code == 422
    assert requested == ["刷牙"]
