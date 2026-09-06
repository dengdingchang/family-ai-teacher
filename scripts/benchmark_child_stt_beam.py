"""Bounded beam 3/5 comparison on three fixed synthetic RAM WAVs, never child audio."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import statistics
import threading
import time
import unicodedata
import urllib.request

TEXTS = ("我还没有找到红色的东西。", "我想要黄色，不是蓝色。", "我喜欢蓝色，blue。")


def normalize(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold()
                   if unicodedata.category(c)[0] in "LN")


def edit_distance(expected, actual):
    previous = list(range(len(actual) + 1))
    for row, left in enumerate(expected, 1):
        current = [row]
        for column, right in enumerate(actual, 1):
            current.append(min(current[-1] + 1, previous[column] + 1,
                               previous[column - 1] + (left != right)))
        previous = current
    return previous[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    if args.output.exists() or not (args.model / "model.bin").is_file():
        raise ValueError("An existing model and a new receipt path are required")
    if not 1 <= args.timeout <= 120:
        raise ValueError("Deadline must be at most 120 seconds")
    started = time.perf_counter()
    deadline = started + args.timeout
    result = {"status": "RUNNING", "pid": os.getpid(), "samples": [], "tts_calls": 0,
              "only_changed_parameter": "beam_size", "model": str(args.model.resolve()),
              "device": "cpu", "compute_type": "int8", "cpu_threads": 4,
              "common_parameters": {"language": "zh", "vad_filter": True,
                                    "condition_on_previous_text": False, "initial_prompt": None},
              "normalization": "Unicode NFKC, casefold, retain letters and numbers; no semantic substitutions",
              "raw_audio_saved": False, "production_modified": False,
              "boundary": "Three fixed adult synthetic sentences; not child speech accuracy"}
    lock = threading.RLock()

    def save():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        result["wall_s"] = round(time.perf_counter() - started, 4)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    def timeout():
        with lock:
            result["status"] = "TIMEOUT"
            save()
        os._exit(124)

    timer = threading.Timer(args.timeout, timeout)
    timer.daemon = True
    timer.start()

    def request(path, body=None):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request("http://127.0.0.1:8760" + path, data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=min(35, max(.1, deadline - time.perf_counter()))) as response:
            return json.load(response)

    fixtures = []
    try:
        # Confirm the dedicated existing ASR runtime before spending any of the
        # three fixture requests. The general TTS Python lacks faster_whisper.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        from faster_whisper import WhisperModel
        health = request("/health")
        if not (health.get("tts_mode") == "streaming" and health.get("tts_ready")
                and health.get("tts_warmup") == "ready"):
            raise RuntimeError("TTS is not streaming/ready; no fixture requested")
        for text in TEXTS:
            result["tts_calls"] += 1
            payload = request("/api/tts", {"text": text})
            audio = base64.b64decode(payload["audio_base64"], validate=True)
            fixtures.append(audio)
            result["samples"].append({"expected": text, "normalized_expected": normalize(text),
                                      "wav_sha256": hashlib.sha256(audio).hexdigest(),
                                      "tts_backend": payload.get("tts_backend"), "runs": []})
        model = WhisperModel(str(args.model), device="cpu", compute_type="int8",
                             cpu_threads=4, local_files_only=True)

        def transcribe(audio, beam):
            tick = time.perf_counter()
            with io.BytesIO(audio) as stream:
                segments, _ = model.transcribe(stream, beam_size=beam, **result["common_parameters"])
                text = "".join(segment.text for segment in segments).strip()
            return {"beam_size": beam, "text": text, "elapsed_s": round(time.perf_counter() - tick, 4)}

        result["warmup_excluded"] = transcribe(fixtures[0], 3)
        for index, (sample, audio) in enumerate(zip(result["samples"], fixtures)):
            for beam in ((3, 5) if index % 2 == 0 else (5, 3)):
                run = transcribe(audio, beam)
                actual = normalize(run["text"])
                edits = edit_distance(sample["normalized_expected"], actual)
                run.update(normalized_actual=actual, character_edits=edits,
                           character_error_rate=round(edits / len(sample["normalized_expected"]), 4),
                           exact_match=actual == sample["normalized_expected"])
                sample["runs"].append(run)
                print(json.dumps({"sample": index + 1, **run}, ensure_ascii=True), flush=True)
        result["summary"] = {}
        for beam in (3, 5):
            runs = [run for sample in result["samples"] for run in sample["runs"] if run["beam_size"] == beam]
            edits = sum(run["character_edits"] for run in runs)
            chars = sum(len(sample["normalized_expected"]) for sample in result["samples"])
            result["summary"][str(beam)] = {"character_edits": edits, "reference_characters": chars,
                "character_error_rate": round(edits / chars, 4),
                "exact_matches": sum(run["exact_match"] for run in runs),
                "mean_s": round(statistics.mean(run["elapsed_s"] for run in runs), 4)}
        result["status"] = "PASS"
        return 0
    except Exception as exc:
        result["status"] = "FAIL"
        result["error_class"] = type(exc).__name__
        return 1
    finally:
        timer.cancel()
        fixtures.clear()
        with lock:
            save()
        print(json.dumps({"status": result["status"], "receipt": str(args.output),
                          "tts_calls": result["tts_calls"], "summary": result.get("summary")}), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
