"""One supervised six-fixture ASR comparison; audio stays in worker RAM."""
from __future__ import annotations

import argparse
import base64
import contextlib
import ctypes
from datetime import datetime, timezone
import gc
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import statistics
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
TEXTS = ("我想画一只恐龙。", "为什么树叶在秋天会变黄？", "我想听一个恐龙故事。",
         "Apple", "I like dinosaurs", "我喜欢蓝色，blue。")
COMMON = dict(language="zh", beam_size=3, vad_filter=True, condition_on_previous_text=False, initial_prompt=None)
HIDDEN = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchmark_stt_candidate import memory_mib


def emit(kind, **data):
    print(json.dumps({"kind": kind, **data}, ensure_ascii=True), flush=True)


def request_json(base, path, data=None, content_type="application/json", timeout=120):
    if isinstance(data, dict):
        data = json.dumps(data, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": content_type})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def normalized(text):
    # Scoring only: keep raw outputs; Windows conversion is best-effort.
    # Inspect mismatches manually (e.g. Windows retains 麽 in 什麼).
    if not text:
        return ""
    convert = ctypes.WinDLL("kernel32").LCMapStringEx
    convert.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.c_int,
                        ctypes.c_wchar_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_longlong]
    output = ctypes.create_unicode_buffer(len(text) * 2 + 4)
    if not convert("zh-CN", 0x02000000, text, len(text), output, len(output), None, None, 0):
        raise ctypes.WinError()
    return "".join(char for char in unicodedata.normalize("NFKC", output.value).casefold() if char.isalnum())


def initialize_dependencies(directory):
    # Reuse the successful, preserved byte/path validation rather than inventing another loader.
    path = ROOT / "runtime/stt-cuda-dependency-probe-omnivoice.py"
    spec = importlib.util.spec_from_file_location("verified_stt_dependencies", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    main = (Path(sys.executable).parent / "Lib/site-packages/ctranslate2/cudnn64_9.dll").resolve()
    digest = module.sha256(directory / "cudnn64_9.dll")
    if module.sha256(main) != digest:
        raise RuntimeError("The selected cuDNN main DLL is not byte-identical")
    handles = [os.add_dll_directory(str(directory))]
    os.environ["PATH"] = str(directory) + os.pathsep + os.environ.get("PATH", "")
    import ctranslate2
    for name in ("cudnn_ops64_9.dll", "cudnn_adv64_9.dll", "cudnn_cnn64_9.dll", "cudnn_graph64_9.dll",
                 "cudnn_heuristic64_9.dll", "cudnn_engines_precompiled64_9.dll", "cudnn_engines_runtime_compiled64_9.dll"):
        handles.append(ctypes.WinDLL(str(directory / name)))
    def inventory():
        libraries = module.helpers.loaded_libraries()
        module.verify_modules(libraries, directory, main, digest, module.helpers.file_version(main), complete=True)
        return libraries
    emit("dependencies", main_sha256=digest, libraries=inventory())
    return ctranslate2, inventory, handles


def local_transcribe(model, audio):
    started, cpu_started = time.perf_counter(), time.process_time()
    with io.BytesIO(audio) as stream:
        segments, info = model.transcribe(stream, **COMMON)
        text = "".join(segment.text for segment in segments).strip()
    return dict(text=text, elapsed_s=round(time.perf_counter() - started, 4),
                process_cpu_s=round(time.process_time() - cpu_started, 4), language=info.language)


def worker(args):
    fixtures = []
    emit("stage", name="tts_fixtures")
    for index, expected in enumerate(TEXTS):
        started = time.perf_counter()
        payload = request_json(args.url, "/api/tts", {"text": expected})
        audio = base64.b64decode(payload["audio_base64"], validate=True)
        if not (audio[:4] == b"RIFF" and audio[8:12] == b"WAVE" and len(audio) < 1024 * 1024):
            raise ValueError("Expected a small RAM WAV below multipart spool threshold")
        with wave.open(io.BytesIO(audio), "rb") as wav:
            duration, sample_rate = wav.getnframes() / wav.getframerate(), wav.getframerate()
        fixtures.append(audio)
        emit("fixture", index=index, expected=expected, sha256=hashlib.sha256(audio).hexdigest(),
             bytes=len(audio), duration_s=round(duration, 4), sample_rate=sample_rate,
             tts_backend=payload.get("tts_backend"), fetch_s=round(time.perf_counter() - started, 4))
        del payload
    emit("stage", name="base_cpu_api", fixtures_complete=True, additional_tts_calls=False)
    def baseline(audio):
        boundary = "family-asr-synthetic-benchmark"
        data = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"synthetic.wav\"\r\n"
                "Content-Type: audio/wav\r\n\r\n").encode() + audio + f"\r\n--{boundary}--\r\n".encode()
        started = time.perf_counter()
        value = request_json(args.url, "/api/transcribe", data, f"multipart/form-data; boundary={boundary}", timeout=130)
        return dict(text=value["text"], elapsed_s=value["elapsed_s"],
                    http_wall_s=round(time.perf_counter() - started, 4), language=value["language"])
    emit("warmup", variant="base_cpu_api", result=baseline(fixtures[0]))
    for index, audio in enumerate(fixtures):
        result = baseline(audio)
        emit("sample", variant="base_cpu_api", index=index, correct=normalized(result["text"]) == normalized(TEXTS[index]), **result)
    emit("stage", name="small_cpu_load")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    ct2, inventory, dll_handles = initialize_dependencies(args.dll_dir)
    with contextlib.redirect_stdout(sys.stderr):
        from faster_whisper import WhisperModel
    emit("versions", versions={name: importlib.metadata.version(name) for name in ("faster-whisper", "ctranslate2", "av")})
    for device in ("cpu", "cuda"):
        variant = f"small_{device}"
        if device == "cuda":
            emit("stage", name="gpu_load_requested", cpu_model_released=True, memory=memory_mib())
            if json.loads(sys.stdin.readline()).get("permit") is not True:
                raise RuntimeError("GPU load was not permitted by the supervising parent")
        requested = "int8"
        if device == "cuda":
            types = sorted(ct2.get_supported_compute_types("cuda"))
            if requested not in types:
                if "int8_float16" not in types:
                    raise RuntimeError("Neither int8 nor int8_float16 is supported")
                requested = "int8_float16"
            emit("compute_types", supported=types, requested=requested)
        emit("stage", name=f"{variant}_load")
        started = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            model = WhisperModel(str(args.small_model), device=device, compute_type=requested,
                                 cpu_threads=4, local_files_only=True)
        if model.model.device != device:
            raise RuntimeError("The model did not use the requested device")
        emit("loaded", variant=variant, load_s=round(time.perf_counter() - started, 4),
             actual_device=model.model.device, requested_compute_type=requested,
             actual_compute_type=model.model.compute_type, memory=memory_mib(), libraries=inventory())
        emit("stage", name=f"{variant}_warmup")
        with contextlib.redirect_stdout(sys.stderr):
            result = local_transcribe(model, fixtures[0])
        emit("warmup", variant=variant, result=result, libraries=inventory())
        emit("stage", name=f"{variant}_samples")
        for index, audio in enumerate(fixtures):
            with contextlib.redirect_stdout(sys.stderr):
                result = local_transcribe(model, audio)
            emit("sample", variant=variant, index=index,
                 correct=normalized(result["text"]) == normalized(TEXTS[index]), **result)
        emit("variant_complete", variant=variant, memory=memory_mib(), libraries=inventory())
        del model
        gc.collect()
    fixtures.clear()
    emit("stage", name="worker_complete")


def file_hash(path):
    return {"exists": path.is_file(), "bytes": path.stat().st_size if path.is_file() else 0,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None}


def family_hashes():
    return {name: file_hash(ROOT / "data" / name) for name in ("session_history.jsonl", "learning_events.jsonl")}


def gpu_sample():
    output = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits", "-i", "0"], text=True, timeout=3, **HIDDEN)
    total, used, free = map(int, output.strip().split(","))
    return {"at_monotonic": time.monotonic(), "total_mib": total, "used_mib": used, "free_mib": free}


def service_identity(pid):
    command = f"Get-Process -Id {int(pid)} -ErrorAction Stop | Select-Object Id,StartTime,ProcessName | ConvertTo-Json -Compress"
    return json.loads(subprocess.check_output(["powershell", "-NoProfile", "-Command", command],
                                              text=True, timeout=10, **HIDDEN))


def stop_owned(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def supervise(args, worker_script=None):
    if args.output.exists():
        raise ValueError("Use a new receipt path; failures must be preserved")
    result = {"started_at": datetime.now(timezone.utc).isoformat(), "status": "FAIL", "events": [],
              "raw_audio_saved": False, "base64_saved": False, "production_modified": False,
              "candidate_model": str(args.small_model), "python": sys.executable,
              "common_parameters": COMMON, "cpu_threads": 4, "gpu_samples": [],
              "gpu_limits": {"load_free_mib": 3072, "sampled_minimum_free_mib": 1024},
              "latency_note": "base elapsed includes adapter/IPC; small CPU/CUDA use identical direct-model wall timing"}
    process, errors, messages = None, [], queue.Queue()
    gpu_active, stage, started = False, "preflight", time.monotonic()
    try:
        result["service_before"] = service_identity(args.service_pid)
        result["family_before"] = family_hashes()
        result["gpu_before"] = gpu_sample()
        result["health_before"] = request_json(args.url, "/health", timeout=10)
        if result["gpu_before"]["free_mib"] < 3072:
            raise RuntimeError("Less than 3 GiB is free before the benchmark")
        if not (args.small_model / "model.bin").is_file():
            raise ValueError("The existing small model is missing")
        command = [sys.executable, "-E", "-s", str(worker_script or Path(__file__).resolve()), "--worker",
                   "--small-model", str(args.small_model), "--dll-dir", str(args.dll_dir),
                   "--url", args.url, "--service-pid", str(args.service_pid), "--output", str(args.output)]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", bufsize=1, **HIDDEN)
        result["owned_worker_pid"] = process.pid
        stdout_done = threading.Event()
        def read_messages():
            try:
                for line in process.stdout:
                    messages.put(json.loads(line))
            finally:
                stdout_done.set()
        def read_errors():
            for line in process.stderr:
                errors.append(line[-1500:])
                del errors[:-20]
        threading.Thread(target=read_messages, daemon=True).start()
        threading.Thread(target=read_errors, daemon=True).start()
        next_sample = 0.0
        while process.poll() is None or not stdout_done.is_set() or not messages.empty():
            if time.monotonic() - started > args.max_seconds:
                raise TimeoutError("The bounded benchmark exceeded its total deadline")
            try:
                event = messages.get(timeout=.05)
                result["events"].append(event)
                if event["kind"] == "stage":
                    stage = event["name"]
                    print(json.dumps(event), flush=True)
                    if stage == "gpu_load_requested":
                        sample = gpu_sample()
                        result["gpu_load_gate"] = sample
                        if sample["free_mib"] < 3072:
                            raise RuntimeError("Less than 3 GiB is free at the CUDA load gate")
                        gpu_active = True
                        process.stdin.write('{"permit":true}\n')
                        process.stdin.flush()
                elif event["kind"] in {"sample", "loaded"}:
                    print(json.dumps({key: value for key, value in event.items() if key not in {"libraries", "memory"}}), flush=True)
            except queue.Empty:
                pass
            if gpu_active and time.monotonic() >= next_sample:
                sample = {**gpu_sample(), "stage": stage}
                result["gpu_samples"].append(sample)
                if sample["free_mib"] < 1024:
                    raise RuntimeError("Sampled free GPU memory dropped below 1 GiB")
                next_sample = time.monotonic() + .25
        process.wait(timeout=5)
        result["worker_exit_code"] = process.returncode
        if process.returncode != 0 or stage != "worker_complete":
            raise RuntimeError("The benchmark worker did not complete all stages")
        result["status"] = "PASS"
    except Exception as exc:
        result["error"] = {"type": type(exc).__name__, "message": str(exc), "stage": stage,
                           "production_http_may_continue": stage in {"tts_fixtures", "base_cpu_api", "coexistence_request"}}
    finally:
        result["worker_stop_requested"] = bool(process and process.poll() is None)
        try:
            stop_owned(process)
        except Exception as exc:
            result["cleanup_error"] = str(exc)
            result["status"] = "FAIL"
        if process:
            result["worker_exit_code"] = process.poll()
        result["stderr_tail"] = "".join(errors)[-5000:]
        try:
            result["family_after"] = family_hashes()
            result["family_unchanged"] = result.get("family_before") == result["family_after"]
        except Exception as exc:
            result["family_postcheck_error"] = str(exc)
            result["family_unchanged"] = False
        try:
            result["service_after"] = service_identity(args.service_pid)
            result["service_unchanged"] = result.get("service_before") == result["service_after"]
            result["gpu_after_worker_exit"] = gpu_sample()
            result["health_after_worker_exit"] = request_json(args.url, "/health", timeout=10)
        except Exception as exc:
            result["postcheck_error"] = str(exc)
            result["status"] = "FAIL"
        if not result["family_unchanged"] or not result.get("service_unchanged"):
            result["status"] = "FAIL"
        result["summary"] = {}
        for variant in ("base_cpu_api", "small_cpu", "small_cuda"):
            samples = [item for item in result["events"] if item.get("kind") == "sample" and item.get("variant") == variant]
            if samples:
                result["summary"][variant] = {"count": len(samples), "correct": sum(item["correct"] for item in samples),
                    "mean_s": round(statistics.mean(item["elapsed_s"] for item in samples), 4),
                    "median_s": round(statistics.median(item["elapsed_s"] for item in samples), 4)}
        if result["gpu_samples"]:
            result["gpu_sampled_peak_used_mib"] = max(item["used_mib"] for item in result["gpu_samples"])
            result["gpu_sampled_min_free_mib"] = min(item["free_mib"] for item in result["gpu_samples"])
            result["gpu_peak_is_sampled_not_instantaneous"] = True
        result["finished_at"] = datetime.now(timezone.utc).isoformat()
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({key: result.get(key) for key in ("status", "summary", "error", "family_unchanged", "service_unchanged",
            "gpu_sampled_peak_used_mib", "gpu_sampled_min_free_mib")}), flush=True)
    return 0 if result["status"] == "PASS" else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--small-model", type=Path, required=True)
    parser.add_argument("--dll-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--service-pid", type=int, required=True)
    parser.add_argument("--url", default="http://127.0.0.1:8760")
    parser.add_argument("--max-seconds", type=float, default=300)
    arguments = parser.parse_args()
    if arguments.url != "http://127.0.0.1:8760":
        raise ValueError("This bounded benchmark only targets the existing loopback application")
    raise SystemExit(worker(arguments) if arguments.worker else supervise(arguments))
