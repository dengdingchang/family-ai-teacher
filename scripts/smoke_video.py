"""Smoke-test short-video keyframe analysis without printing media or secrets."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8760/api/vision/describe-video")
    parser.add_argument("--video", required=True)
    args = parser.parse_args()
    video = Path(args.video)
    if not video.is_file():
        print(json.dumps({"status": "FAIL", "reason": "video fixture is missing"}))
        return 1
    started = time.perf_counter()
    try:
        response = httpx.post(
            args.url,
            files={"video": (video.name, video.read_bytes(), "video/webm")},
            timeout=180,
            trust_env=False,
        )
        payload = response.json()
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "FAIL", "reason": str(exc)[:240]}, ensure_ascii=True))
        return 1
    result = {
        "status": "PASS" if response.status_code == 200 and payload.get("description") else "FAIL",
        "http": response.status_code,
        "frames": payload.get("frames"),
        "description_nonempty": bool(payload.get("description")),
        "persisted_video": payload.get("persisted_video"),
        "persisted_frames": payload.get("persisted_frames"),
        "wall_s": round(time.perf_counter() - started, 3),
    }
    if response.status_code != 200:
        result["detail"] = str(payload.get("detail", ""))[:240]
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
