"""Low latency adapter using the existing checkpoint in an isolated runtime."""

from __future__ import annotations

import base64
import io
import json
import subprocess
import threading
import time
import wave
from contextlib import contextmanager
from pathlib import Path

from audio.metrics import unavailable_gpu_measurement
from .adapter import TTSAdapterError, TTSResult
from .persistent import PersistentNathanTTSAdapter, _hidden_process_kwargs


def join_wav_chunks(chunks: list[bytes]) -> tuple[bytes, float]:
    """Join PCM frames, never concatenate individual RIFF file headers."""
    frames, parameters = [], None
    for chunk in chunks:
        try:
            with wave.open(io.BytesIO(chunk), "rb") as source:
                current = (source.getnchannels(), source.getsampwidth(), source.getframerate())
                if parameters is not None and current != parameters:
                    raise TTSAdapterError("Streaming voice changed audio format")
                parameters = current
                frames.append(source.readframes(source.getnframes()))
        except (wave.Error, EOFError) as exc:
            raise TTSAdapterError("Streaming voice returned invalid WAV") from exc
    if not parameters or not any(frames):
        raise TTSAdapterError("Streaming voice returned no audio")
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(parameters[0])
        target.setsampwidth(parameters[1])
        target.setframerate(parameters[2])
        target.writeframes(b"".join(frames))
    duration = sum(map(len, frames)) / (parameters[0] * parameters[1] * parameters[2])
    return output.getvalue(), duration


class StreamingNathanTTSAdapter(PersistentNathanTTSAdapter):
    """One serialized CUDA graph worker; streaming cancellation keeps it warm."""

    def __init__(self, settings, python_path: Path | None = None) -> None:
        super().__init__(settings)
        self.python_path = Path(python_path or getattr(settings, "tts_streaming_python", None) or
                                settings.project_root / "runtime/tts-streaming-probe-venv/Scripts/python.exe")
        self._cache_lock = threading.RLock()
        self._write_lock = threading.Lock()
        self.last_backend = "not_started"

    @property
    def ready(self) -> bool:
        return (self.python_path.is_file() and
                (self.settings.tts_model / "config.json").is_file() and
                self.settings.tts_ref_audio.is_file())

    def is_cached(self, text: str) -> bool:
        with self._cache_lock:
            return " ".join(str(text).strip().split()) in self._audio_cache

    @property
    def cache_entries(self) -> int:
        with self._cache_lock:
            return len(self._audio_cache)

    def _start_process(self):
        if not self.ready:
            raise TTSAdapterError("Existing isolated Nathan streaming runtime is unavailable")
        command = [str(self.python_path), str(self.settings.project_root / "tts/streaming_daemon.py"),
                   "--model", str(self.settings.tts_model),
                   "--ref-audio", str(self.settings.tts_ref_audio),
                   "--language", self.settings.tts_language]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                   errors="replace", bufsize=1, env=self._environment(),
                                   **_hidden_process_kwargs())
        self._process = process
        threading.Thread(target=self._collect_stderr, args=(process,), daemon=True).start()
        try:
            response = json.loads(self._readline(process, self.settings.tts_timeout_seconds))
            if response.get("event") != "ready":
                raise TTSAdapterError("Nathan streaming worker did not become ready")
        except Exception as exc:
            self._close_process()
            raise TTSAdapterError("Nathan streaming worker could not initialize") from exc
        return process

    def _send(self, process, payload: dict) -> None:
        with self._write_lock:
            if process.stdin is None:
                raise TTSAdapterError("Nathan streaming worker has no input")
            process.stdin.write(json.dumps(payload, ensure_ascii=True) + "\n")
            process.stdin.flush()

    @staticmethod
    def _check_cancelled(cancel_event) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise TTSAdapterError("Speech turn was cancelled")

    @contextmanager
    def _slot(self, cancel_event):
        self._check_cancelled(cancel_event)
        while not self._lock.acquire(timeout=0.05):
            self._check_cancelled(cancel_event)
        try:
            self._check_cancelled(cancel_event)
            yield
        finally:
            self._lock.release()

    def synthesize_stream(self, text: str, *, cancel_event=None, avatar_flush=True,
                          defer_avatar=False):
        clean = " ".join(text.strip().split())
        if not clean or len(clean) > 200:
            raise TTSAdapterError("Streaming voice expects a short sentence of 1 to 200 characters")
        self._check_cancelled(cancel_event)
        with self._cache_lock:
            cached = self._audio_cache.get(clean)
        if cached:
            yield self._result(cached[0], cached[1], 0.0, cached=True)
            return
        with self._slot(cancel_event):
            process = self._ensure_process()
            self._check_cancelled(cancel_event)
            self._request_number += 1
            request_id = str(self._request_number)
            self._send(process, {"id": request_id, "text": clean})
            terminal = False
            watcher_done = threading.Event()

            def watch_cancel() -> None:
                while not watcher_done.wait(0.03):
                    if cancel_event is not None and cancel_event.is_set():
                        try:
                            self._send(process, {"id": request_id, "command": "cancel"})
                        except (OSError, ValueError, TTSAdapterError):
                            pass
                        return

            watcher = threading.Thread(target=watch_cancel, name="voice-cancel", daemon=True)
            watcher.start()
            started, chunks = time.perf_counter(), []
            try:
                while True:
                    payload = json.loads(self._readline(process, self.settings.tts_timeout_seconds))
                    if str(payload.get("id")) != request_id:
                        raise TTSAdapterError("Nathan streaming response id did not match")
                    event = payload.get("event")
                    if event in {"done", "cancelled", "error"}:
                        terminal = True
                        if event == "error":
                            raise TTSAdapterError("Nathan streaming generation failed")
                        self._check_cancelled(cancel_event)
                        if event != "done" or payload.get("chunks") != len(chunks):
                            raise TTSAdapterError("Nathan streaming output was incomplete")
                        break
                    if event != "chunk" or payload.get("sequence") != len(chunks) + 1:
                        raise TTSAdapterError("Nathan streaming output sequence was invalid")
                    self._check_cancelled(cancel_event)
                    audio = base64.b64decode(payload["audio_base64"], validate=True)
                    duration = float(payload["duration_s"])
                    self._validate_wav(audio, duration)
                    chunks.append(audio)
                    yield self._result(audio, duration, time.perf_counter() - started)
                self._check_cancelled(cancel_event)
                complete = join_wav_chunks(chunks)
                with self._cache_lock:
                    self._audio_cache[clean] = complete
                    self._audio_cache.move_to_end(clean)
                    while len(self._audio_cache) > self._audio_cache_limit:
                        self._audio_cache.popitem(last=False)
            except (ValueError, KeyError, OSError) as exc:
                raise TTSAdapterError("Nathan streaming protocol failed") from exc
            finally:
                watcher_done.set()
                watcher.join(timeout=0.2)
                if not terminal and process.poll() is None:
                    # Drain the cancelled request before the next turn, retaining
                    # warm CUDA graphs and preventing stale audio crossing turns.
                    try:
                        self._send(process, {"id": request_id, "command": "cancel"})
                        deadline = time.monotonic() + 4
                        while time.monotonic() < deadline:
                            payload = json.loads(self._readline(process, 2))
                            if payload.get("event") in {"done", "cancelled", "error"}:
                                terminal = True
                                break
                    except (TTSAdapterError, OSError, ValueError):
                        pass
                    if not terminal:
                        self._close_process()

    def _result(self, audio: bytes, duration: float, elapsed: float, *, cached=False) -> TTSResult:
        self.last_backend = "local-streaming-cache" if cached else "local-streaming"
        return TTSResult(audio, round(duration, 4), round(elapsed, 4), unavailable_gpu_measurement(),
                         backend=self.last_backend)

    def synthesize(self, text: str, *, cancel_event=None, avatar_flush=True, defer_avatar=False) -> TTSResult:
        started = time.perf_counter()
        chunks = list(self.synthesize_stream(text, cancel_event=cancel_event,
                                            avatar_flush=avatar_flush, defer_avatar=defer_avatar))
        audio, duration = join_wav_chunks([chunk.audio_bytes for chunk in chunks])
        return self._result(audio, duration, time.perf_counter() - started,
                            cached=all(chunk.backend.endswith("-cache") for chunk in chunks))

    def synthesize_cancellable(self, text: str, *, cancel_event, **kwargs) -> TTSResult:
        return self.synthesize(text, cancel_event=cancel_event, **kwargs)

    def prewarm(self, texts: list[str]) -> int:
        warmed = 0
        for text in dict.fromkeys(texts):
            if text.strip() and not self.is_cached(text):
                self.synthesize(text)
                warmed += 1
        return warmed
