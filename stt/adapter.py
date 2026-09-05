"""CPU-first local STT adapter using the existing faster-whisper installation."""

from __future__ import annotations

import atexit
import base64
import json
import math
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from app.config import Settings
from audio.metrics import GpuMeasurement, unavailable_gpu_measurement


class STTAdapterError(RuntimeError):
    pass


class _CudaWorkerError(STTAdapterError):
    """Internal signal: retry in a fresh CPU worker, never expose diagnostics."""


_FALLBACK_REASONS = {
    "tts_not_ready", "cuda_dependencies_invalid", "cuda_capacity_unavailable",
    "insufficient_vram", "cuda_start_failed", "cuda_worker_stopped", "cuda_inference_failed",
}


@dataclass(frozen=True)
class STTResult:
    text: str
    language: str
    duration_s: float
    elapsed_s: float
    gpu: GpuMeasurement


def _hidden_process_kwargs() -> dict:
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


def _stderr_tail(stderr: str, limit: int = 280) -> str:
    """Keep actionable worker diagnostics without returning a large traceback."""

    compact = " ".join(line.strip() for line in stderr.splitlines() if line.strip())
    return compact[-limit:]


class FasterWhisperCPUAdapter:
    def __init__(self, settings: Settings, *, cuda_start_allowed=None) -> None:
        self.settings = settings
        self.worker = settings.project_root / "stt" / "daemon.py"
        self._process: subprocess.Popen[str] | None = None
        self._responses: queue.Queue = queue.Queue()
        self._lock = threading.RLock()
        self._request_number = 0
        self._shutdown_requested = threading.Event()
        self._cuda_start_allowed = cuda_start_allowed or (lambda: True)
        self._cuda_disabled_reason: str | None = None
        self._runtime = {"backend": "faster-whisper", "status": "not_started",
                         "device": None, "compute_type": None, "fallback_reason": None}
        atexit.register(self.shutdown)

    @property
    def runtime_status(self) -> dict:
        status = dict(self._runtime)
        status["requested_device"] = getattr(self.settings, "stt_device", "cpu")
        status["fallback_reason"] = self._cuda_disabled_reason
        process = self._process
        if status["status"] == "ready" and (process is None or process.poll() is not None):
            status["status"] = "stopped"
        return status

    @property
    def ready(self) -> bool:
        return self.settings.stt_ready and self.worker.is_file()

    def transcribe(self, audio_path: Path, *, cancel_event=None) -> STTResult:
        self._check_cancelled(cancel_event)
        audio_path = Path(audio_path)
        if not audio_path.is_file():
            raise STTAdapterError("STT audio input is missing")
        if not self.ready:
            raise STTAdapterError("Existing faster-whisper CPU runtime or model is not available")

        normalized_path: Path | None = None
        input_path = audio_path
        if audio_path.suffix.lower() in {".webm", ".weba", ".ogg", ".opus", ".m4a", ".mp4"}:
            input_path, normalized_path = self._normalize_browser_audio(audio_path)

        try:
            return self.transcribe_bytes(input_path.read_bytes(), cancel_event=cancel_event)
        except OSError as exc:
            raise STTAdapterError("STT audio input could not be read") from exc
        finally:
            if normalized_path is not None:
                try:
                    normalized_path.unlink(missing_ok=True)
                except OSError:
                    pass

    def _start_process(self, cancel_event=None) -> subprocess.Popen[str]:
        self._check_cancelled(cancel_event)
        if not self.ready:
            raise STTAdapterError("Existing faster-whisper runtime or model is not available")
        requested = getattr(self.settings, "stt_device", "cpu")
        if requested == "cuda" and self._cuda_disabled_reason is None:
            if not self._cuda_start_allowed():
                self._disable_cuda("tts_not_ready")
            else:
                try:
                    return self._launch_process("cuda", self.settings.stt_model_path,
                                                self.settings.stt_compute_type)
                except STTAdapterError:
                    self._check_cancelled(cancel_event)
                    self._disable_cuda(self._cuda_disabled_reason or "cuda_start_failed")
        self._check_cancelled(cancel_event)
        if requested == "cuda":
            fallback = getattr(self.settings, "stt_fallback_model_path", None)
            if fallback is None or not Path(fallback).is_dir():
                self._runtime["status"] = "failed"
                raise STTAdapterError("STT CPU fallback model is not available")
            return self._launch_process("cpu", fallback, "int8")
        return self._launch_process("cpu", self.settings.stt_model_path, self.settings.stt_compute_type)

    def _disable_cuda(self, reason: str) -> None:
        self._cuda_disabled_reason = reason if reason in _FALLBACK_REASONS else "cuda_start_failed"
        self._close_process()

    def _launch_process(self, device: str, model_path: Path, compute_type: str) -> subprocess.Popen[str]:
        self._runtime.update(status="starting", device=None, compute_type=None)
        command = [
            str(self.settings.stt_python),
            "-E",
            "-s",
            str(self.worker),
            "--model",
            str(model_path),
            "--language",
            self.settings.stt_language,
            "--compute-type",
            compute_type,
            "--device", device,
        ]
        if device == "cuda":
            command.extend(["--cuda-library-dir", str(getattr(self.settings, "stt_cuda_library_dir", None) or "")])
        environment = os.environ.copy()
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        environment["PYTHONUTF8"] = "1"
        environment["PYTHONIOENCODING"] = "utf-8"
        environment["HF_HUB_OFFLINE"] = "1"
        environment["TRANSFORMERS_OFFLINE"] = "1"
        try:
            process = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace",
                env=environment, bufsize=1, **_hidden_process_kwargs(),
            )
        except OSError as exc:
            self._runtime["status"] = "failed"
            raise STTAdapterError("STT worker could not start") from exc
        self._process = process
        responses: queue.Queue = queue.Queue()
        self._responses = responses

        def read_output() -> None:
            try:
                for line in process.stdout:
                    responses.put(json.loads(line))
            except (OSError, ValueError, TypeError):
                pass
            finally:
                responses.put(None)

        threading.Thread(target=read_output, name="stt-response", daemon=True).start()
        try:
            payload = self._next_payload(30)
            if payload.get("event") != "ready":
                if device == "cuda":
                    reason = payload.get("reason")
                    self._cuda_disabled_reason = reason if reason in _FALLBACK_REASONS else "cuda_start_failed"
                raise STTAdapterError("STT worker did not become ready")
            # Older CPU workers did not include device metadata.
            actual_device = payload.get("device", device)
            actual_compute = payload.get("compute_type", compute_type)
            if actual_device != device or actual_compute not in {"int8", "int8_float16", "int8_float32", "float16", "float32"}:
                raise STTAdapterError("STT worker returned invalid runtime metadata")
            self._runtime.update(status="ready", device=actual_device, compute_type=actual_compute)
        except STTAdapterError:
            self._runtime["status"] = "failed"
            self._close_process()
            raise
        return process

    def _next_payload(self, timeout: float) -> dict:
        try:
            payload = self._responses.get(timeout=timeout)
        except queue.Empty as exc:
            raise STTAdapterError("STT timed out") from exc
        if not isinstance(payload, dict):
            raise STTAdapterError("STT worker stopped before returning a result")
        return payload

    def _ensure_process(self, cancel_event=None) -> subprocess.Popen[str]:
        if self._process is None or self._process.poll() is not None:
            if self._process is not None and self._runtime["device"] == "cuda":
                self._disable_cuda("cuda_worker_stopped")
            self._close_process()
            return self._start_process(cancel_event)
        return self._process

    def _send(self, process, payload: dict) -> None:
        if process.stdin is None:
            raise STTAdapterError("STT worker has no input")
        try:
            process.stdin.write(json.dumps(payload, ensure_ascii=True) + "\n")
            process.stdin.flush()
        except (OSError, ValueError) as exc:
            was_cuda = self._runtime["device"] == "cuda"
            self._close_process()
            if was_cuda:
                raise _CudaWorkerError("cuda_worker_stopped") from exc
            raise STTAdapterError("STT worker input failed") from exc

    def _check_cancelled(self, cancel_event=None) -> None:
        if self._shutdown_requested.is_set() or (cancel_event is not None and cancel_event.is_set()):
            raise STTAdapterError("Speech recognition was cancelled")

    def warmup(self) -> None:
        self._check_cancelled()
        with self._lock:
            self._ensure_process()

    def transcribe_bytes(self, audio: bytes, *, cancel_event=None) -> STTResult:
        """Decode an in-memory WAV/container; the worker never saves audio."""
        if not audio or len(audio) > 16 * 1024 * 1024:
            raise STTAdapterError("STT audio input is empty or too large")
        self._check_cancelled(cancel_event)
        started = time.perf_counter()
        while not self._lock.acquire(timeout=0.05):
            self._check_cancelled(cancel_event)
        try:
            for attempt in range(2):
                try:
                    return self._transcribe_request(audio, cancel_event, started)
                except _CudaWorkerError as exc:
                    self._check_cancelled(cancel_event)
                    if attempt or self._cuda_disabled_reason is not None:
                        raise STTAdapterError("STT worker stopped before returning a result") from None
                    self._disable_cuda(str(exc))
        finally:
            self._lock.release()

    def _transcribe_request(self, audio: bytes, cancel_event, started: float) -> STTResult:
        # Caller holds the lock across a possible GPU -> CPU retry. A new
        # process owns a new response queue and a new request id.
        process = None
        terminal = False
        try:
            self._check_cancelled(cancel_event)
            process = self._ensure_process(cancel_event)
            self._check_cancelled(cancel_event)
            self._request_number += 1
            request_id = str(self._request_number)
            self._send(process, {"id": request_id, "audio_base64": base64.b64encode(audio).decode("ascii")})
            deadline = time.monotonic() + 120
            cancelled = False
            while True:
                if (self._shutdown_requested.is_set() or (cancel_event is not None and cancel_event.is_set())) and not cancelled:
                    self._send(process, {"id": request_id, "command": "cancel"})
                    cancelled = True
                    deadline = min(deadline, time.monotonic() + 3)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    if not cancelled and self._runtime["device"] == "cuda":
                        raise _CudaWorkerError("cuda_inference_failed")
                    raise STTAdapterError("Speech recognition was cancelled" if cancelled else "STT timed out")
                try:
                    payload = self._responses.get(timeout=min(.05, remaining))
                except queue.Empty:
                    continue
                if payload is None and self._runtime["device"] == "cuda":
                    raise _CudaWorkerError("cuda_worker_stopped")
                if not isinstance(payload, dict) or str(payload.get("id")) != request_id:
                    raise STTAdapterError("STT worker returned an invalid response")
                terminal = payload.get("event") in {"transcript", "cancelled", "error"}
                self._check_cancelled(cancel_event)
                if payload.get("event") == "error":
                    if self._runtime["device"] == "cuda" and payload.get("retry_on_cpu") is True:
                        raise _CudaWorkerError("cuda_inference_failed")
                    raise STTAdapterError("STT could not decode this audio")
                if payload.get("event") != "transcript":
                    raise STTAdapterError("STT worker returned no transcript")
                duration = float(payload.get("duration_s", 0))
                if not math.isfinite(duration) or duration < 0:
                    raise STTAdapterError("STT worker returned invalid audio duration")
                return STTResult(str(payload.get("text", "")).strip(),
                                 str(payload.get("language", self.settings.stt_language)), duration,
                                 round(time.perf_counter() - started, 3), unavailable_gpu_measurement())
        except (ValueError, TypeError) as exc:
            raise STTAdapterError("STT returned a malformed result") from exc
        finally:
            if process is not None and not terminal:
                self._close_process()

    def _close_process(self) -> None:
        process, self._process = self._process, None
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=3)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            try:
                process.kill()
                process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def shutdown(self) -> None:
        self._shutdown_requested.set()
        with self._lock:
            self._close_process()

    def _normalize_browser_audio(self, audio_path: Path) -> tuple[Path, Path]:
        """Convert browser containers to a conservative mono PCM WAV for faster-whisper."""

        ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
        handle = tempfile.NamedTemporaryFile(
            prefix="family-ai-teacher-stt-normalized-",
            suffix=".wav",
            dir=self.settings.temp_dir,
            delete=False,
        )
        output_path = Path(handle.name)
        handle.close()
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(audio_path),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                check=False,
                **_hidden_process_kwargs(),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            output_path.unlink(missing_ok=True)
            raise STTAdapterError("STT browser-audio conversion failed") from exc
        if completed.returncode != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
            detail = _stderr_tail(completed.stderr)
            output_path.unlink(missing_ok=True)
            suffix = f": {detail}" if detail else ""
            raise STTAdapterError(f"STT browser-audio conversion failed{suffix}")
        return output_path, output_path
