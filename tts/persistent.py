"""Persistent adapter around the existing Nathan Qwen3-TTS voice clone."""

from __future__ import annotations

import atexit
import base64
import io
import json
import os
import subprocess
import threading
import time
import wave
from collections import OrderedDict, deque
from pathlib import Path

from app.config import Settings
from audio.metrics import GpuMeter, unavailable_gpu_measurement

from .adapter import TTSAdapterError, TTSResult


def _hidden_process_kwargs() -> dict[str, int]:
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


def _compact_detail(value: str, limit: int = 280) -> str:
    return " ".join(line.strip() for line in value.splitlines() if line.strip())[-limit:]


class PersistentNathanTTSAdapter:
    """Load the audited model once, then exchange short WAVs in memory."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._process: subprocess.Popen[str] | None = None
        self._stderr_tail: deque[str] = deque(maxlen=12)
        self._lock = threading.RLock()
        self._request_number = 0
        self._audio_cache: OrderedDict[str, tuple[bytes, float]] = OrderedDict()
        self._audio_cache_limit = 24
        atexit.register(self.shutdown)

    @property
    def ready(self) -> bool:
        return self.settings.tts_ready

    def is_cached(self, text: str) -> bool:
        """Return whether a normalized phrase can be played without model inference."""

        clean = " ".join(str(text).strip().split())
        if not clean:
            return False
        with self._lock:
            return clean in self._audio_cache

    @property
    def cache_entries(self) -> int:
        with self._lock:
            return len(self._audio_cache)

    def _reference_text(self) -> str:
        if self.settings.tts_ref_text:
            return self.settings.tts_ref_text
        try:
            payload = json.loads(self.settings.tts_ref_text_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise TTSAdapterError("TTS reference text file cannot be read") from exc
        if isinstance(payload, list):
            for item in payload:
                if isinstance(item, dict) and item.get("name") == "neutral_zh_v2" and item.get("ref_text"):
                    return str(item["ref_text"])
        raise TTSAdapterError("Chinese Nathan reference text was not found")

    def _environment(self) -> dict[str, str]:
        environment = os.environ.copy()
        for key in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"):
            environment.pop(key, None)
        environment["PYTHONUTF8"] = "1"
        environment["PYTHONIOENCODING"] = "utf-8"
        environment["HF_HUB_OFFLINE"] = "1"
        environment["TRANSFORMERS_OFFLINE"] = "1"
        return environment

    def _collect_stderr(self, process: subprocess.Popen[str]) -> None:
        if process.stderr is None:
            return
        for line in process.stderr:
            detail = _compact_detail(line)
            if detail:
                self._stderr_tail.append(detail)

    def _close_process(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
        except OSError:
            pass
        if process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    process.kill()
                except OSError:
                    pass

    def _readline(self, process: subprocess.Popen[str], timeout: float) -> str:
        if process.stdout is None:
            raise TTSAdapterError("Nathan TTS daemon has no stdout")
        result: list[str] = []

        def read() -> None:
            try:
                result.append(process.stdout.readline())
            except (OSError, ValueError):
                result.append("")

        reader = threading.Thread(target=read, name="nathan-tts-response", daemon=True)
        reader.start()
        reader.join(timeout=max(1.0, timeout))
        if reader.is_alive():
            self._close_process()
            raise TTSAdapterError("Nathan TTS daemon timed out")
        line = result[0].strip() if result else ""
        if not line:
            detail = _compact_detail(" ".join(self._stderr_tail))
            suffix = f": {detail}" if detail else ""
            raise TTSAdapterError(f"Nathan TTS daemon stopped unexpectedly{suffix}")
        return line

    def _start_process(self) -> subprocess.Popen[str]:
        if not self.ready:
            raise TTSAdapterError("Existing Nathan TTS runtime or model is not available")
        command = [
            str(self.settings.tts_python),
            str(self.settings.project_root / "tts" / "daemon.py"),
            "--model",
            str(self.settings.tts_model),
            "--ref-audio",
            str(self.settings.tts_ref_audio),
            "--ref-text",
            self._reference_text(),
            "--language",
            self.settings.tts_language,
            "--dtype",
            self.settings.tts_dtype,
            "--prompt-mode",
            self.settings.tts_prompt_mode,
        ]
        if self.settings.tts_cpu:
            command.append("--cpu")
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=self._environment(),
                **_hidden_process_kwargs(),
            )
        except OSError as exc:
            raise TTSAdapterError("Nathan TTS daemon could not start") from exc
        self._process = process
        threading.Thread(
            target=self._collect_stderr,
            args=(process,),
            name="nathan-tts-diagnostics",
            daemon=True,
        ).start()
        try:
            ready_line = self._readline(process, self.settings.tts_timeout_seconds)
            ready = json.loads(ready_line)
        except (json.JSONDecodeError, TTSAdapterError) as exc:
            self._close_process()
            if isinstance(exc, TTSAdapterError):
                raise
            raise TTSAdapterError("Nathan TTS daemon returned an invalid ready message") from exc
        if ready.get("event") != "ready":
            self._close_process()
            detail = str(ready.get("error", "unknown startup error"))
            raise TTSAdapterError(f"Nathan TTS daemon failed to initialize: {_compact_detail(detail)}")
        return process

    def _ensure_process(self) -> subprocess.Popen[str]:
        if self._process is None or self._process.poll() is not None:
            self._close_process()
            return self._start_process()
        return self._process

    def _request(self, text: str) -> tuple[bytes, float]:
        process = self._ensure_process()
        if process.stdin is None:
            raise TTSAdapterError("Nathan TTS daemon has no stdin")
        self._request_number += 1
        request_id = str(self._request_number)
        try:
            process.stdin.write(json.dumps({"id": request_id, "text": text}) + "\n")
            process.stdin.flush()
            payload = json.loads(self._readline(process, self.settings.tts_timeout_seconds))
        except (OSError, BrokenPipeError, json.JSONDecodeError) as exc:
            self._close_process()
            raise TTSAdapterError("Nathan TTS daemon response was invalid") from exc
        if str(payload.get("id", "")) != request_id:
            self._close_process()
            raise TTSAdapterError("Nathan TTS daemon response id did not match the request")
        if payload.get("event") == "error":
            self._close_process()
            detail = _compact_detail(str(payload.get("error", "unknown generation error")))
            raise TTSAdapterError(f"Nathan TTS generation failed: {detail}")
        if payload.get("event") != "audio":
            self._close_process()
            raise TTSAdapterError("Nathan TTS daemon returned no audio")
        try:
            audio_bytes = base64.b64decode(str(payload["audio_base64"]), validate=True)
            duration_s = float(payload["duration_s"])
        except (KeyError, ValueError, TypeError) as exc:
            raise TTSAdapterError("Nathan TTS daemon returned malformed audio") from exc
        return audio_bytes, duration_s

    def _request_batch(self, texts: list[str]) -> list[tuple[bytes, float]]:
        process = self._ensure_process()
        if process.stdin is None:
            raise TTSAdapterError("Nathan TTS daemon has no stdin")
        self._request_number += 1
        request_id = str(self._request_number)
        try:
            process.stdin.write(json.dumps({"id": request_id, "texts": texts}) + "\n")
            process.stdin.flush()
            payload = json.loads(self._readline(process, self.settings.tts_timeout_seconds))
        except (OSError, BrokenPipeError, json.JSONDecodeError) as exc:
            self._close_process()
            raise TTSAdapterError("Nathan TTS batch response was invalid") from exc
        if str(payload.get("id", "")) != request_id:
            self._close_process()
            raise TTSAdapterError("Nathan TTS batch response id did not match the request")
        if payload.get("event") == "error":
            self._close_process()
            detail = _compact_detail(str(payload.get("error", "unknown generation error")))
            raise TTSAdapterError(f"Nathan TTS batch generation failed: {detail}")
        items = payload.get("items")
        if payload.get("event") != "audio_batch" or not isinstance(items, list) or len(items) != len(texts):
            self._close_process()
            raise TTSAdapterError("Nathan TTS daemon returned no audio batch")
        decoded: list[tuple[bytes, float]] = []
        try:
            for item in items:
                if not isinstance(item, dict):
                    raise TypeError("invalid batch item")
                decoded.append(
                    (
                        base64.b64decode(str(item["audio_base64"]), validate=True),
                        float(item["duration_s"]),
                    )
                )
        except (KeyError, ValueError, TypeError) as exc:
            raise TTSAdapterError("Nathan TTS daemon returned malformed batch audio") from exc
        return decoded

    @staticmethod
    def _validate_wav(audio_bytes: bytes, duration_s: float) -> None:
        if not audio_bytes or duration_s <= 0:
            raise TTSAdapterError("Nathan TTS returned empty audio")
        try:
            with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
                frames = wav_file.getnframes()
                rate = wav_file.getframerate()
                if frames <= 0 or rate <= 0:
                    raise TTSAdapterError("Nathan TTS returned an empty WAV")
        except (OSError, wave.Error):
            raise TTSAdapterError("Nathan TTS returned malformed WAV") from None

    def prewarm(self, texts: list[str]) -> int:
        """Generate missing RAM-cache phrases in batches capped at two."""

        normalized = list(dict.fromkeys(" ".join(str(text).strip().split()) for text in texts))
        normalized = [text for text in normalized if text]
        with self._lock:
            missing = [text for text in normalized if text not in self._audio_cache]
            for index in range(0, len(missing), 2):
                batch = missing[index : index + 2]
                generated, _gpu = GpuMeter().run(lambda values=batch: self._request_batch(values))
                for text, (audio_bytes, duration_s) in zip(batch, generated, strict=True):
                    self._validate_wav(audio_bytes, duration_s)
                    self._audio_cache[text] = (audio_bytes, round(duration_s, 3))
                    self._audio_cache.move_to_end(text)
                    while len(self._audio_cache) > self._audio_cache_limit:
                        self._audio_cache.popitem(last=False)
        return len(missing)

    def synthesize(
        self,
        text: str,
        *,
        avatar_flush: bool = True,
        defer_avatar: bool = False,
    ) -> TTSResult:
        text = " ".join(text.strip().split())
        if not text:
            raise TTSAdapterError("TTS text is empty")
        if len(text) > 800:
            raise TTSAdapterError("TTS text is too long for the MVP")
        if not self.ready:
            raise TTSAdapterError("Existing Nathan TTS runtime or model is not available")
        started = time.perf_counter()
        with self._lock:
            cached = self._audio_cache.get(text)
            if cached is not None:
                self._audio_cache.move_to_end(text)
                audio_bytes, duration_s = cached
                return TTSResult(
                    audio_bytes=audio_bytes,
                    duration_s=duration_s,
                    elapsed_s=round(time.perf_counter() - started, 3),
                    gpu=unavailable_gpu_measurement(),
                    backend="local",
                )
            try:
                (audio_bytes, duration_s), gpu = GpuMeter().run(lambda: self._request(text))
            except TTSAdapterError:
                raise
            except subprocess.TimeoutExpired as exc:
                self._close_process()
                raise TTSAdapterError("Nathan TTS daemon timed out") from exc
            except Exception as exc:
                self._close_process()
                raise TTSAdapterError("Nathan TTS daemon request failed") from exc
        # Validate the in-memory WAV header and duration without persisting it.
        self._validate_wav(audio_bytes, duration_s)
        with self._lock:
            self._audio_cache[text] = (audio_bytes, round(duration_s, 3))
            self._audio_cache.move_to_end(text)
            while len(self._audio_cache) > self._audio_cache_limit:
                self._audio_cache.popitem(last=False)
        return TTSResult(
            audio_bytes=audio_bytes,
            duration_s=round(duration_s, 3),
            elapsed_s=round(time.perf_counter() - started, 3),
            gpu=gpu,
        )

    def shutdown(self) -> None:
        with self._lock:
            process = self._process
            if process is None:
                return
            try:
                if process.stdin and process.poll() is None:
                    process.stdin.write(json.dumps({"id": "shutdown", "command": "shutdown"}) + "\n")
                    process.stdin.flush()
                    self._readline(process, 2.0)
            except (OSError, TTSAdapterError, ValueError):
                pass
            finally:
                self._close_process()
