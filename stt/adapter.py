"""CPU-first local STT adapter using the existing faster-whisper installation."""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from app.config import Settings
from audio.metrics import GpuMeasurement, GpuMeter


class STTAdapterError(RuntimeError):
    pass


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


class FasterWhisperCPUAdapter:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.worker = settings.project_root / "stt" / "worker.py"

    @property
    def ready(self) -> bool:
        return self.settings.stt_ready and self.worker.is_file()

    def transcribe(self, audio_path: Path) -> STTResult:
        audio_path = Path(audio_path)
        if not audio_path.is_file():
            raise STTAdapterError("STT audio input is missing")
        if not self.ready:
            raise STTAdapterError("Existing faster-whisper CPU runtime or model is not available")

        command = [
            str(self.settings.stt_python),
            "-E",
            "-s",
            str(self.worker),
            "--audio",
            str(audio_path),
            "--model",
            str(self.settings.stt_model_path),
            "--language",
            self.settings.stt_language,
            "--compute-type",
            self.settings.stt_compute_type,
        ]
        environment = os.environ.copy()
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        environment["PYTHONUTF8"] = "1"
        environment["PYTHONIOENCODING"] = "utf-8"
        environment["HF_HUB_OFFLINE"] = "1"
        environment["TRANSFORMERS_OFFLINE"] = "1"
        started = time.perf_counter()

        def run() -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                env=environment,
                check=False,
                **_hidden_process_kwargs(),
            )

        try:
            completed, gpu = GpuMeter().run(run)
        except subprocess.TimeoutExpired as exc:
            raise STTAdapterError("STT timed out") from exc
        elapsed_s = round(time.perf_counter() - started, 3)
        if completed.returncode != 0:
            raise STTAdapterError(f"STT exited with code {completed.returncode}")
        records = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
        try:
            payload = json.loads(records[-1])
        except (IndexError, json.JSONDecodeError) as exc:
            raise STTAdapterError("STT returned no readable result") from exc
        return STTResult(
            text=str(payload.get("text", "")).strip(),
            language=str(payload.get("language", self.settings.stt_language)),
            duration_s=float(payload.get("duration_s", 0.0)),
            elapsed_s=elapsed_s,
            gpu=gpu,
        )
