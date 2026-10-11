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


def test_https_upgrade_is_public_host_only_and_trusts_loopback(tmp_path, monkeypatch):
    monkeypatch.setattr(public_auth, "_ACCOUNT", tmp_path / "account.json")
    monkeypatch.setattr(public_auth, "_SESSIONS", tmp_path / "sessions.json")
    public_auth.reset_password("example-private-password")
    async def check():
        for peer in ("127.0.0.1", "203.0.113.10"):
            transport = httpx.ASGITransport(app=gateway_app, client=(peer, 1234))
            async with httpx.AsyncClient(transport=transport, base_url="http://teacher.example.com") as client:
                response = await client.get("/login?next=https://evil.example")
                assert response.status_code == 308
                assert response.headers["location"] == "https://teacher.example.com/login?next=https://evil.example"
                response = await client.get("/login", headers={"x-forwarded-proto": "https"})
                assert response.status_code == (200 if peer == "127.0.0.1" else 308)
                response = await client.get("http://localhost/login")
                assert response.status_code == 200
                response = await client.get("http://evil.example/login")
                assert response.status_code == 400
    asyncio.run(check())


def test_parent_model_settings_accept_authenticated_proxy_origin_only():
    from app.main import _require_local_settings_request
    from starlette.requests import Request
    from fastapi import HTTPException
    for peer, origin, accepted in [("127.0.0.1", "https://teacher.example.com", True),
                                   ("127.0.0.1", "https://evil.example", False),
                                   ("203.0.113.2", "https://teacher.example.com", False)]:
        request = Request({"type":"http", "method":"POST", "scheme":"http", "path":"/api/parent/models",
            "server":("127.0.0.1",18760), "client":(peer,1234), "query_string":b"",
            "headers":[(b"host",b"127.0.0.1:18760"),(b"origin",origin.encode()),
                       (b"x-forwarded-host",b"teacher.example.com"),(b"x-forwarded-proto",b"https")]})
        if accepted:
            _require_local_settings_request(request)
        else:
            with pytest.raises(HTTPException): _require_local_settings_request(request)
