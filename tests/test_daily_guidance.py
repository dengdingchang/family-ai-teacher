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
    assert client.post("/api/media/suggestions", json={"topic": "看看蝴蝶"}).status_code == 422
    assert client.post("/api/media/suggestions", json={"topic": "孩子刚才说了一整句包含家庭信息的原话"}).status_code == 422
    assert requested == ["刷牙"]


def test_media_endpoint_starts_only_a_canonical_async_image_job(monkeypatch):
    requested = []

    class FakeSearch:
        def search(self, topic):
            return {"topic": topic, "cards": [], "reason": ""}

    class FakeGenerator:
        def request(self, topic, job_id=""):
            requested.append((topic, job_id))
            return {
                "job_id": job_id,
                "topic": topic,
                "status": "queued",
                "status_url": f"/api/image-generation/jobs/{job_id}",
            }

    monkeypatch.setattr(main, "media_search", FakeSearch())
    monkeypatch.setattr(main, "image_generator", FakeGenerator())
    response = TestClient(main.app).post(
        "/api/media/suggestions",
        json={"topic": "蝴蝶", "generate_image": True, "image_job_id": "a" * 32},
    )
    assert response.status_code == 200
    assert requested == [("蝴蝶", "a" * 32)]
    assert response.json()["image_generation"] == "queued"


def test_generated_media_route_accepts_only_fixed_hash_filename(tmp_path, monkeypatch):
    image = tmp_path / "fixture.png"
    image.write_bytes(b"fixture")
    calls = []

    class FakeGenerator:
        def safe_file(self, filename):
            calls.append(filename)
            return image

    monkeypatch.setattr(main, "image_generator", FakeGenerator())
    client = TestClient(main.app)
    assert client.get("/api/generated-media/not-a-hash.png").status_code == 404
    assert calls == []
    filename = f"{'a' * 24}.png"
    response = client.get(f"/api/generated-media/{filename}")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert calls == [filename]
