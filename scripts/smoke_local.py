"""Run real local TTS -> STT checks without calling the LLM."""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

from app.config import Settings
from stt.adapter import FasterWhisperCPUAdapter
from tts.adapter import NathanTTSAdapter


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", default="")
    args = parser.parse_args()
    settings = Settings.load()
    tts = NathanTTSAdapter(settings)
    stt = FasterWhisperCPUAdapter(settings)
    text = "你好，我是爸爸老师，今天我们一起学习吧。"
    output_path: Path | None = None
    try:
        if args.audio:
            audio_path = Path(args.audio)
            tts_result = None
        else:
            tts_result = tts.synthesize(text)
            handle = tempfile.NamedTemporaryFile(
                prefix="family-ai-teacher-smoke-",
                suffix=".wav",
                dir=settings.temp_dir,
                delete=False,
            )
            output_path = Path(handle.name)
            handle.write(tts_result.audio_bytes)
            handle.close()
            audio_path = output_path
        stt_result = stt.transcribe(audio_path)
        payload = {
            "tts": "PASS" if tts_result is not None else "SKIPPED_EXTERNAL_AUDIO",
            "stt": "PASS" if stt_result.text else "FAIL_EMPTY_TEXT",
            "stt_text": stt_result.text,
            "stt_audio_duration_s": stt_result.duration_s,
            "stt_elapsed_s": stt_result.elapsed_s,
            "stt_gpu_peak_mib": stt_result.gpu.peak_mib,
        }
        if tts_result is not None:
            payload.update(
                {
                    "tts_audio_duration_s": tts_result.duration_s,
                    "tts_elapsed_s": tts_result.elapsed_s,
                    "tts_gpu_peak_mib": tts_result.gpu.peak_mib,
                }
            )
        print(json.dumps(payload, ensure_ascii=True))
        return 0 if payload["stt"] == "PASS" else 1
    finally:
        if output_path is not None:
            output_path.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
