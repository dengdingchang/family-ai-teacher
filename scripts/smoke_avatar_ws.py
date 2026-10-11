"""Smoke-test the same-origin SoulX avatar frame stream."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import struct
import time

import websockets


def packet_frame_metadata(message: bytes) -> list[tuple[bool, int]]:
    if not message.startswith(b"FATV1"):
        return [(True, len(message))]
    if len(message) < 6:
        raise RuntimeError("truncated FATV1 header")
    count = message[5]
    offset = 6
    frames: list[tuple[bool, int]] = []
    for _ in range(count):
        if offset + 13 > len(message):
            raise RuntimeError("truncated FATV1 frame header")
        is_key, _, length = struct.unpack_from(">BQI", message, offset)
        offset += 13
        if offset + length > len(message):
            raise RuntimeError("truncated FATV1 frame payload")
        frames.append((bool(is_key), length))
        offset += length
    return frames


def packet_frame_sizes(message: bytes) -> list[int]:
    return [size for _, size in packet_frame_metadata(message)]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke-test Family AI Teacher avatar frames")
    parser.add_argument("--url", default="ws://127.0.0.1:8760/ws/avatar")
    parser.add_argument("--frames", type=int, default=50)
    parser.add_argument("--timeout", type=float, default=12.0)
    parser.add_argument(
        "--feed-tone-seconds",
        type=float,
        default=0.0,
        help="Feed an in-memory 16 kHz test tone after ready (never persisted).",
    )
    parser.add_argument("--streaming-controls", action="store_true", help="Send audio directly to acquire the streaming renderer; do not wait for an unowned flush.")
    return parser.parse_args()


def tone_pcm(seconds: float, sample_rate: int = 16000) -> bytes:
    sample_count = max(0, int(seconds * sample_rate))
    values = (
        int(32767 * 0.08 * math.sin(2 * math.pi * 180 * index / sample_rate))
        for index in range(sample_count)
    )
    return struct.pack(f"<{sample_count}h", *values) if sample_count else b""


async def run(
    url: str,
    frame_target: int,
    timeout: float,
    feed_tone_seconds: float = 0.0,
    streaming_controls: bool = False,
) -> dict[str, object]:
    started = time.perf_counter()
    packet_times: list[float] = []
    sizes: list[int] = []
    ready: dict[str, object] | None = None
    first_packet_frames = 0
    wire = "unknown"
    feed_sent = False
    feed_sent_at: float | None = None
    flush_requested = False
    first_packet_has_keyframe = False
    first_keyframe_index: int | None = None
    async with websockets.connect(url, max_size=16 * 1024 * 1024) as socket:
        while len(sizes) < frame_target:
            message = await asyncio.wait_for(socket.recv(), timeout=timeout)
            now = time.perf_counter()
            if isinstance(message, str):
                payload = json.loads(message)
                if payload.get("type") == "ready":
                    ready = payload
                    if streaming_controls and feed_tone_seconds > 0 and not feed_sent:
                        await socket.send(json.dumps({"type": "audio_begin"}))
                        await socket.send(json.dumps({"type": "audio", "pcm": base64.b64encode(tone_pcm(feed_tone_seconds)).decode("ascii")}))
                        await socket.send(json.dumps({"type": "audio_end"}))
                        feed_sent = True
                        feed_sent_at = time.perf_counter()
                    if feed_tone_seconds > 0 and not feed_sent:
                        await socket.send(json.dumps({"type": "flush"}))
                        flush_requested = True
                if payload.get("type") == "flushed" and flush_requested and not feed_sent:
                    await socket.send(
                        json.dumps(
                            {
                                "type": "audio",
                                "pcm": base64.b64encode(
                                    tone_pcm(feed_tone_seconds)
                                ).decode("ascii"),
                            }
                        )
                    )
                    feed_sent = True
                    feed_sent_at = time.perf_counter()
                if payload.get("type") == "error":
                    raise RuntimeError(str(payload.get("message", "avatar error")))
                continue
            packet_times.append(now)
            packet_metadata = packet_frame_metadata(message)
            packet_sizes = [size for _, size in packet_metadata]
            if not sizes:
                first_packet_frames = len(packet_sizes)
                first_packet_has_keyframe = any(is_key for is_key, _ in packet_metadata)
            if first_keyframe_index is None:
                for offset, (is_key, _) in enumerate(packet_metadata):
                    if is_key:
                        first_keyframe_index = len(sizes) + offset
                        break
            sizes.extend(packet_sizes)
            wire = "h264" if message.startswith(b"FATV1") else "jpeg"
    frame_window = packet_times[-1] - packet_times[0] if len(packet_times) > 1 else 0.0
    measured_fps = (len(sizes) - first_packet_frames) / frame_window if frame_window > 0 else 0.0
    return {
        "status": "PASS" if ready and len(sizes) >= frame_target else "FAIL",
        "ready": ready,
        "wire": wire,
        "frames": len(sizes),
        "packets": len(packet_times),
        "first_frame_s": round(packet_times[0] - started, 3) if packet_times else None,
        "first_frame_after_feed_s": (
            round(packet_times[0] - feed_sent_at, 3)
            if packet_times and feed_sent_at is not None
            else None
        ),
        "first_packet_has_keyframe": first_packet_has_keyframe,
        "first_keyframe_index": first_keyframe_index,
        "measured_fps": round(measured_fps, 2),
        "total_frame_bytes": sum(sizes),
        "average_frame_bytes": round(sum(sizes) / len(sizes), 1) if sizes else 0,
        "min_frame_bytes": min(sizes) if sizes else 0,
        "max_frame_bytes": max(sizes) if sizes else 0,
    }


def main() -> int:
    args = parse_args()
    result = asyncio.run(
        run(
            args.url,
            max(2, args.frames),
            args.timeout,
            max(0.0, args.feed_tone_seconds),
            args.streaming_controls,
        )
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
