"""Only explicit spoken requests may capture a frame, and permission is rechecked."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app import main


@pytest.mark.parametrize("text,expected", [
    ("爸爸你看我画的恐龙", True), ("你看看我的积木", True),
    ("我的衣服是什么颜色", True), ("我喜欢恐龙", False),
    ("不要看我的画", False), ("爸爸老师不用看了", False), ("我昨天看了一本书", False),
    ("昨天爸爸看我的画笑了", False), ("故事里的爸爸看着小恐龙", False),
    ("你看过恐龙吗", False), ("爸爸老师，请看看这个", True), ("你看一下我的画", True),
])
def test_explicit_intent(text, expected):
    assert main._explicit_visual_request(text) is expected


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "_current_profile", lambda: {"enabled_activities": ["vision_photo"]})
    monkeypatch.setattr(main, "transcribe", AsyncMock(return_value={"text": "爸爸你看我的积木"}))
    async def fake_conversation(text, **kwargs):
        yield main._sse({"event": "done", "assistant_text": text, "vision": kwargs.get("vision_context", "")})
    monkeypatch.setattr(main, "_stream_conversation", fake_conversation)
    # Without the context manager no real model startup hooks run.
    return TestClient(main.app)


def test_voice_requests_one_frame_and_failed_camera_resumes_without_loop(client):
    first = client.post("/api/conversation/stream", files={"audio": ("fixture.wav", b"fixture", "audio/wav")})
    assert first.status_code == 200
    assert '"event": "vision_request"' in first.text
    resumed = client.post("/api/conversation/stream", data={
        "transcript": "爸爸你看我的积木", "observation_attempted": "true",
    })
    assert resumed.status_code == 200
    assert "vision_request" not in resumed.text
    assert '"event": "done"' in resumed.text


def test_parent_disabled_camera_is_not_requested_or_accepted(client, monkeypatch):
    monkeypatch.setattr(main, "_current_profile", lambda: {"enabled_activities": []})
    response = client.post("/api/conversation/stream", files={"audio": ("fixture.wav", b"fixture", "audio/wav")})
    assert "vision_request" not in response.text
    upload = client.post("/api/conversation/stream", data={
        "transcript": "你看", "observation_attempted": "true",
    }, files={"frame": ("fixture.jpg", b"fixture", "image/jpeg")})
    assert upload.status_code == 403


def test_requested_frame_context_survives_recording_failure(client, monkeypatch):
    monkeypatch.setattr(main.camera, "capture_frame", lambda *a, **k: None)
    monkeypatch.setattr(main, "llm", SimpleNamespace(describe_image=lambda *a: SimpleNamespace(text="红色积木")))
    def failure(*a, **k):
        raise OSError("unavailable")
    monkeypatch.setattr(main.memory, "save_learning_event", failure)
    response = client.post("/api/conversation/stream", data={
        "transcript": "你看看我的积木", "observation_attempted": "true",
    }, files={"frame": ("fixture.jpg", b"fixture", "image/jpeg")})
    assert response.status_code == 200
    assert "红色积木" in response.text
