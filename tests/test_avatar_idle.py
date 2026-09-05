"""Configured owner clip only; these API tests never run startup or models."""
from dataclasses import replace

from fastapi.testclient import TestClient

from app import main
from app.config import PROJECT_ROOT, Settings


def test_idle_configuration_is_optional_and_project_relative(monkeypatch):
    monkeypatch.setenv("AVATAR_IDLE_PATH", "")
    assert Settings.load().avatar_idle_path is None
    monkeypatch.setenv("AVATAR_IDLE_PATH", "frontend/nathan-idle.mp4")
    assert Settings.load().avatar_idle_path == PROJECT_ROOT / "frontend/nathan-idle.mp4"


def test_idle_route_serves_only_configured_mp4_and_supports_range(tmp_path, monkeypatch):
    clip = tmp_path / "approved.mp4"
    clip.write_bytes(b"synthetic-owner-video-fixture")
    private = tmp_path / "other.txt"
    private.write_text("must-not-be-served")
    monkeypatch.setattr(main, "settings", replace(main.settings, avatar_idle_path=clip))
    # Deliberately do not enter TestClient's context: startup loads real models.
    client = TestClient(main.app)
    try:
        response = client.get("/api/avatar/idle", params={"path": str(private)})
        assert response.status_code == 200
        assert response.headers["content-type"] == "video/mp4"
        assert response.headers["cache-control"] == "no-store"
        assert response.content == clip.read_bytes()
        partial = client.get("/api/avatar/idle", headers={"Range": "bytes=0-3"})
        assert partial.status_code == 206
        assert partial.content == b"synt"
        assert client.get("/health").json()["avatar_idle_ready"] is True
    finally:
        client.close()


def test_missing_or_non_mp4_configuration_returns_404(tmp_path, monkeypatch):
    wrong_type = tmp_path / "photo.png"
    wrong_type.write_bytes(b"not-video")
    client = TestClient(main.app)
    try:
        for path in (None, tmp_path / "missing.mp4", wrong_type, tmp_path):
            monkeypatch.setattr(main, "settings", replace(main.settings, avatar_idle_path=path))
            assert client.get("/api/avatar/idle").status_code == 404
            assert client.get("/health").json()["avatar_idle_ready"] is False
    finally:
        client.close()
