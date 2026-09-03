"""Adapter for the already-installed Nathan Qwen3-TTS clone runtime."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import wave
from dataclasses import dataclass
from pathlib import Path

from app.config import Settings
from audio.metrics import GpuMeasurement, GpuMeter


class TTSAdapterError(RuntimeError):
    pass


@dataclass(frozen=True)
class TTSResult:
    audio_bytes: bytes
    duration_s: float
    elapsed_s: float
    gpu: GpuMeasurement


def _hidden_process_kwargs() -> dict:
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


class NathanTTSAdapter:
    """Run qwen3_clone.py as a short-lived subprocess; no model is copied here."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def ready(self) -> bool:
        return self.settings.tts_ready

    def _reference_text(self) -> str:
        if self.settings.tts_ref_text:
            return self.settings.tts_ref_text
        try:
            payload = json.loads(self.settings.tts_ref_text_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise TTSAdapterError("TTS reference text file cannot be read") from exc
        if isinstance(payload, list):
            for item in payload:
                if item.get("name") == "neutral_zh_v2" and item.get("ref_text"):
                    return str(item["ref_text"])
        raise TTSAdapterError("Chinese Nathan reference text was not found")

    def synthesize(self, text: str) -> TTSResult:
        text = " ".join(text.strip().split())
        if not text:
            raise TTSAdapterError("TTS text is empty")
        if len(text) > 800:
            raise TTSAdapterError("TTS text is too long for the MVP")
        if not self.ready:
            raise TTSAdapterError("Existing Nathan TTS runtime or model is not available")

        output_handle = tempfile.NamedTemporaryFile(
            prefix="family-ai-teacher-",
            suffix=".wav",
            dir=self.settings.temp_dir,
            delete=False,
        )
        output_path = Path(output_handle.name)
        output_handle.close()
        command = [
            str(self.settings.tts_python),
            str(self.settings.tts_runner),
            "--model",
            str(self.settings.tts_model),
            "--ref-audio",
            str(self.settings.tts_ref_audio),
            "--ref-text",
            self._reference_text(),
            "--text",
            text,
            "--output",
            str(output_path),
            "--language",
            self.settings.tts_language,
            "--dtype",
            self.settings.tts_dtype,
        ]
        environment = os.environ.copy()
        # Prevent the shared OmniVoice .pth/PYTHONPATH from changing this adapter's import route.
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        environment.pop("PYTHONSTARTUP", None)
        environment["PYTHONUTF8"] = "1"
        environment["PYTHONIOENCODING"] = "utf-8"
        started = time.perf_counter()

        def run() -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.settings.tts_timeout_seconds,
                env=environment,
                check=False,
                **_hidden_process_kwargs(),
            )

        try:
            completed, gpu = GpuMeter().run(run)
            elapsed = round(time.perf_counter() - started, 3)
            if completed.returncode != 0:
                raise TTSAdapterError(f"Nathan TTS exited with code {completed.returncode}")
            audio_bytes = output_path.read_bytes()
            with wave.open(str(output_path), "rb") as wav_file:
                frames = wav_file.getnframes()
                rate = wav_file.getframerate()
            duration_s = round(frames / rate, 3) if rate else 0.0
            if not audio_bytes or duration_s <= 0:
                raise TTSAdapterError("Nathan TTS returned an empty audio file")
            return TTSResult(
                audio_bytes=audio_bytes,
                duration_s=duration_s,
                elapsed_s=elapsed,
                gpu=gpu,
            )
        except subprocess.TimeoutExpired as exc:
            raise TTSAdapterError("Nathan TTS timed out") from exc
        except OSError as exc:
            raise TTSAdapterError("Nathan TTS output could not be read") from exc
        finally:
            try:
                output_path.unlink(missing_ok=True)
            except OSError:
                pass
