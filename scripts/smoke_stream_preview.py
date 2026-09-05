"""Measure a complete text turn without saving it to the child's history.

The staged turn is cancelled after the final SSE event. Audio remains in memory;
the script prints timing and metadata only.
"""

from __future__ import annotations

import argparse
import json
import time
import uuid

import httpx


def history_count(client: httpx.Client, base_url: str) -> int:
    response = client.get(f"{base_url}/api/memory/history")
    response.raise_for_status()
    return len(response.json().get("history", []))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8760")
    parser.add_argument("--text", default="小宝想学一个新的英语单词")
    parser.add_argument("--max-initial-seconds", type=float, default=1.5)
    parser.add_argument("--max-semantic-seconds", type=float, default=3.0)
    parser.add_argument("--allow-cached", action="store_true", help="Explicitly measure a warmed repeat rather than uncached synthesis")
    args = parser.parse_args()

    turn_id = uuid.uuid4().hex
    started = time.perf_counter()
    audio: list[dict[str, object]] = []
    errors: list[str] = []
    done: dict[str, object] = {}
    cancel: dict[str, object] = {}

    with httpx.Client(timeout=240, trust_env=False) as client:
        before = history_count(client, args.base_url)
        with client.stream(
            "POST",
            f"{args.base_url}/api/conversation/text/stream",
            json={"text": args.text},
            headers={"X-Conversation-Turn-Id": turn_id},
        ) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line.startswith("data:"):
                    continue
                event = json.loads(line[5:].strip())
                kind = str(event.get("event", ""))
                if kind == "audio":
                    audio.append(
                        {
                            "at_s": round(time.perf_counter() - started, 3),
                            "sequence": event.get("sequence"),
                            "acknowledgement": bool(event.get("acknowledgement")),
                            "semantic": event.get("semantic") is True,
                            "backend": event.get("tts_backend"),
                            "tts_elapsed_s": event.get("tts_elapsed_s"),
                            "duration_s": event.get("audio_duration_s"),
                            "avatar_cued": bool(event.get("avatar_cued")),
                            "avatar_lead_ms": event.get("avatar_audio_lead_ms"),
                            "mime": event.get("audio_mime"),
                        }
                    )
                elif kind == "error":
                    errors.append(str(event.get("message", ""))[:240])
                elif kind == "done":
                    done = {
                        "ok": bool(event.get("ok")),
                        "commit_required": bool(event.get("commit_required")),
                        "audio_count": event.get("audio_count"),
                        "llm_elapsed_s": event.get("llm_elapsed_s"),
                        "total_elapsed_s": event.get("total_elapsed_s"),
                    }

        cancel_response = client.post(f"{args.base_url}/api/conversation/turns/{turn_id}/cancel")
        cancel_response.raise_for_status()
        cancel = cancel_response.json()
        after = history_count(client, args.base_url)

    initial = audio[0] if audio else None
    semantic = next(
        (item for item in audio if item["semantic"]),
        None,
    )
    passed = bool(
        response.status_code == 200
        and initial
        and semantic
        and float(initial["at_s"]) <= args.max_initial_seconds
        and float(semantic["at_s"]) <= args.max_semantic_seconds
        and (args.allow_cached or not str(semantic["backend"]).endswith("-cache"))
        and done.get("ok")
        and done.get("commit_required")
        and cancel.get("cancelled") is True
        and before == after
        and not errors
    )
    print(
        json.dumps(
            {
                "status": "PASS" if passed else "FAIL",
                "turn_id": turn_id,
                "audio": audio,
                "done": done,
                "cancelled": cancel.get("cancelled"),
                "history_before": before,
                "history_after": after,
                "errors": errors,
                "wall_s": round(time.perf_counter() - started, 3),
            },
            ensure_ascii=True,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
