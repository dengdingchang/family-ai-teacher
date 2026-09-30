"""Local, single-family public login using the existing salted password hash."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import tempfile
import threading
import time
import sys
from pathlib import Path

from app.config import Settings


COOKIE = "teacher_session"
SESSION_DAYS = 14
PBKDF2_ROUNDS = 200_000
_LOCK = threading.RLock()
_ROOT = Settings.load().data_dir
_ACCOUNT = _ROOT / "public_gateway_auth.json"
_SESSIONS = _ROOT / "public_gateway_sessions.json"


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".teacher-auth-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def ensure_seeded() -> None:
    account = _read(_ACCOUNT)
    if account.get("id") != "nathan" or not account.get("password_salt") or not account.get("password_hash"):
        raise RuntimeError("Windows public login needs the existing Nathan password hash")


def public_accounts() -> list[dict]:
    ensure_seeded()
    return [{"id": "nathan", "name": "Nathan 主人"}]


def login(profile_id: str, password: str) -> str:
    account = _read(_ACCOUNT)
    if profile_id != "nathan" or account.get("id") != "nathan":
        raise ValueError("账号或密码不正确")
    try:
        salt = bytes.fromhex(account["password_salt"])
        expected = bytes.fromhex(account["password_hash"])
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("账号或密码不正确") from exc
    if not secrets.compare_digest(actual, expected):
        raise ValueError("账号或密码不正确")
    token = secrets.token_urlsafe(32)
    with _LOCK:
        now = time.time()
        sessions = {key: row for key, row in _read(_SESSIONS).items()
                    if isinstance(row, dict) and float(row.get("expires_at") or 0) > now}
        sessions[token] = {"expires_at": now + SESSION_DAYS * 86400}
        _write(_SESSIONS, sessions)
    return token


def session_profile(token: str | None) -> str | None:
    if not token:
        return None
    with _LOCK:
        row = _read(_SESSIONS).get(token)
        return "nathan" if isinstance(row, dict) and float(row.get("expires_at") or 0) > time.time() else None


def logout(token: str | None) -> None:
    if not token:
        return
    with _LOCK:
        sessions = _read(_SESSIONS)
        sessions.pop(token, None)
        _write(_SESSIONS, sessions)


def reset_password(password: str) -> None:
    if not 10 <= len(password) <= 128:
        raise ValueError("密码必须为 10 至 128 位")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    with _LOCK:
        _write(_ACCOUNT, {"id": "nathan", "password_salt": salt.hex(), "password_hash": digest.hex()})
        _write(_SESSIONS, {})


if __name__ == "__main__":
    if sys.argv[1:] != ["reset"]:
        raise SystemExit("Unsupported auth command")
    reset_password(sys.stdin.read().rstrip("\r\n"))
    print("PASS")
