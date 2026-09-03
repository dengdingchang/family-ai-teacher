"""Smoke-test the photo-to-Vision-to-spoken-response path."""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path

import httpx


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8760/api/conversation/frame/stream")
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    image = Path(args.image)
    if not image.is_file():
        print(json.dumps({"status": "FAIL", "reason": "image fixture is missing"}))
        return 1
    counts: Counter[str] = Counter()
    errors: list[str] = []
    audio_count = 0
    done: dict[str, object] = {}
    started = time.perf_counter()
    try:
        with httpx.stream(
            "POST",
            args.url,
            content=image.read_bytes(),
            headers={"Content-Type": "image/jpeg"},
            timeout=240,
            trust_env=False,
        ) as response:
            for line in response.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                event = json.loads(line[5:].strip())
                kind = str(event.get("event", ""))
                counts[kind] += 1
                if kind == "audio":
                    audio_count += 1
                elif kind == "error":
                    errors.append(str(event.get("message", ""))[:240])
                elif kind == "done":
                    done = {
                        "ok": event.get("ok"),
                        "audio_count": event.get("audio_count"),
                        "llm_elapsed_s": event.get("llm_elapsed_s"),
                        "total_elapsed_s": event.get("total_elapsed_s"),
                    }
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "FAIL", "reason": str(exc)[:240]}, ensure_ascii=True))
        return 1
    payload = {
        "status": "PASS" if response.status_code == 200 and counts["vision_context"] == 1 and audio_count and done.get("ok") and not errors else "FAIL",
        "http": response.status_code,
        "events": dict(counts),
        "errors": errors,
        "done": done,
        "wall_s": round(time.perf_counter() - started, 3),
    }
    print(json.dumps(payload, ensure_ascii=True))
    return 0 if payload["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
