"""One bounded resident-small-CUDA / existing-TTS overlap check; audio stays in RAM."""
from __future__ import annotations

import argparse
import base64
import contextlib
import gc
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import threading
import time
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark_stt_gpu as bench

NEW_TEXT = "我们一起找三块蓝色的积木，再看看哪一块最大。"
INDICES = (0, 1, 5)
SOURCE_RECEIPT = bench.ROOT / "runtime/stt-gpu-candidate-20260906.json"


def wav_payload(payload):
    audio = base64.b64decode(payload["audio_base64"], validate=True)
    if not (audio[:4] == b"RIFF" and audio[8:12] == b"WAVE" and 44 < len(audio) < 1024 * 1024):
        raise ValueError("Expected a nonempty, small RAM WAV")
    with wave.open(io.BytesIO(audio), "rb") as wav:
        frames, rate = wav.getnframes(), wav.getframerate()
        if frames <= 0 or rate <= 0:
            raise ValueError("The WAV has no audio frames")
    metadata = dict(sha256=hashlib.sha256(audio).hexdigest(), bytes=len(audio),
                    duration_s=round(frames / rate, 4), sample_rate=rate,
                    tts_backend=payload.get("tts_backend"), server_elapsed_s=payload.get("elapsed_s"))
    return audio, metadata


def worker(args):
    previous = json.loads(SOURCE_RECEIPT.read_text(encoding="utf-8"))
    if previous["status"] != "PASS":
        raise RuntimeError("The previous comparison must have passed")
    expected = {item["index"]: item for item in previous["events"] if item["kind"] == "fixture"}
    fixtures = {}
    bench.emit("stage", name="tts_fixtures")
    for index in INDICES:
        payload = bench.request_json(args.url, "/api/tts", {"text": bench.TEXTS[index]})
        audio, metadata = wav_payload(payload)
        if metadata["tts_backend"] != "local-streaming-cache" or metadata["sha256"] != expected[index]["sha256"]:
            raise RuntimeError("A requested fixture was not the byte-identical cached WAV")
        fixtures[index] = audio
        bench.emit("fixture", index=index, expected=bench.TEXTS[index], cache_verified=True, **metadata)
        del payload
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    ct2, inventory, dll_handles = bench.initialize_dependencies(args.dll_dir)
    with contextlib.redirect_stdout(sys.stderr):
        from faster_whisper import WhisperModel
    bench.emit("stage", name="gpu_load_requested")
    if json.loads(sys.stdin.readline()).get("permit") is not True:
        raise RuntimeError("CUDA load was not permitted")
    if "int8_float16" not in ct2.get_supported_compute_types("cuda"):
        raise RuntimeError("The required CUDA compute type is unavailable")
    bench.emit("stage", name="small_cuda_load")
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        model = WhisperModel(str(args.small_model), device="cuda", compute_type="int8_float16",
                             cpu_threads=4, local_files_only=True)
    if model.model.device != "cuda" or model.model.compute_type != "int8_float16":
        raise RuntimeError("The candidate device or actual compute type differed")
    bench.emit("loaded", variant="small_cuda", load_s=round(time.perf_counter() - started, 4),
               actual_device=model.model.device, actual_compute_type=model.model.compute_type,
               libraries=inventory(), memory=bench.memory_mib())
    bench.emit("stage", name="small_cuda_warmup")
    with contextlib.redirect_stdout(sys.stderr):
        warmup = bench.local_transcribe(model, fixtures[0])
    bench.emit("warmup", variant="small_cuda", result=warmup, libraries=inventory())

    # These monotonic intervals measure HTTP/client work, not CUDA kernel execution.
    tts_result, tts_started = {}, threading.Event()
    def synthesize_once():
        tts_result["request_start"] = time.perf_counter()
        tts_started.set()
        try:
            payload = bench.request_json(args.url, "/api/tts", {"text": NEW_TEXT}, timeout=120)
            tts_result["request_end"] = time.perf_counter()
            tts_result["audio"], tts_result["metadata"] = wav_payload(payload)
        except Exception as exc:
            tts_result["request_end"] = time.perf_counter()
            tts_result["error"] = str(exc)

    bench.emit("stage", name="coexistence_request")
    synthesis = threading.Thread(target=synthesize_once, daemon=True)
    synthesis.start()
    if not tts_started.wait(timeout=5):
        raise TimeoutError("The one TTS request did not start")
    samples = []
    for index in INDICES:
        start = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            result = bench.local_transcribe(model, fixtures[index])
        end = time.perf_counter()
        item = dict(index=index, start=start, end=end,
                    correct=bench.normalized(result["text"]) == bench.normalized(bench.TEXTS[index]), **result)
        samples.append(item)
        bench.emit("sample", variant="small_cuda", **item)
    synthesis.join(timeout=125)
    if synthesis.is_alive() or "error" in tts_result:
        raise RuntimeError(tts_result.get("error", "The one TTS request did not finish"))
    tts_audio = tts_result.pop("audio")
    bench.emit("tts_complete", expected=NEW_TEXT, **tts_result,
               http_wall_s=round(tts_result["request_end"] - tts_result["request_start"], 4))
    if tts_result["metadata"]["tts_backend"] != "local-streaming":
        raise RuntimeError("The new TTS sentence was not freshly synthesized")
    overlaps = [max(0.0, min(item["end"], tts_result["request_end"]) -
                    max(item["start"], tts_result["request_start"])) for item in samples]
    bench.emit("overlap", clock="time.perf_counter in one worker", seconds=overlaps,
               all_three_overlap=all(value > 0 for value in overlaps), kernel_overlap_proven=False)
    if not all(item["correct"] for item in samples) or not all(value > 0 for value in overlaps):
        raise RuntimeError("The three correct recognitions did not all overlap the TTS request")
    bench.emit("stage", name="new_tts_content_check")
    with contextlib.redirect_stdout(sys.stderr):
        confirmation = bench.local_transcribe(model, tts_audio)
    correct = bench.normalized(confirmation["text"]) == bench.normalized(NEW_TEXT)
    bench.emit("new_tts_content_check", expected=NEW_TEXT, correct=correct, **confirmation)
    if not correct:
        raise RuntimeError("The one recognition did not confirm all new TTS words")
    bench.emit("variant_complete", variant="small_cuda", libraries=inventory(), memory=bench.memory_mib())
    del model, tts_audio
    fixtures.clear()
    gc.collect()
    bench.emit("stage", name="worker_complete")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--small-model", type=Path, required=True)
    parser.add_argument("--dll-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--service-pid", type=int, required=True)
    parser.add_argument("--url", default="http://127.0.0.1:8760")
    parser.add_argument("--max-seconds", type=float, default=180)
    args = parser.parse_args()
    if args.url != "http://127.0.0.1:8760":
        raise ValueError("Only the existing loopback service is allowed")
    raise SystemExit(worker(args) if args.worker else bench.supervise(args, worker_script=Path(__file__).resolve()))
