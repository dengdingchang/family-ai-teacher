"""Focused checks for the protected Windows public entry and enrollment origin."""

import asyncio

import httpx
import pytest

from app import public_auth
from app.public_gateway import app as gateway_app
from app.main import app as child_app


def test_local_password_hash_and_sessions(tmp_path, monkeypatch):
    monkeypatch.setattr(public_auth, "_ACCOUNT", tmp_path / "account.json")
    monkeypatch.setattr(public_auth, "_SESSIONS", tmp_path / "sessions.json")
    public_auth.reset_password("example-private-password")
    with pytest.raises(ValueError):
        public_auth.login("nathan", "incorrect")
    token = public_auth.login("nathan", "example-private-password")
    assert public_auth.session_profile(token) == "nathan"
    public_auth.logout(token)
    assert public_auth.session_profile(token) is None


def test_enrollment_origin_accepts_local_protected_proxy_only():
    async def check():
        transport = httpx.ASGITransport(app=child_app, client=("127.0.0.1", 43122))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8760") as client:
            headers = {"X-Family-Enroll": "1", "X-Forwarded-Host": "teacher.example.com",
                       "Origin": "https://teacher.example.com"}
            accepted = await client.post("/api/parent/enrollment/preview", headers=headers, json=[])
            assert accepted.status_code == 400  # invalid body, after same-origin validation
            headers["Origin"] = "https://unrelated.example"
            rejected = await client.post("/api/parent/enrollment/preview", headers=headers, json=[])
            assert rejected.status_code == 403
    asyncio.run(check())


def test_public_login_starts_parent_guide_and_uses_secure_cookie(tmp_path, monkeypatch):
    monkeypatch.setattr(public_auth, "_ACCOUNT", tmp_path / "account.json")
    monkeypatch.setattr(public_auth, "_SESSIONS", tmp_path / "sessions.json")
    public_auth.reset_password("example-private-password")

    async def check():
        def upstream(request):
            assert request.url.path == "/api/parent/enrollment"
            return httpx.Response(200, json={"active": False})

        gateway_app.state.client = httpx.AsyncClient(
            transport=httpx.MockTransport(upstream), base_url="http://127.0.0.1:8760")
        try:
            transport = httpx.ASGITransport(app=gateway_app)
            async with httpx.AsyncClient(transport=transport, base_url="http://teacher.example.com") as client:
                response = await client.post("/login", data={"profile_id": "nathan", "password": "example-private-password"},
                                             headers={"Origin": "https://teacher.example.com",
                                                      "X-Forwarded-Proto": "https"}, follow_redirects=False)
                assert response.status_code == 303
                assert response.headers["location"] == "/setup"
                cookie = response.headers["set-cookie"]
                assert "Secure" in cookie and "HttpOnly" in cookie and "SameSite=lax" in cookie
        finally:
            await gateway_app.state.client.aclose()

    asyncio.run(check())
