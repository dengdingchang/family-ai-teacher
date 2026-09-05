"""Remote-first Nathan TTS adapter with the existing local model as fallback."""

from __future__ import annotations

import threading
import math
import logging
import time
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import replace
from typing import Protocol

import httpx

from app.config import Settings
from audio.metrics import unavailable_gpu_measurement

from .adapter import TTSAdapterError, TTSResult


class TTSLike(Protocol):
    @property
    def ready(self) -> bool: ...

    def synthesize(
        self,
        text: str,
        *,
        avatar_flush: bool = True,
        defer_avatar: bool = False,
    ) -> TTSResult: ...


class RemoteNathanTTSAdapter:
    """Call the loopback SSH tunnel to the private AI Station TTS service."""

    def __init__(self, settings: Settings) -> None:
        self.base_url = settings.tts_remote_base_url.rstrip("/")
        timeout = httpx.Timeout(settings.tts_remote_timeout_seconds, connect=2.0)
        self._client = httpx.Client(timeout=timeout)
        self._control_timeout = httpx.Timeout(2.0, connect=1.0)
        self._lock = threading.RLock()

    @property
    def ready(self) -> bool:
        return bool(self.base_url)

    def synthesize(
        self,
        text: str,
        *,
        avatar_flush: bool = True,
        defer_avatar: bool = False,
    ) -> TTSResult:
        clean = " ".join(text.strip().split())
        if not clean:
            raise TTSAdapterError("TTS text is empty")
        if len(clean) > 200:
            raise TTSAdapterError("TTS text is too long")
        if not self.ready:
            raise TTSAdapterError("Remote Nathan TTS is not configured")
        started = time.perf_counter()
        try:
            with self._lock:
                response = self._client.post(
                    f"{self.base_url}/synthesize",
                    json={
                        "text": clean,
                        "avatar_flush": avatar_flush,
                        "defer_avatar": defer_avatar,
                    },
                )
            response.raise_for_status()
            audio_bytes = response.content
            duration_s = float(response.headers.get("X-TTS-Duration-S", "0"))
            if not audio_bytes or duration_s <= 0:
                raise TTSAdapterError("Remote Nathan TTS returned empty audio")
            audio_mime = response.headers.get("Content-Type", "audio/webm").split(";", 1)[0]
            avatar_cued = response.headers.get("X-Avatar-Cued", "0") == "1"
            avatar_lead_ms = int(response.headers.get("X-Avatar-Lead-Ms", "0"))
            avatar_cue_id = response.headers.get("X-Avatar-Cue-ID", "").strip()
        except (httpx.HTTPError, OSError, ValueError) as exc:
            raise TTSAdapterError("Remote Nathan TTS is temporarily unavailable") from exc
        try:
            server_elapsed_s = float(response.headers.get("X-TTS-Elapsed-S", "nan"))
            if not math.isfinite(server_elapsed_s) or server_elapsed_s < 0:
                server_elapsed_s = None
        except ValueError:
            server_elapsed_s = None
        return TTSResult(
            audio_bytes=audio_bytes,
            duration_s=round(duration_s, 3),
            elapsed_s=round(time.perf_counter() - started, 3),
            gpu=unavailable_gpu_measurement(),
            backend="self-host",
            audio_mime=audio_mime,
            avatar_cued=avatar_cued,
            avatar_audio_lead_ms=max(0, min(1500, avatar_lead_ms)),
            avatar_cue_id=avatar_cue_id,
            server_elapsed_s=server_elapsed_s,
        )

    def cue_avatar(self, result: TTSResult, *, avatar_flush: bool = True) -> TTSResult:
        if not result.avatar_cue_id:
            return result
        try:
            # HTTPX clients support concurrent requests. A playback cue must not
            # wait behind synthesis of the next sentence on the model lock.
            response = self._client.post(
                f"{self.base_url}/avatar/cue",
                json={"cue_id": result.avatar_cue_id, "avatar_flush": avatar_flush},
                timeout=self._control_timeout,
            )
            response.raise_for_status()
            payload = response.json()
            cued = bool(payload.get("cued"))
            lead_ms = int(payload.get("avatar_audio_lead_ms", 0)) if cued else 0
        except (httpx.HTTPError, OSError, ValueError, TypeError):
            return replace(result, avatar_cue_id="")
        return replace(
            result,
            avatar_cued=cued,
            avatar_audio_lead_ms=max(0, min(1500, lead_ms)),
            avatar_cue_id="",
        )

    def discard_avatar(self, result: TTSResult) -> None:
        if not result.avatar_cue_id:
            return
        try:
            self._client.post(
                f"{self.base_url}/avatar/discard",
                json={"cue_id": result.avatar_cue_id},
                timeout=self._control_timeout,
            )
        except (httpx.HTTPError, OSError):
            pass

    def flush_avatar(self) -> None:
        try:
            # Interruption cannot queue behind the next sentence's synthesis.
            # This controls the renderer only; model inference stays serialized.
            self._client.post(f"{self.base_url}/avatar/flush", timeout=self._control_timeout)
        except (httpx.HTTPError, OSError):
            pass

    def shutdown(self) -> None:
        self._client.close()


class FallbackNathanTTSAdapter:
    """Prefer AI Station speed and fail over to the audited local runtime."""

    def __init__(self, primary: RemoteNathanTTSAdapter, fallback: TTSLike, *, retry_cooldown_seconds: float = 30) -> None:
        if not math.isfinite(retry_cooldown_seconds) or not 0 <= retry_cooldown_seconds <= 300:
            raise ValueError("TTS remote retry cooldown must be between 0 and 300 seconds")
        self.primary = primary
        self.fallback = fallback
        self._retry_cooldown_seconds = retry_cooldown_seconds
        self._remote_retry_after = 0.0
        self.last_backend = "not_started"
        self._last_inference_backend = "not_started"
        self.last_remote_error = ""
        self._lock = threading.RLock()
        self._cache_lock = threading.RLock()
        self._audio_cache: OrderedDict[str, TTSResult] = OrderedDict()
        self._audio_cache_limit = 4

    @property
    def ready(self) -> bool:
        return self.primary.ready or self.fallback.ready

    def is_cached(self, text: str) -> bool:
        """Return whether a normalized phrase can play without inference."""

        clean = " ".join(str(text).strip().split())
        if not clean:
            return False
        with self._cache_lock:
            return clean in self._audio_cache

    @property
    def cache_entries(self) -> int:
        with self._cache_lock:
            return len(self._audio_cache)

    def _cached_result(self, text: str) -> TTSResult | None:
        with self._cache_lock:
            cached = self._audio_cache.get(text)
            if cached is not None:
                self._audio_cache.move_to_end(text)
                self.last_backend = cached.backend
            return cached

    def prewarm(self, texts: list[str]) -> int:
        """Cache a tiny remote-generated set without loading the local fallback."""

        normalized = list(dict.fromkeys(" ".join(str(text).strip().split()) for text in texts))
        normalized = [text for text in normalized if text]
        warmed = 0
        for text in normalized:
            with self._cache_lock:
                if text in self._audio_cache:
                    continue
            result = self.primary.synthesize(text, defer_avatar=True)
            self.primary.discard_avatar(result)
            cached = replace(
                result,
                elapsed_s=0.0,
                backend="self-host-cache",
                avatar_cued=False,
                avatar_audio_lead_ms=0,
                avatar_cue_id="",
                server_elapsed_s=None,
            )
            with self._cache_lock:
                self._audio_cache[text] = cached
                self._audio_cache.move_to_end(text)
                while len(self._audio_cache) > self._audio_cache_limit:
                    self._audio_cache.popitem(last=False)
                self.last_backend = cached.backend
            warmed += 1
        return warmed

    def synthesize(
        self,
        text: str,
        *,
        avatar_flush: bool = True,
        defer_avatar: bool = False,
        cancel_event: threading.Event | None = None,
    ) -> TTSResult:
        clean = " ".join(text.strip().split())
        if not clean:
            raise TTSAdapterError("TTS text is empty")
        self._check_cancelled(cancel_event)
        cached = self._cached_result(clean)
        if cached is not None:
            return cached
        with self._synthesis_slot(cancel_event):
            cached = self._cached_result(clean)
            if cached is not None:
                return cached
            previous_backend = self._last_inference_backend
            if time.monotonic() < self._remote_retry_after:
                try:
                    result = self.fallback.synthesize(
                        clean, avatar_flush=avatar_flush, defer_avatar=defer_avatar,
                    )
                except TTSAdapterError:
                    # Do not keep routing to a fallback that has stopped working.
                    self._remote_retry_after = 0.0
                    raise
                self._last_inference_backend = result.backend
                self.last_backend = result.backend
                return result
            remote_started = time.perf_counter()
            try:
                result = self.primary.synthesize(
                    clean,
                    avatar_flush=avatar_flush,
                    defer_avatar=defer_avatar,
                )
                remote_error: TTSAdapterError | None = None
            except TTSAdapterError as exc:
                # The loopback tunnel has its own supervisor. Retrying a hung
                # remote request here would only multiply child-facing silence.
                remote_error = exc
            if remote_error is not None:
                self._check_cancelled(cancel_event)
                self.last_remote_error = str(remote_error)
                cause = remote_error.__cause__
                # Do not log exception text, response bodies, URLs or child text.
                failure_kind = type(cause).__name__ if cause is not None else "TTSAdapterError"
                status = cause.response.status_code if isinstance(cause, httpx.HTTPStatusError) else None
                logging.getLogger(__name__).warning(
                    "Nathan TTS fallback: kind=%s status=%s remote_elapsed_s=%.3f",
                    failure_kind, status, time.perf_counter() - remote_started,
                )
                result = self.fallback.synthesize(
                    clean,
                    avatar_flush=avatar_flush,
                    defer_avatar=defer_avatar,
                )
                self._remote_retry_after = time.monotonic() + self._retry_cooldown_seconds
            elif previous_backend == "local":
                shutdown = getattr(self.fallback, "shutdown", None)
                if shutdown is not None:
                    shutdown()
            if remote_error is None:
                self._remote_retry_after = 0.0
                self.last_remote_error = ""
            self._last_inference_backend = result.backend
            self.last_backend = result.backend
            return result

    @staticmethod
    def _check_cancelled(cancel_event: threading.Event | None) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise TTSAdapterError("Speech turn was cancelled")

    @contextmanager
    def _synthesis_slot(self, cancel_event: threading.Event | None):
        self._check_cancelled(cancel_event)
        while not self._lock.acquire(timeout=0.1):
            self._check_cancelled(cancel_event)
        try:
            self._check_cancelled(cancel_event)
            yield
        finally:
            self._lock.release()

    def synthesize_cancellable(self, text: str, *, cancel_event: threading.Event, **kwargs) -> TTSResult:
        return self.synthesize(text, cancel_event=cancel_event, **kwargs)

    def cue_avatar(self, result: TTSResult, *, avatar_flush: bool = True) -> TTSResult:
        return self.primary.cue_avatar(result, avatar_flush=avatar_flush)

    def discard_avatar(self, result: TTSResult) -> None:
        self.primary.discard_avatar(result)

    def flush_avatar(self) -> None:
        self.primary.flush_avatar()

    def shutdown(self) -> None:
        self.primary.shutdown()
        shutdown = getattr(self.fallback, "shutdown", None)
        if shutdown is not None:
            shutdown()
