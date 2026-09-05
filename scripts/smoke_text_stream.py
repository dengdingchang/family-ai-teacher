"""Smoke-test the text-to-SSE-to-persistent-TTS path without printing answer/audio."""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter

import httpx


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8760/api/conversation/text/stream")
    parser.add_argument("--text", default="请只回答：恐龙。")
    args = parser.parse_args()
    counts: Counter[str] = Counter()
    errors: list[str] = []
    chars = 0
    audio: list[dict[str, object]] = []
    done: dict[str, object] = {}
    started = time.perf_counter()
    first_audio_s: float | None = None
    try:
        with httpx.stream(
            "POST",
            args.url,
            json={"text": args.text},
            timeout=240,
            trust_env=False,
        ) as response:
            for line in response.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                event = json.loads(line[5:].strip())
                kind = str(event.get("event", ""))
                counts[kind] += 1
                if kind == "assistant_delta":
                    chars += len(str(event.get("text", "")))
                elif kind == "audio":
                    if first_audio_s is None:
                        first_audio_s = round(time.perf_counter() - started, 3)
                    audio.append(
                        {
                            "sequence": event.get("sequence"),
                            "duration_s": event.get("audio_duration_s"),
                            "tts_elapsed_s": event.get("tts_elapsed_s"),
                            "backend": event.get("tts_backend"),
                            "mime": event.get("audio_mime"),
                            "avatar_cued": event.get("avatar_cued"),
                            "avatar_lead_ms": event.get("avatar_audio_lead_ms"),
                            "audio_base64_chars": len(str(event.get("audio_base64", ""))),
                            "avatar_pcm_sent": bool(event.get("avatar_pcm_base64")),
                            "gpu_peak_mib": (event.get("tts_gpu") or {}).get("peak_mib"),
                        }
                    )
                elif kind == "error":
                    errors.append(str(event.get("message", ""))[:240])
                elif kind == "done":
                    done = {
                        "ok": event.get("ok"),
                        "assistant_text": event.get("assistant_text"),
                        "audio_count": event.get("audio_count"),
                        "llm_elapsed_s": event.get("llm_elapsed_s"),
                        "total_elapsed_s": event.get("total_elapsed_s"),
                    }
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "FAIL", "reason": str(exc)[:240]}, ensure_ascii=True))
        return 1
    payload = {"status": "PASS" if response.status_code == 200 and done.get("ok") and audio and not errors else "FAIL", "http": response.status_code, "events": dict(counts), "assistant_chars": chars, "first_audio_s": first_audio_s, "audio": audio, "errors": errors, "done": done, "wall_s": round(time.perf_counter() - started, 3)}
    print(json.dumps(payload, ensure_ascii=True))
    return 0 if payload["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
