"""Smoke-test the multipart streaming conversation without printing media or secrets."""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path

import httpx


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8760/api/conversation/stream")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--frame", default="")
    args = parser.parse_args()
    audio = Path(args.audio)
    if not audio.is_file():
        print(json.dumps({"status": "FAIL", "reason": "audio fixture is missing"}))
        return 1
    files = {"audio": ("child-speech.webm", audio.read_bytes(), "audio/webm")}
    if args.frame:
        frame = Path(args.frame)
        if not frame.is_file():
            print(json.dumps({"status": "FAIL", "reason": "frame fixture is missing"}))
            return 1
        files["frame"] = ("child-frame.jpg", frame.read_bytes(), "image/jpeg")
    counts: Counter[str] = Counter()
    assistant_chars = 0
    audio_events: list[dict[str, object]] = []
    errors: list[str] = []
    done: dict[str, object] = {}
    started = time.perf_counter()
    try:
        with httpx.stream("POST", args.url, files=files, timeout=240, trust_env=False) as response:
            for line in response.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                event = json.loads(line[5:].strip())
                kind = str(event.get("event", ""))
                counts[kind] += 1
                if kind == "assistant_delta":
                    assistant_chars += len(str(event.get("text", "")))
                elif kind == "audio":
                    audio_events.append(
                        {
                            "sequence": event.get("sequence"),
                            "duration_s": event.get("audio_duration_s"),
                            "gpu_peak_mib": (event.get("tts_gpu") or {}).get("peak_mib"),
                        }
                    )
                elif kind == "done":
                    done = {
                        "ok": event.get("ok"),
                        "audio_count": event.get("audio_count"),
                        "llm_elapsed_s": event.get("llm_elapsed_s"),
                        "total_elapsed_s": event.get("total_elapsed_s"),
                    }
                elif kind == "error":
                    errors.append(str(event.get("message", ""))[:240])
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "FAIL", "reason": str(exc)[:240]}, ensure_ascii=True))
        return 1
    payload = {
        "status": "PASS" if done.get("ok") and audio_events and counts["vision_context"] == (1 if args.frame else 0) else "FAIL",
        "http": response.status_code,
        "events": dict(counts),
        "assistant_chars": assistant_chars,
        "audio": audio_events,
        "errors": errors,
        "done": done,
        "wall_s": round(time.perf_counter() - started, 3),
    }
    print(json.dumps(payload, ensure_ascii=True))
    return 0 if payload["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
