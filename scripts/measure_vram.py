"""Measure idle, static-avatar, CPU-STT, and existing-Nathan-TTS VRAM."""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path

from app.config import Settings
from audio.metrics import read_vram_used_mib
from stt.adapter import FasterWhisperCPUAdapter
from tts.adapter import NathanTTSAdapter


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", default="")
    args = parser.parse_args()
    settings = Settings.load()
    idle = read_vram_used_mib()
    # The avatar is SVG/CSS/browser-only; this is sampled before model calls.
    avatar_running = read_vram_used_mib()
    tts = NathanTTSAdapter(settings)
    stt = FasterWhisperCPUAdapter(settings)
    temp_path: Path | None = None
    try:
        if args.audio:
            audio_path = Path(args.audio)
            tts_result = None
        else:
            tts_result = tts.synthesize("你好，我是爸爸老师，今天我们一起学习吧。")
            handle = tempfile.NamedTemporaryFile(
                prefix="family-ai-teacher-vram-",
                suffix=".wav",
                dir=settings.temp_dir,
                delete=False,
            )
            temp_path = Path(handle.name)
            handle.write(tts_result.audio_bytes)
            handle.close()
            audio_path = temp_path
        stt_result = stt.transcribe(audio_path)
        tts_peak = tts_result.gpu.peak_mib if tts_result is not None else None
        stt_peak = stt_result.gpu.peak_mib
        peaks = [value for value in (tts_peak, stt_peak) if value is not None]
        payload = {
            "idle_mib": idle,
            "avatar_running_mib": avatar_running,
            "stt_peak_mib": stt_peak,
            "tts_peak_mib": tts_peak,
            "stt_plus_tts_sequential_peak_mib": max(peaks) if peaks else None,
            "max_mib": max([value for value in (idle, avatar_running, *peaks) if value is not None], default=None),
            "stt_elapsed_s": stt_result.elapsed_s,
            "tts_elapsed_s": tts_result.elapsed_s if tts_result is not None else None,
            "tts_audio_duration_s": tts_result.duration_s if tts_result is not None else None,
        }
        print(json.dumps(payload, ensure_ascii=True))
        return 0 if stt_result.text else 1
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
