"""Verify that an interrupted SSE turn is not completed or persisted.

The script closes the client connection immediately after the first audio event.
It prints metadata only; synthesized audio is never written to disk.
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
    parser.add_argument(
        "--text",
        default="我想学英语",
    )
    parser.add_argument("--settle-seconds", type=float, default=8.0)
    parser.add_argument("--max-cancel-seconds", type=float, default=3.0)
    parser.add_argument("--playback-cues", action="store_true")
    parser.add_argument("--after-pending-cue", action="store_true",
                        help="Wait for formal audio, cancel, then try its now-invalid avatar cue")
    args = parser.parse_args()
    if args.after_pending_cue and not args.playback_cues:
        parser.error("--after-pending-cue requires --playback-cues")

    cancelled_audio: dict[str, object] = {}
    cancel_result: dict[str, object] = {}
    saw_done = False
    turn_id = uuid.uuid4().hex
    started = time.perf_counter()
    first_audio_s = None
    cancel_elapsed_s = None
    cancelled_audio_s = None
    replay_cued = None
    with httpx.Client(timeout=240, trust_env=False) as client:
        before = history_count(client, args.base_url)
        with client.stream(
            "POST",
            f"{args.base_url}/api/conversation/text/stream",
            json={"text": args.text},
            headers={"X-Conversation-Turn-Id": turn_id,
                     "X-Avatar-Playback-Cues": "1" if args.playback_cues else "0"},
        ) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line.startswith("data:"):
                    continue
                event = json.loads(line[5:].strip())
                if event.get("event") == "done":
                    saw_done = True
                if event.get("event") == "audio":
                    if first_audio_s is None:
                        first_audio_s = round(time.perf_counter() - started, 3)
                    if args.after_pending_cue and not event.get("avatar_pending"):
                        continue
                    cancelled_audio_s = round(time.perf_counter() - started, 3)
                    cancelled_audio = {
                        "sequence": event.get("sequence"),
                        "backend": event.get("tts_backend"),
                        "avatar_cued": event.get("avatar_cued"),
                        "audio_duration_s": event.get("audio_duration_s"),
                        "tts_started_s": event.get("tts_started_s"),
                        "tts_call_s": event.get("tts_call_s"),
                        "tts_server_elapsed_s": event.get("tts_server_elapsed_s"),
                    }
                    cancel_started = time.perf_counter()
                    cancel_response = client.post(
                        f"{args.base_url}/api/conversation/turns/{turn_id}/cancel"
                    )
                    cancel_response.raise_for_status()
                    cancel_result = cancel_response.json()
                    cancel_elapsed_s = round(time.perf_counter() - cancel_started, 3)
                    if args.after_pending_cue:
                        replay_response = client.post(
                            f"{args.base_url}/api/conversation/turns/{turn_id}/avatar/{event['sequence']}"
                        )
                        replay_response.raise_for_status()
                        replay_cued = replay_response.json().get("cued")
                    break
        time.sleep(max(0.0, args.settle_seconds))
        after = history_count(client, args.base_url)

    passed = bool(
        cancelled_audio
        and (args.after_pending_cue or cancelled_audio.get("sequence") == 1)
        and (not args.after_pending_cue or replay_cued is False)
        and cancel_result.get("cancelled") is True
        and cancel_elapsed_s is not None and cancel_elapsed_s <= args.max_cancel_seconds
        and not saw_done
        and after == before
    )
    print(
        json.dumps(
            {
                "status": "PASS" if passed else "FAIL",
                "first_audio_s": first_audio_s,
                "cancel_elapsed_s": cancel_elapsed_s,
                "max_cancel_seconds": args.max_cancel_seconds,
                "cancelled_audio_s": cancelled_audio_s,
                "cancelled_cue_replayed": replay_cued,
                "playback_cues": args.playback_cues,
                "cancelled_audio": cancelled_audio,
                "cancel": cancel_result,
                "done_received_before_disconnect": saw_done,
                "history_before": before,
                "history_after": after,
                "settle_seconds": args.settle_seconds,
            },
            ensure_ascii=True,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
