"""Measure Nathan TTS-to-SoulX first-frame alignment without persisting media."""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import urllib.request

import websockets


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke-test Family AI Teacher avatar timing")
    parser.add_argument("--avatar-url", default="ws://127.0.0.1:8760/ws/avatar")
    parser.add_argument("--tts-url", default="http://127.0.0.1:8792")
    parser.add_argument("--text", default="我们来数一数，一、二、三。")
    parser.add_argument("--timeout", type=float, default=12.0)
    return parser.parse_args()


def post_json(url: str, payload: dict[str, object], timeout: float) -> tuple[bytes, dict[str, str]]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), {key.lower(): value for key, value in response.headers.items()}


async def read_messages(socket, output: asyncio.Queue[tuple[float, str | bytes]]) -> None:
    async for message in socket:
        await output.put((time.perf_counter(), message))


async def wait_for_event(
    messages: asyncio.Queue[tuple[float, str | bytes]],
    event_type: str,
    timeout: float,
) -> dict[str, object]:
    while True:
        _, message = await asyncio.wait_for(messages.get(), timeout=timeout)
        if isinstance(message, bytes):
            continue
        payload = json.loads(message)
        if payload.get("type") == event_type:
            return payload
        if payload.get("type") == "error":
            raise RuntimeError(str(payload.get("message", "avatar error")))


async def wait_for_first_frame(
    messages: asyncio.Queue[tuple[float, str | bytes]],
    cue_started: float,
    timeout: float,
) -> float:
    while True:
        received_at, message = await asyncio.wait_for(messages.get(), timeout=timeout)
        if isinstance(message, bytes):
            if received_at >= cue_started:
                return received_at
            continue
        payload = json.loads(message)
        if payload.get("type") == "error":
            raise RuntimeError(str(payload.get("message", "avatar error")))


async def run(args: argparse.Namespace) -> dict[str, object]:
    async with websockets.connect(args.avatar_url, max_size=16 * 1024 * 1024) as socket:
        messages: asyncio.Queue[tuple[float, str | bytes]] = asyncio.Queue()
        reader = asyncio.create_task(read_messages(socket, messages))
        try:
            ready = await wait_for_event(messages, "ready", args.timeout)
            # End any previous render before synthesis. The reader keeps draining
            # residual frames while TTS runs, so they cannot be mistaken for this cue.
            await socket.send(json.dumps({"type": "flush"}))
            await wait_for_event(messages, "flushed", args.timeout)
            synth_started = time.perf_counter()
            audio, headers = await asyncio.to_thread(
                post_json,
                f"{args.tts_url.rstrip('/')}/synthesize",
                {"text": args.text, "avatar_flush": True, "defer_avatar": True},
                args.timeout,
            )
            synth_finished = time.perf_counter()
            cue_id = headers.get("x-avatar-cue-id", "")
            if not cue_id:
                raise RuntimeError("TTS did not return a deferred avatar cue")
            while not messages.empty():
                messages.get_nowait()

            cue_started = time.perf_counter()
            cue_body, _ = await asyncio.to_thread(
                post_json,
                f"{args.tts_url.rstrip('/')}/avatar/cue",
                {"cue_id": cue_id, "avatar_flush": True},
                args.timeout,
            )
            cue_finished = time.perf_counter()
            first_frame_at = await wait_for_first_frame(messages, cue_started, args.timeout)
            cue_payload = json.loads(cue_body)
            lead_ms = int(cue_payload.get("avatar_audio_lead_ms", 0))
            scheduled_audio_at = cue_finished + lead_ms / 1000.0
            frame_vs_audio_ms = round((first_frame_at - scheduled_audio_at) * 1000, 1)
            frame_after_cue_response_s = first_frame_at - cue_finished
            remote_tts_s = float(headers.get("x-tts-elapsed-s", "nan"))
            frame_gate_pass = frame_after_cue_response_s <= 2.8
            status = "PASS" if cue_payload.get("cued") and frame_gate_pass else "FAIL"
            return {
                "status": status,
                "ready": ready,
                "audio_bytes_in_memory": len(audio),
                "tts_s": round(synth_finished - synth_started, 3),
                "remote_tts_s": round(remote_tts_s, 3),
                "tts_transport_s": round(synth_finished - synth_started - remote_tts_s, 3),
                "cue_roundtrip_s": round(cue_finished - cue_started, 3),
                "first_frame_after_cue_s": round(first_frame_at - cue_started, 3),
                "first_frame_after_cue_response_s": round(frame_after_cue_response_s, 3),
                "configured_audio_lead_ms": lead_ms,
                "static_lead_error_ms": frame_vs_audio_ms,
                "browser_frame_gate_pass": frame_gate_pass,
                "raw_media_persisted": False,
            }
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)


def main() -> int:
    args = parse_args()
    result = asyncio.run(run(args))
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
