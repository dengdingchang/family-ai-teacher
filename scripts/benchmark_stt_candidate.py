"""Compare the existing base and small CPU ASR models on six cached RAM WAVs.

Requires a coordinated current TTS cache and a previous language A/B receipt.
No downloads, production changes, conversation calls, or saved audio.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
import gc
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import statistics
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchmark_stt_prompt import json_request


def memory_mib() -> dict:
    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in (
                "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    kernel = ctypes.WinDLL("kernel32")
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi")
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise OSError("Process memory measurement failed")
    return {"working_set_mib": round(counters.WorkingSetSize / 1048576, 2),
            "process_lifetime_peak_working_set_mib": round(counters.PeakWorkingSetSize / 1048576, 2),
            "private_usage_mib": round(counters.PrivateUsage / 1048576, 2)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-model", type=Path, required=True)
    parser.add_argument("--candidate-model", type=Path, required=True)
    parser.add_argument("--previous-receipt", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cached-fixtures-confirmed", action="store_true")
    args = parser.parse_args()
    if not args.cached_fixtures_confirmed:
        raise ValueError("Coordinate the current six cached fixtures first")
    if args.output.exists() or not all((path / "model.bin").is_file() for path in (args.baseline_model, args.candidate_model)):
        raise ValueError("Both existing model binaries and a new receipt path are required")
    previous = json.loads(args.previous_receipt.read_text(encoding="utf-8"))
    if len(previous["samples"]) != 6:
        raise ValueError("Exactly the six reviewed synthetic fixtures are required")
    health = json_request("/health")
    if health.get("tts_mode") != "streaming" or not 6 <= health.get("tts_cache_entries", 24) < 24:
        raise ValueError("Previously confirmed fixtures must remain in the unfilled cache")
    fixtures, samples = [], []
    for item in previous["samples"]:
        payload = json_request("/api/tts", {"text": item["expected"]})
        if payload.get("tts_backend") != "local-streaming-cache":
            raise ValueError("Fixture was not a cache hit; stop and report")
        audio = base64.b64decode(payload["audio_base64"], validate=True)
        digest = hashlib.sha256(audio).hexdigest()
        if digest != item["wav_sha256"]:
            raise ValueError("Fixture hash changed; do not silently compare different audio")
        fixtures.append(audio)
        samples.append({"expected": item["expected"], "wav_sha256": digest,
                        "duration_s": item["duration_s"], "fixture_backend": payload["tts_backend"], "runs": []})
    print(json.dumps({"stage": "six_fixtures_in_ram", "hashes_match_previous": True,
                      "tts_released": True, "new_gpu_inference": False}), flush=True)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from faster_whisper import WhisperModel
    common = {"language": "zh", "beam_size": 3, "vad_filter": True,
              "condition_on_previous_text": False, "initial_prompt": None}
    measurements = {}
    for variant, path in (("base", args.baseline_model), ("small", args.candidate_model)):
        started = time.perf_counter()
        model = WhisperModel(str(path), device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
        load_s = time.perf_counter() - started

        def transcribe(audio: bytes) -> dict:
            started, cpu_started = time.perf_counter(), time.process_time()
            with io.BytesIO(audio) as stream:
                segments, _ = model.transcribe(stream, **common)
                text = "".join(segment.text for segment in segments).strip()
            return {"variant": variant, "text": text, "elapsed_s": round(time.perf_counter() - started, 4),
                    "process_cpu_s": round(time.process_time() - cpu_started, 4)}

        warmup = transcribe(fixtures[0])
        for index, (sample, audio) in enumerate(zip(samples, fixtures)):
            run = transcribe(audio)
            sample["runs"].append(run)
            print(json.dumps({"sample": index + 1, **run}, ensure_ascii=True), flush=True)
        values = [sample["runs"][-1]["elapsed_s"] for sample in samples]
        measurements[variant] = {"model_path": str(path.resolve()), "model_bytes": (path / "model.bin").stat().st_size,
                                 "load_s": round(load_s, 4), "warmup_excluded": warmup,
                                 "mean_s": round(statistics.mean(values), 4), "median_s": round(statistics.median(values), 4),
                                 "memory_after_six_samples": memory_mib()}
        del model
        gc.collect()
    result = {"candidate_count": 1, "download_bytes": 0, "new_dependencies": [],
              "only_changed_factor": "existing model base versus small", "device": "cpu", "compute_type": "int8",
              "cpu_threads": 4, "common_parameters": common, "samples": samples, "measurements": measurements,
              "versions": {name: importlib.metadata.version(name) for name in ("faster-whisper", "ctranslate2", "av")},
              "raw_audio_saved": False, "production_modified": False, "service_restarted": False,
              "source_receipt": str(args.previous_receipt.resolve())}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    fixtures.clear()
    print(json.dumps({"receipt": str(args.output.resolve()), "measurements": measurements}, ensure_ascii=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
