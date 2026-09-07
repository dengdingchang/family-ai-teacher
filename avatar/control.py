"""Coordinate streaming PCM controls from this one local application only."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
from collections.abc import Awaitable, Callable


class StreamingAvatarControl:
    """Keep idle pages from flushing the latest PCM sender's shared renderer.

    This governs local control writes, not the remote server's frame broadcast.
    Legacy server-side TTS cues must continue to bypass this coordinator.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._owner: object | None = None

    async def forward(
        self, client: object, send: Callable[[str | bytes], Awaitable[None]], message: str | bytes,
    ) -> None:
        event = None
        if isinstance(message, str):
            try:
                event = json.loads(message)
            except (ValueError, TypeError):
                pass
        kind = event.get("type") if isinstance(event, dict) else None
        if kind == "audio":
            pcm = event.get("pcm")
            if not isinstance(pcm, str):
                return
            try:
                size = len(base64.b64decode(pcm, validate=True))
            except (ValueError, binascii.Error):
                return
            if not size or size % 2:  # The existing wire protocol is PCM16.
                return

        # Keep both the decision and the awaited transport write under one lock.
        # Otherwise an older delayed flush can be written after new-owner PCM.
        async with self._lock:
            if kind == "flush" and client is not self._owner:
                return
            if kind == "audio" and client is not self._owner:
                await send(json.dumps({"type": "flush"}))
                self._owner = client
            await send(message)

    async def release(self, client: object) -> None:
        async with self._lock:
            if client is self._owner:
                self._owner = None
