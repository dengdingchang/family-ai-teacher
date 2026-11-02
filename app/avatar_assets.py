"""Resolves the avatar portrait and idle clip served to the browser."""

from __future__ import annotations

import mimetypes
from pathlib import Path

from . import deps


def _parent_avatar_configured() -> bool:
    path = deps.parent_enrollment.portrait_path()
    return deps.parent_avatar.configured_for(path.read_bytes() if path else None)


def _avatar_path() -> tuple[Path, str]:
    parent_portrait = deps.parent_enrollment.portrait_path()
    if parent_portrait is not None:
        return parent_portrait, "image/jpeg"
    configured = deps.settings.avatar_image_path
    if configured and configured.is_file() and configured.suffix.lower() in {
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
    }:
        return configured, mimetypes.guess_type(configured.name)[0] or "image/jpeg"
    return deps.settings.fallback_avatar_path, "image/svg+xml"


def _avatar_idle_path() -> Path | None:
    if deps.parent_enrollment.active():
        return None  # Nathan's idle video must never appear over a different parent.
    configured = deps.settings.avatar_idle_path
    if configured and configured.suffix.lower() == ".mp4" and configured.is_file():
        return configured
    return None
