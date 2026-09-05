"""One opt-in silent SoulX render for an offline Nathan idle candidate."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import hashlib
import struct
import subprocess
import time
from pathlib import Path


def remote_preflight(host: str, hostname: str = "") -> dict:
    command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12"]
    if hostname:
        command += ["-o", f"HostName={hostname}"]
    command.append(host)
    gpu = subprocess.run(command + ["nvidia-smi", "--query-gpu=memory.free,utilization.gpu",
                                    "--format=csv,noheader,nounits"],
                         check=True, capture_output=True, text=True, timeout=20)
    free_mib, utilization = [int(item.strip()) for item in gpu.stdout.splitlines()[0].split(",")]
    services = subprocess.run(command + ["systemctl", "--user", "is-active",
                                         "family-ai-soulx.service", "family-ai-tts.service"],
                              check=True, capture_output=True, text=True, timeout=20)
    if free_mib < 12288 or services.stdout.split() != ["active", "active"]:
        raise RuntimeError("Avatar preflight failed: insufficient free VRAM or inactive services")
    return {"free_mib": free_mib, "utilization_percent": utilization,
            "soulx_active": True, "tts_active": True}


def h264_packets(message: bytes) -> list[tuple[bool, int, bytes]]:
    if not message.startswith(b"FATV1") or len(message) < 6:
        raise ValueError("Expected the existing FATV1 H264 service")
    offset, frames = 6, []
    for _ in range(message[5]):
        if offset + 13 > len(message):
            raise ValueError("Truncated FATV1 frame header")
        key, stamp, length = struct.unpack_from(">BQI", message, offset)
        offset += 13
        if offset + length > len(message):
            raise ValueError("Truncated FATV1 frame")
        frames.append((bool(key), stamp, message[offset:offset + length]))
        offset += length
    if offset != len(message):
        raise ValueError("Unexpected FATV1 trailing bytes")
    return frames


async def capture(url: str, duration: float) -> tuple[bytes, dict]:
    import websockets

    packets, timestamps = [], []
    ready = None
    feed_sent, flush_requested = False, False
    started = time.perf_counter()
    first_at = None
    target = int(duration * 25)
    async with websockets.connect(url, max_size=16 * 1024 * 1024,
                                  open_timeout=8, close_timeout=2) as socket:
        try:
            while len(packets) < target:
                remaining = 25 - (time.perf_counter() - started)
                if remaining <= 0:
                    raise TimeoutError("Silent candidate capture exceeded its single-run limit")
                message = await asyncio.wait_for(socket.recv(), timeout=remaining)
                if isinstance(message, str):
                    event = json.loads(message)
                    if event.get("type") == "error":
                        raise RuntimeError("Existing SoulX service reported an error")
                    if event.get("type") == "ready" and not flush_requested:
                        ready = event
                        await socket.send(json.dumps({"type": "flush"}))
                        flush_requested = True
                    elif event.get("type") == "flushed" and flush_requested and not feed_sent:
                        # One finite synthetic all-zero PCM request, never a
                        # background idle loop or microphone input.
                        pcm = bytes(int(duration * 16000) * 2)
                        await socket.send(json.dumps({"type": "audio",
                                                      "pcm": base64.b64encode(pcm).decode("ascii")}))
                        feed_sent = True
                    continue
                if not feed_sent:
                    continue
                for is_key, timestamp, payload in h264_packets(message):
                    if not packets and not is_key:
                        continue
                    if timestamps and timestamp <= timestamps[-1]:
                        raise RuntimeError("Avatar generation changed during candidate capture")
                    if first_at is None:
                        first_at = time.perf_counter() - started
                    packets.append(payload)
                    timestamps.append(timestamp)
                    if len(packets) >= target:
                        break
        finally:
            if feed_sent:
                await socket.send(json.dumps({"type": "flush"}))
                try:
                    async with asyncio.timeout(3):
                        while True:
                            message = await socket.recv()
                            if isinstance(message, str) and json.loads(message).get("type") == "flushed":
                                break
                except (TimeoutError, ConnectionError):
                    pass
    return b"".join(packets), {"frames": len(packets), "input_silence_seconds": duration,
                               "first_frame_seconds": round(first_at, 3) if first_at else None,
                               "capture_seconds": round(time.perf_counter() - started, 3),
                               "generation_requests": 1, "media_source": "approved Nathan service avatar",
                               "child_media_used": False, "ready": ready}


def export_candidate(raw: Path, output_dir: Path) -> dict:
    video = output_dir / "nathan-idle-candidate.mp4"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-r", "25",
                    "-f", "h264", "-i", str(raw), "-an", "-c:v", "libx264", "-crf", "18",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video)], check=True, timeout=30)
    sheet = output_dir / "contact-sheet.jpg"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
                    "-vf", "fps=2,scale=192:192,tile=4x3", "-frames:v", "1", "-q:v", "2",
                    str(sheet)], check=True, timeout=20)
    endpoints = output_dir / "first-last.jpg"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
                    "-vf", "select='eq(n,0)+eq(n,149)',tile=2x1", "-frames:v", "1", "-q:v", "2",
                    str(endpoints)], check=True, timeout=20)
    import av
    import numpy as np

    with av.open(str(video)) as source:
        frames = [frame.to_ndarray(format="rgb24").astype(np.float32) for frame in source.decode(video=0)]
    adjacent = [float(np.abs(right - left).mean()) for left, right in zip(frames, frames[1:])]
    return {"video": str(video.resolve()), "contact_sheet": str(sheet.resolve()),
            "endpoints": str(endpoints.resolve()), "decoded_frames": len(frames),
            "first_last_mean_pixel_difference": round(float(np.abs(frames[-1] - frames[0]).mean()), 4),
            "median_adjacent_pixel_difference": round(float(np.median(adjacent)), 4),
            "visual_acceptance": "NOT REVIEWED - do not deploy before inspection"}


def source_loop(source: Path, portrait: Path, output_dir: Path) -> dict:
    """Preserve a reviewed real blink; hold the open-eye frame between repeats.

    Only full portrait frames are used. There is no independent eye/mouth layer,
    face warping, optical-flow interpolation, reverse blink, or model inference.
    """
    video = output_dir / "nathan-native-idle-loop.mp4"
    # Native frames 8.300..9.067 s include a complete closed-mouth blink and
    # a quiet open-eye return. The later 24 s candidate lacked that clean tail.
    # The full-frame scale/crop matches the existing square portrait framing;
    # its already-approved blurred sidebars remain the background.
    filters = (
        "[0:v]fps=30,scale=806:1432,crop=738:1024:60:124,setsar=1[face];"
        "[1:v]scale=1024:1024,setsar=1[base];"
        "[base][face]overlay=143:0:shortest=1,scale=512:512,"
        "fps=30,settb=1/30,setpts=N/(30*TB),split=2[motion][first];"
        "[motion]tpad=start_mode=clone:start_duration=2.4:stop_mode=clone:stop_duration=0.4[m];"
        "[first]trim=end_frame=1,setpts=PTS-STARTPTS,"
        "tpad=stop_mode=clone:stop_duration=0.4,trim=duration=0.4[s];"
        "[m][s]xfade=transition=fade:duration=0.3:offset=3.2,format=yuv420p[out]"
    )
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-threads", "2",
        "-ss", "8.3", "-t", "0.8", "-i", str(source),
        "-loop", "1", "-framerate", "30", "-i", str(portrait),
        "-filter_complex_threads", "1", "-filter_complex", filters,
        "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "medium", "-qp", "18", "-g", "1",
        "-threads", "2", "-movflags", "+faststart", str(video),
    ], check=True, timeout=45)
    twice = output_dir / "two-loops-review.mp4"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "1",
                    "-i", str(video), "-c", "copy", str(twice)], check=True, timeout=20)
    active_sheet = output_dir / "native-blink-all-frames.jpg"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", "2.35",
                    "-t", "1.2333333", "-i", str(video),
                    "-vf", "fps=30,scale=192:192,tile=8x5", "-frames:v", "1", "-q:v", "2",
                    str(active_sheet)], check=True, timeout=20)
    import av
    import numpy as np
    with av.open(str(video)) as clip:
        frames = [frame.to_ndarray(format="rgb24").astype(np.float32) for frame in clip.decode(video=0)]
    seam_sheet = output_dir / "two-loop-seam.jpg"
    count = len(frames)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(twice),
                    "-vf", f"select='between(n,{count - 2},{count + 1})',scale=384:384,tile=4x1",
                    "-frames:v", "1", "-q:v", "2", str(seam_sheet)], check=True, timeout=20)
    # A matched first/last frame is necessary but does not prove a pleasant loop.
    # Every native blink frame and both repeated-loop boundaries still need review.
    return {"video": str(video.resolve()), "two_loops_video": str(twice.resolve()),
            "contact_sheet": str(active_sheet.resolve()), "seam_sheet": str(seam_sheet.resolve()),
            "source_video": str(source.resolve()), "source_window_seconds": [8.3, 9.1],
            "native_frames_requested": 24, "open_eye_hold_seconds": 2.4,
            "full_frame_return_fade_seconds": 0.3, "decoded_frames": count,
            "width": 512, "height": 512, "fps": 30, "duration_seconds": round(count / 30, 4),
            "first_last_mean_pixel_difference": round(float(np.abs(frames[-1] - frames[0]).mean()), 6),
            "video_sha256": hashlib.sha256(video.read_bytes()).hexdigest(),
            "runtime_inference": False, "audio_track": False, "child_media_used": False,
            "visual_acceptance": "NOT REVIEWED - do not deploy before inspection"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--ssh-host", default="ai")
    parser.add_argument("--ssh-hostname", default="")
    parser.add_argument("--url", default="ws://127.0.0.1:8791")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--source-video", type=Path,
                        help="CPU-only audited original-footage mode; never contacts SoulX")
    parser.add_argument("--portrait", type=Path,
                        default=Path("frontend/nathan-avatar-neutral.png"))
    args = parser.parse_args()
    if args.source_video is not None:
        if not args.source_video.is_file() or not args.portrait.is_file():
            raise ValueError("Existing owner video and approved portrait are required")
        if not args.run:
            print(json.dumps({"source_available": True, "inference_run": False, "render_run": False}))
            return 0
        if args.output_dir.exists():
            raise ValueError("Use a new candidate directory; do not overwrite an earlier capture")
        args.output_dir.mkdir(parents=True)
        receipt = source_loop(args.source_video, args.portrait, args.output_dir)
        (args.output_dir / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(receipt, ensure_ascii=False), flush=True)
        return 0
    receipt = {"preflight": remote_preflight(args.ssh_host, args.ssh_hostname), "inference_run": False}
    if args.run:
        if args.output_dir.exists():
            raise ValueError("Use a new candidate directory; do not overwrite an earlier capture")
        args.output_dir.mkdir(parents=True)
        raw_bytes, capture_receipt = asyncio.run(capture(args.url, 6.0))
        raw = args.output_dir / "silent-capture.h264"
        raw.write_bytes(raw_bytes)
        receipt.update(capture_receipt)
        receipt.update(export_candidate(raw, args.output_dir))
        receipt["inference_run"] = True
        (args.output_dir / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(receipt, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
