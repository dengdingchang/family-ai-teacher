"""CPU language-selection A/B with three authorized new synthetic inputs.

Run only after coordinating TTS ownership. The earlier three Chinese fixtures
must still be cached, and the three new English/mixed fixtures may be generated.
No audio is saved, no conversation route is used, and no production is changed.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import statistics
import sys
import time
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchmark_stt_prompt import TEXTS as CHINESE_TEXTS, json_request


NEW_TEXTS = ("Apple", "I like dinosaurs", "我喜欢蓝色，blue")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--coordinated-fixtures", action="store_true")
    args = parser.parse_args()
    if not args.coordinated_fixtures:
        raise ValueError("Coordinate current Chinese cache and three new TTS requests first")
    if not args.model.is_dir() or args.output.exists():
        raise ValueError("An existing local model and a new receipt path are required")
    health = json_request("/health")
    if health.get("tts_mode") != "streaming" or not 3 <= health.get("tts_cache_entries", 24) < 24:
        raise ValueError("Previously confirmed Chinese fixtures must remain in the unfilled cache")
    fixtures, samples = [], []
    for index, text in enumerate((*CHINESE_TEXTS, *NEW_TEXTS)):
        started = time.perf_counter()
        payload = json_request("/api/tts", {"text": text})
        backend = payload.get("tts_backend")
        if index < 3 and backend != "local-streaming-cache":
            raise ValueError("The Chinese regression fixture was not cached; stop")
        if backend not in {"local-streaming", "local-streaming-cache"}:
            raise ValueError("Unexpected TTS backend")
        audio = base64.b64decode(payload["audio_base64"], validate=True)
        with wave.open(io.BytesIO(audio), "rb") as wav:
            duration = wav.getnframes() / wav.getframerate()
        fixtures.append(audio)
        samples.append({"expected": text, "group": "chinese_regression" if index < 3 else "english_mixed",
                        "wav_sha256": hashlib.sha256(audio).hexdigest(), "duration_s": round(duration, 4),
                        "fixture_backend": backend, "fixture_elapsed_s": round(time.perf_counter() - started, 4),
                        "runs": []})
    print(json.dumps({"stage": "fixtures_in_ram", "cached_regression_count": 3, "new_fixture_count": 3}), flush=True)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from faster_whisper import WhisperModel

    started = time.perf_counter()
    model = WhisperModel(str(args.model), device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
    load_s = time.perf_counter() - started
    common = {"beam_size": 3, "vad_filter": True, "condition_on_previous_text": False, "initial_prompt": None}

    def transcribe(audio: bytes, language: str | None) -> dict:
        started = time.perf_counter()
        with io.BytesIO(audio) as stream:
            segments, info = model.transcribe(stream, language=language, **common)
            text = "".join(segment.text for segment in segments).strip()
        return {"text": text, "elapsed_s": round(time.perf_counter() - started, 4), "language": info.language,
                "language_probability": round(float(info.language_probability), 4)}

    warmup = transcribe(fixtures[0], "zh")
    for index, (sample, audio) in enumerate(zip(samples, fixtures)):
        for variant in (("zh", "auto") if index % 2 == 0 else ("auto", "zh")):
            run = transcribe(audio, None if variant == "auto" else "zh")
            run["variant"] = variant
            sample["runs"].append(run)
            print(json.dumps({"sample": index + 1, **run}, ensure_ascii=True), flush=True)
    timing = {}
    for group in ("chinese_regression", "english_mixed"):
        timing[group] = {}
        for variant in ("zh", "auto"):
            values = [run["elapsed_s"] for sample in samples if sample["group"] == group
                      for run in sample["runs"] if run["variant"] == variant]
            timing[group][variant] = {"median_s": round(statistics.median(values), 4),
                                      "mean_s": round(statistics.mean(values), 4)}
    receipt = {"model_path": str(args.model.resolve()), "device": "cpu", "compute_type": "int8", "cpu_threads": 4,
               "model_load_s": round(load_s, 4), "common_parameters": common, "only_changed_parameter": "language",
               "warmup_excluded": warmup, "samples": samples, "timing": timing,
               "versions": {name: importlib.metadata.version(name) for name in ("faster-whisper", "ctranslate2", "av")},
               "raw_audio_saved": False, "browser_capture_reproduced": False, "production_modified": False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    fixtures.clear()
    print(json.dumps({"receipt": str(args.output.resolve()), "timing": timing}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
