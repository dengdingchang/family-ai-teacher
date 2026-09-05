"""Three separately invoked local STT deployment checks; synthetic audio stays in RAM."""
from __future__ import annotations

import argparse
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark_stt_gpu as bench
from qa_stt_tts_coexistence import wav_payload

RECOVERY_TEXT = "我们明天还可以一起画彩色的小飞机。"


def require_gpu_health(value):
    runtime = value.get("stt_runtime") or {}
    if (value.get("status") != "ok" or not value.get("stt_ready")
            or runtime.get("status") != "ready" or runtime.get("device") != "cuda"
            or runtime.get("compute_type") != "int8_float16"):
        raise RuntimeError("Production STT is not ready on CUDA int8_float16")


def equivalent(left, right):
    # Windows retains the equivalent 麽 variant after traditional conversion.
    # This changes scoring only; original transcripts are always retained.
    return bench.normalized(left).replace("麽", "么") == bench.normalized(right).replace("麽", "么")


def synthesize(args, result, text, *, cached):
    item = {"text": text, "tts_request_start": time.perf_counter()}
    result["samples"].append(item)
    result["production_http_may_continue"] = True
    payload = bench.request_json(args.url, "/api/tts", {"text": text}, timeout=70)
    result["production_http_may_continue"] = False
    item["tts_request_end"] = time.perf_counter()
    item["tts_http_wall_s"] = round(item["tts_request_end"] - item["tts_request_start"], 4)
    audio, metadata = wav_payload(payload)
    item["wav"] = metadata
    expected_backend = "local-streaming-cache" if cached else "local-streaming"
    if metadata["tts_backend"] != expected_backend:
        raise RuntimeError(f"Expected TTS backend {expected_backend}")
    return audio, item


def transcribe_api(args, result, audio, item):
    boundary = "family-stt-deployment-synthetic"
    data = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"synthetic.wav\"\r\n"
            "Content-Type: audio/wav\r\n\r\n").encode() + audio + f"\r\n--{boundary}--\r\n".encode()
    item["asr_request_start"] = time.perf_counter()
    result["production_http_may_continue"] = True
    payload = bench.request_json(args.url, "/api/transcribe", data,
                                 f"multipart/form-data; boundary={boundary}", timeout=70)
    result["production_http_may_continue"] = False
    item["asr_request_end"] = time.perf_counter()
    item["asr_http_wall_s"] = round(item["asr_request_end"] - item["asr_request_start"], 4)
    item["transcript"] = {key: payload.get(key) for key in ("text", "language", "audio_duration_s", "elapsed_s")}
    item["correct"] = equivalent(str(payload.get("text", "")), item["text"])
    if not item["correct"]:
        raise RuntimeError("The production transcript did not confirm the complete synthetic sentence")


def cpu_fallback(args, result):
    audio, item = synthesize(args, result, bench.TEXTS[1], cached=True)
    # Importing config and adapter alone does not initialize app.main or MemoryStore.
    sys.path.insert(0, str(bench.ROOT))
    from app.config import Settings
    from stt.adapter import FasterWhisperCPUAdapter
    missing = bench.ROOT / "runtime" / f"qa-missing-cuda-{uuid.uuid4().hex}"
    if missing.exists():
        raise RuntimeError("The injected invalid DLL directory unexpectedly exists")
    configured = Settings.load()
    fallback = configured.stt_fallback_model_path
    if fallback is None or not (fallback / "model.bin").is_file():
        raise RuntimeError("The explicitly configured CPU fallback model is missing")
    candidate = replace(configured, stt_device="cuda", stt_cuda_library_dir=missing)
    adapter = FasterWhisperCPUAdapter(candidate, cuda_start_allowed=lambda: True)
    result["injected_cuda_directory_exists"] = False
    result["configured_fallback_model"] = str(fallback)
    try:
        started = time.perf_counter()
        adapter.warmup()
        item["fallback_warmup_s"] = round(time.perf_counter() - started, 4)
        item["fallback_runtime"] = adapter.runtime_status
        if not (item["fallback_runtime"].get("device") == "cpu"
                and item["fallback_runtime"].get("status") == "ready"
                and item["fallback_runtime"].get("fallback_reason") == "cuda_dependencies_invalid"):
            raise RuntimeError("The invalid CUDA directory did not produce a ready CPU fallback")
        started = time.perf_counter()
        recognition = adapter.transcribe_bytes(audio)
        item["asr_wall_s"] = round(time.perf_counter() - started, 4)
        item["transcript"] = {"text": recognition.text, "language": recognition.language,
                              "audio_duration_s": recognition.duration_s, "elapsed_s": recognition.elapsed_s}
        item["cpu_usability_confirmed"] = bool(recognition.text.strip())
        if not item["cpu_usability_confirmed"]:
            raise RuntimeError("CPU fallback returned no text")
    finally:
        process = adapter._process
        adapter.shutdown()
        result["owned_cpu_worker_exited"] = process is None or process.poll() is not None
        if not result["owned_cpu_worker_exited"]:
            raise RuntimeError("The owned CPU worker did not exit")


def run(args):
    if args.output.exists():
        raise ValueError("Use a new receipt path; never replace an earlier result")
    result = {"stage": args.stage, "started_at": datetime.now(timezone.utc).isoformat(),
              "status": "FAIL", "samples": [], "raw_audio_saved": False, "base64_saved": False,
              "production_http_may_continue": False, "production_configuration_changed": False,
              "measurement_note": "Fresh deployment fixtures, not an old-WAV A/B. Cold TTS recovery additionally requires the operator's external worker-stop/restart evidence."}
    try:
        result["family_before"] = bench.family_hashes()
        if not all(item["exists"] for item in result["family_before"].values()):
            raise RuntimeError("A required family data file is missing before the check")
        result["service_before"] = bench.service_identity(args.service_pid)
        result["gpu_before"] = bench.gpu_sample()
        result["health_before"] = bench.request_json(args.url, "/health", timeout=10)
        require_gpu_health(result["health_before"])
        if args.stage == "cpu-fallback":
            cpu_fallback(args, result)
        else:
            texts = [RECOVERY_TEXT] if args.stage == "tts-recovery" else [bench.TEXTS[index] for index in (0, 1, 5)]
            for text in texts:
                audio, item = synthesize(args, result, text, cached=False)
                transcribe_api(args, result, audio, item)
                del audio
        result["status"] = "PASS"
    except Exception as exc:
        result["error"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        try:
            result["family_after"] = bench.family_hashes()
            result["family_unchanged"] = result.get("family_before") == result["family_after"]
        except Exception as exc:
            result["family_unchanged"] = False
            result["family_postcheck_error"] = str(exc)
        try:
            result["service_after"] = bench.service_identity(args.service_pid)
            result["service_unchanged"] = result.get("service_before") == result["service_after"]
            result["gpu_after"] = bench.gpu_sample()
            result["health_after"] = bench.request_json(args.url, "/health", timeout=10)
            require_gpu_health(result["health_after"])
            if not result["health_after"].get("tts_ready"):
                raise RuntimeError("Production TTS is unavailable after the check")
        except Exception as exc:
            result["postcheck_error"] = str(exc)
            result["status"] = "FAIL"
        if not result.get("family_unchanged") or not result.get("service_unchanged"):
            result["status"] = "FAIL"
        result["finished_at"] = datetime.now(timezone.utc).isoformat()
        with args.output.open("x", encoding="utf-8") as target:
            json.dump(result, target, ensure_ascii=False, indent=2)
            target.write("\n")
        print(json.dumps({key: result.get(key) for key in
              ("stage", "status", "error", "postcheck_error", "family_unchanged", "service_unchanged")}), flush=True)
    return 0 if result["status"] == "PASS" else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=("startup", "tts-recovery", "cpu-fallback"), required=True)
    parser.add_argument("--service-pid", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--url", default="http://127.0.0.1:8760")
    args = parser.parse_args()
    if args.url != "http://127.0.0.1:8760":
        raise ValueError("Only the existing loopback application is allowed")
    raise SystemExit(run(args))
