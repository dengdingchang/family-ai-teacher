"""One supervised three-fixture CPU ASR comparison; synthetic WAVs stay in RAM."""
from __future__ import annotations

import argparse
import base64
import contextlib
import ctypes
from datetime import datetime, timezone
import gc
import hashlib
import http.client
import io
import json
import math
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unicodedata
import wave

ROOT = Path(__file__).resolve().parents[1]
TEXTS = ("我喜欢蓝色，blue。", "我想要黄色，yellow。", "I like blue")
COMMON = dict(language="zh", beam_size=3, vad_filter=True,
              condition_on_previous_text=False, initial_prompt=None, word_timestamps=False)
HTTP_TIMEOUT_S = 30
MIN_FREE_MIB = 4096


class ProbeFailure(RuntimeError):
    """Only fixed codes cross the error/receipt boundary."""


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def finite(value):
    return round(float(value), 6) if isinstance(value, (int, float)) and math.isfinite(value) else None


def checkpoint(path, result):
    """Replace only this run's exclusively reserved receipt, never an old run."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".asr-receipt-", suffix=".json", delete=False) as output:
            temporary = Path(output.name)
            json.dump(result, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def family_hashes():
    result = {}
    for name in ("session_history.jsonl", "learning_events.jsonl"):
        path, digest, size = ROOT / "data" / name, hashlib.sha256(), 0
        with path.open("rb") as source:
            while block := source.read(1024 * 1024):
                digest.update(block)
                size += len(block)
        result[name] = {"bytes": size, "sha256": digest.hexdigest()}
    return result


def request_json(path, payload=None, content_type="application/json"):
    # A socket timeout alone is per operation. This watchdog also closes a
    # slowly streaming response at the total 30-second request deadline.
    connection = http.client.HTTPConnection("127.0.0.1", 8760, timeout=HTTP_TIMEOUT_S)
    expired, active_socket = threading.Event(), []
    body = b""

    def expire():
        expired.set()
        for stream in active_socket:
            if stream is None:
                continue
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()

    watchdog = threading.Timer(HTTP_TIMEOUT_S, expire)
    watchdog.daemon = True
    try:
        if isinstance(payload, dict):
            payload = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        watchdog.start()
        connection.connect()
        active_socket.append(connection.sock)
        if expired.is_set():
            raise ProbeFailure("http_timeout")
        connection.request("POST" if payload is not None else "GET", path, body=payload,
                           headers={"Content-Type": content_type})
        response = connection.getresponse()
        if response.status != 200:
            raise ProbeFailure("http_non_success")
        body = response.read(2 * 1024 * 1024 + 1)
        if expired.is_set():
            raise ProbeFailure("http_timeout")
        if len(body) > 2 * 1024 * 1024:
            raise ProbeFailure("http_response_too_large")
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ProbeFailure("invalid_http_payload")
        return value
    except ProbeFailure:
        raise
    except (socket.timeout, TimeoutError):
        raise ProbeFailure("http_timeout") from None
    except Exception:
        raise ProbeFailure("http_timeout" if expired.is_set() else "http_request_failed") from None
    finally:
        watchdog.cancel()
        connection.close()
        active_socket.clear()
        body = b""
        payload = None


def health_snapshot():
    value = request_json("/health")
    runtime = value.get("stt_runtime") or {}
    if not isinstance(runtime, dict):
        raise ProbeFailure("invalid_health_payload")
    def selected(source, key, choices):
        candidate = source.get(key)
        return candidate if candidate in choices else "not_reported"
    # Never retain the complete health payload or any endpoint/profile fields.
    return {
        "status": selected(value, "status", ("ok",)),
        "stt_ready": value.get("stt_ready") is True,
        "tts_ready": value.get("tts_ready") is True,
        "tts_warmup": selected(value, "tts_warmup", ("ready", "warming", "failed", "retrying", "retry_wait")),
        "tts_mode": selected(value, "tts_mode", ("streaming", "persistent", "remote_preferred")),
        "stt_runtime": {
            "backend": selected(runtime, "backend", ("faster-whisper",)),
            "status": selected(runtime, "status", ("ready", "starting", "stopped", "failed", "not_started")),
            "device": selected(runtime, "device", ("cpu", "cuda")),
            "requested_device": selected(runtime, "requested_device", ("cpu", "cuda")),
            "compute_type": selected(runtime, "compute_type", ("int8", "int8_float16", "int8_float32", "float16", "float32")),
            "model_role": selected(runtime, "model_role", ("primary", "fallback")),
            "fallback_present": runtime.get("fallback_reason") is not None,
        },
    }


def require_production(health):
    runtime = health["stt_runtime"]
    if (health["status"] != "ok" or health["tts_mode"] != "streaming"
            or runtime["backend"] != "faster-whisper"
            or not health["stt_ready"] or not health["tts_ready"]
            or health["tts_warmup"] != "ready" or runtime["status"] != "ready"
            or runtime["device"] != "cuda" or runtime["requested_device"] != "cuda"
            or runtime["compute_type"] != "int8_float16" or runtime["fallback_present"]
            or runtime["model_role"] == "fallback"):
        raise ProbeFailure("production_cuda_not_ready")


def normalized(text):
    """Scoring only: NFKC, case, punctuation/space and Windows traditional forms."""
    text = unicodedata.normalize("NFKC", text)
    if os.name != "nt":
        raise ProbeFailure("windows_normalization_unavailable")
    convert = ctypes.WinDLL("kernel32").LCMapStringEx
    convert.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.c_int,
                        ctypes.c_wchar_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_longlong]
    output = ctypes.create_unicode_buffer(len(text) * 2 + 4)
    if text and not convert("zh-CN", 0x02000000, text, len(text), output, len(output), None, None, 0):
        raise ProbeFailure("normalization_failed")
    return "".join(character for character in output.value.casefold() if character.isalnum())


def available_memory_mib():
    if os.name != "nt":
        raise ProbeFailure("windows_memory_check_unavailable")
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
            (name, ctypes.c_ulonglong) for name in ("total_physical", "available_physical",
                "total_pagefile", "available_pagefile", "total_virtual", "available_virtual", "extended_virtual")]
    value = MemoryStatus()
    value.length = ctypes.sizeof(value)
    query = ctypes.WinDLL("kernel32", use_last_error=True).GlobalMemoryStatusEx
    query.argtypes = [ctypes.POINTER(MemoryStatus)]
    query.restype = ctypes.c_int
    if not query(ctypes.byref(value)):
        raise ProbeFailure("physical_memory_check_failed")
    return round(value.available_physical / 1048576, 2)


def wav_fixture(payload):
    try:
        audio = base64.b64decode(payload["audio_base64"], validate=True)
        # Stay below the server multipart spool threshold as well as RAM limits.
        if not 44 < len(audio) < 1024 * 1024 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
            raise ProbeFailure("invalid_synthetic_wav")
        with wave.open(io.BytesIO(audio), "rb") as stream:
            duration = stream.getnframes() / stream.getframerate()
            sample_rate = stream.getframerate()
        backend = payload.get("tts_backend")
        if backend not in ("local-streaming", "local-streaming-cache"):
            raise ProbeFailure("unexpected_tts_backend")
        return audio, {"sha256": hashlib.sha256(audio).hexdigest(), "bytes": len(audio),
                       "duration_s": round(duration, 4), "sample_rate": sample_rate, "backend": backend}
    except ProbeFailure:
        raise
    except Exception:
        raise ProbeFailure("invalid_synthetic_wav") from None
    finally:
        payload.clear()


def production_transcribe(audio):
    boundary = "family-mixed-asr-synthetic"
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="synthetic.wav"\r\n'
            'Content-Type: audio/wav\r\n\r\n').encode() + audio + f"\r\n--{boundary}--\r\n".encode()
    started = time.perf_counter()
    try:
        value = request_json("/api/transcribe", body, f"multipart/form-data; boundary={boundary}")
        if not isinstance(value.get("text"), str) or len(value["text"]) > 2000:
            raise ProbeFailure("invalid_transcript_payload")
        return {"text": value["text"], "elapsed_s": finite(value.get("elapsed_s")),
                "http_wall_s": round(time.perf_counter() - started, 4)}
    finally:
        body = b""


def cpu_transcribe(model, audio):
    started, cpu_started = time.perf_counter(), time.process_time()
    segments, parts, diagnostics = None, [], []
    try:
        with io.BytesIO(audio) as stream:
            segments, info = model.transcribe(stream, **COMMON)
            for segment in segments:
                parts.append(segment.text)
                diagnostics.append({key: finite(getattr(segment, key, None)) for key in
                                    ("start", "end", "avg_logprob", "no_speech_prob", "compression_ratio")})
        return {"text": "".join(parts).strip(), "elapsed_s": round(time.perf_counter() - started, 4),
                "process_cpu_s": round(time.process_time() - cpu_started, 4), "segments": diagnostics}
    finally:
        if segments is not None and callable(getattr(segments, "close", None)):
            segments.close()
        parts.clear()


def run(args):
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive reservation happens before health/API/model work.
    with args.output.open("x", encoding="utf-8") as reserved:
        reserved.write('{"status":"FAIL","stage":"reserved","completed":false}\n')
    result = {"status": "FAIL", "completed": False, "started_at": utc_now(), "stage": "preflight",
              "fixtures": [], "production": [], "cpu_variants": [], "candidate_status": "NOT RUN",
              "common_parameters": COMMON, "cpu_threads": 4, "http_timeout_s": HTTP_TIMEOUT_S,
              "raw_audio_saved": False, "audio_base64_saved": False, "production_modified": False,
              "model_identity_note": "Health model_role may be not_reported; the operator must separately verify the production model path.",
              "timing_note": "Production elapsed includes adapter/IPC; CPU values are direct model wall time. Segment diagnostics are reported without new confidence thresholds."}
    fixtures, model, proposed_status = [], None, "FAIL"

    def stage(name):
        result["stage"] = name
        checkpoint(args.output, result)
        print(json.dumps({"stage": name, "candidate_status": result["candidate_status"]}), flush=True)

    try:
        stage("preflight")
        result["family_before"] = family_hashes()
        result["health_before"] = health_snapshot()
        require_production(result["health_before"])
        for index, text in enumerate(TEXTS):
            stage(f"tts_fixture_{index + 1}")
            started = time.perf_counter()
            audio, metadata = wav_fixture(request_json("/api/tts", {"text": text}))
            fixtures.append(audio)
            result["fixtures"].append({"index": index, "expected": text, **metadata,
                                       "http_wall_s": round(time.perf_counter() - started, 4)})
            audio = b""
        for index, audio in enumerate(fixtures):
            stage(f"production_sample_{index + 1}")
            item = production_transcribe(audio)
            item.update(index=index, correct=normalized(item["text"]) == normalized(TEXTS[index]))
            result["production"].append(item)
        audio = b""
        stage("production_verified")
        result["health_after_production"] = health_snapshot()
        require_production(result["health_after_production"])
        if result["health_after_production"] != result["health_before"]:
            raise ProbeFailure("production_health_changed")
        if all(item["correct"] for item in result["production"]):
            result["candidate_reason"] = "production_mismatch_not_reproduced"
            proposed_status = "PASS"
        else:
            # No downloads, CUDA candidates, helper imports or process launches.
            os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", CUDA_VISIBLE_DEVICES="")
            for role, path in (("small_cpu", args.baseline_model), ("medium_cpu", args.candidate_model)):
                stage(f"{role}_admission")
                memory = available_memory_mib()
                result.setdefault("memory_admission", []).append({"variant": role, "available_mib": memory, "required_mib": MIN_FREE_MIB})
                if memory < MIN_FREE_MIB:
                    result["candidate_reason"] = "insufficient_available_physical_memory"
                    proposed_status = "NOT RUN"
                    break
                if not path.is_dir() or not (path / "model.bin").is_file():
                    raise ProbeFailure("existing_cpu_model_missing")
                measurement = {"variant": role, "model_path": str(path.resolve()), "requested_device": "cpu",
                               "requested_compute_type": "int8", "samples": []}
                result["cpu_variants"].append(measurement)
                stage(f"{role}_load")
                with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                    from faster_whisper import WhisperModel
                    started = time.perf_counter()
                    model = WhisperModel(str(path.resolve()), device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
                measurement.update(load_s=round(time.perf_counter() - started, 4),
                                   actual_device=str(model.model.device), actual_compute_type=str(model.model.compute_type))
                if measurement["actual_device"] != "cpu":
                    raise ProbeFailure("unexpected_candidate_device")
                if role == "medium_cpu":
                    result["candidate_status"] = "RUNNING"
                stage(f"{role}_warmup")
                with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                    measurement["warmup_excluded"] = cpu_transcribe(model, fixtures[0])
                for index, audio in enumerate(fixtures):
                    stage(f"{role}_sample_{index + 1}")
                    with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                        item = cpu_transcribe(model, audio)
                    item.update(index=index, correct=normalized(item["text"]) == normalized(TEXTS[index]))
                    measurement["samples"].append(item)
                measurement["correct_count"] = sum(item["correct"] for item in measurement["samples"])
                model = None
                audio = b""
                gc.collect()
                stage(f"{role}_complete")
            else:
                result["candidate_status"] = "COMPLETE"
                proposed_status = "PASS"
    except BaseException as exc:
        result["error"] = {"stage": result["stage"], "code": str(exc) if isinstance(exc, ProbeFailure) else "probe_execution_failed",
                           "type": type(exc).__name__}
        if isinstance(exc, ProbeFailure) and str(exc).startswith("http_"):
            result["production_request_may_continue"] = True
        if result["candidate_status"] == "RUNNING":
            result["candidate_status"] = "FAIL"
    finally:
        model = None
        audio = b""
        fixtures.clear()
        gc.collect()
        stage("postcheck")
        try:
            result["family_after"] = family_hashes()
            result["family_unchanged"] = result.get("family_before") == result["family_after"]
        except Exception:
            result["family_unchanged"] = False
            result["family_postcheck_error"] = "family_hash_check_failed"
        try:
            result["health_after"] = health_snapshot()
            require_production(result["health_after"])
            result["production_health_unchanged"] = result.get("health_before") == result["health_after"]
        except Exception:
            result["production_health_unchanged"] = False
            result["health_postcheck_error"] = "production_health_check_failed"
        result["status"] = proposed_status if result.get("family_unchanged") and result.get("production_health_unchanged") and not result.get("error") else "FAIL"
        result.update(stage="finished", completed=True, finished_at=utc_now(),
                      production_correct_count=sum(item["correct"] for item in result["production"]))
        checkpoint(args.output, result)
        print(json.dumps({key: result.get(key) for key in ("status", "candidate_status", "candidate_reason", "production_correct_count", "error", "family_unchanged", "production_health_unchanged")}), flush=True)
    return 0 if result["status"] == "PASS" else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-model", type=Path, required=True)
    parser.add_argument("--candidate-model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        return run(args)
    except FileExistsError:
        print('{"status":"FAIL","error":"output_exists_preserved"}', flush=True)
        return 2
    except Exception:
        print('{"status":"FAIL","error":"receipt_write_failed"}', flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
