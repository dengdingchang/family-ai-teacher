"""Profile shaping shared by the child page and the parent dashboard."""

from __future__ import annotations

from datetime import datetime
from typing import Any


def _active_daily_guidance(profile: dict[str, Any] | None) -> str:
    if not isinstance(profile, dict):
        return ""
    if str(profile.get("daily_guidance_date", "")).strip() != datetime.now().astimezone().date().isoformat():
        return ""
    return " ".join(str(profile.get("daily_guidance", "")).strip().split())[:120]


def _profile_for_client(profile: dict[str, Any]) -> dict[str, Any]:
    return {**profile, "daily_guidance_active": bool(_active_daily_guidance(profile))}
