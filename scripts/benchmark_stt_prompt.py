"""Bounded CPU A/B on three recently cached synthetic Nathan WAVs, kept in RAM.

Before opting in, coordinate with the fixture producer and confirm these exact
texts were cached by the current service without a subsequent restart/eviction.
The existing API has no cache-only lookup, so the opt-in is not a cache proof.
Never use this script to obtain new fixtures or pass microphone media to it.
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
import time
import urllib.request
import wave


TEXTS = ("我想画一只恐龙。", "为什么树叶在秋天会变黄？", "我想听一个恐龙故事。")
PROMPT = "以下是普通话日常对话，请用简体中文准确转写。"
BASE_URL = "http://127.0.0.1:8760"


def json_request(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(BASE_URL + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cached-fixtures-confirmed", action="store_true")
    args = parser.parse_args()
    if not args.cached_fixtures_confirmed:
        raise ValueError("First confirm the producer's current cache; no fixture request was sent")
    if not args.model.is_dir() or args.output.exists():
        raise ValueError("An existing local model and a new receipt path are required")
    health = json_request("/health")
    count = health.get("tts_cache_entries")
    if health.get("tts_mode") != "streaming" or not isinstance(count, int) or not 3 <= count < 24:
        raise ValueError("The audited non-evicted streaming cache precondition is not met")
    fixtures, samples = [], []
    for text in TEXTS:
        started = time.perf_counter()
        payload = json_request("/api/tts", {"text": text})
        if payload.get("tts_backend") != "local-streaming-cache":
            raise ValueError("The fixture was not cached; stop and report, never continue generating")
        audio = base64.b64decode(payload["audio_base64"], validate=True)
        with wave.open(io.BytesIO(audio), "rb") as wav:
            duration = wav.getnframes() / wav.getframerate()
            rate = wav.getframerate()
        fixtures.append(audio)
        samples.append({"expected": text, "wav_sha256": hashlib.sha256(audio).hexdigest(),
                        "duration_s": round(duration, 4), "sample_rate": rate,
                        "fixture_backend": payload["tts_backend"],
                        "cache_fetch_s": round(time.perf_counter() - started, 4), "runs": []})
    print(json.dumps({"stage": "all_fixtures_in_ram", "count": len(fixtures), "gpu_inference": False}), flush=True)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from faster_whisper import WhisperModel

    started = time.perf_counter()
    model = WhisperModel(str(args.model), device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
    load_s = time.perf_counter() - started
    common = {"language": "zh", "beam_size": 3, "vad_filter": True, "condition_on_previous_text": False}

    def transcribe(audio: bytes, initial_prompt: str | None) -> dict:
        started = time.perf_counter()
        with io.BytesIO(audio) as stream:
            segments, info = model.transcribe(stream, initial_prompt=initial_prompt, **common)
            text = "".join(segment.text for segment in segments).strip()
        return {"text": text, "elapsed_s": round(time.perf_counter() - started, 4), "language": info.language}

    # One same-fixture dry run initializes the existing VAD/CPU kernels. It is
    # explicitly excluded from comparison; this is not a fourth test sentence.
    warmup = transcribe(fixtures[0], None)
    for index, (sample, audio) in enumerate(zip(samples, fixtures)):
        order = ("baseline", "prompt") if index % 2 == 0 else ("prompt", "baseline")
        for variant in order:
            run = transcribe(audio, PROMPT if variant == "prompt" else None)
            run["variant"] = variant
            sample["runs"].append(run)
            print(json.dumps({"sample": index + 1, **run}, ensure_ascii=True), flush=True)
    timing = {}
    for variant in ("baseline", "prompt"):
        values = [run["elapsed_s"] for sample in samples for run in sample["runs"] if run["variant"] == variant]
        timing[variant] = {"median_s": round(statistics.median(values), 4),
                           "mean_s": round(statistics.mean(values), 4)}
    receipt = {"model_path": str(args.model.resolve()), "device": "cpu", "compute_type": "int8",
               "cpu_threads": 4, "model_load_s": round(load_s, 4), "common_parameters": common,
               "only_changed_parameter": "initial_prompt", "prompt": PROMPT,
               "warmup_excluded": warmup, "samples": samples, "timing": timing,
               "versions": {name: importlib.metadata.version(name) for name in ("faster-whisper", "ctranslate2", "av")},
               "raw_audio_saved": False, "browser_capture_reproduced": False,
               "production_modified": False, "new_models_installed": False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    fixtures.clear()
    print(json.dumps({"receipt": str(args.output.resolve()), "timing": timing}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
