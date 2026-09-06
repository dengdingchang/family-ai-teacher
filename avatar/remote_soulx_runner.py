"""Safety wrapper for the SoulX renderer running on the private AI Station.

The actual renderer stays in the audited VoxEMW checkout. This wrapper only
performs the vLLM/GPU preflight and caps this process before delegating to it.
"""

from __future__ import annotations

import asyncio
import os
import importlib.util
import base64
import json
import runpy
import struct
import subprocess
import threading
import time
import urllib.request
from fractions import Fraction
from pathlib import Path


_AUDIO_STREAM_END = object()


def _gpu_free_mib() -> int:
    completed = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=memory.free",
            "--format=csv,noheader,nounits",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=8,
    )
    return int(completed.stdout.splitlines()[0].strip().split()[0])


def _require_vllm_health() -> None:
    url = os.getenv("VLLM_HEALTH_URL", "http://127.0.0.1:8002/health")
    with urllib.request.urlopen(url, timeout=5) as response:
        if response.status != 200:
            raise RuntimeError(f"vLLM health returned HTTP {response.status}")


class _H264BatchEncoder:
    """Encode small 25-fps H.264 batches with a fresh keyframe per turn."""

    MAGIC = b"FATV1"

    def __init__(self) -> None:
        import av

        self._av = av
        self._batch_size = max(1, min(12, int(os.getenv("SOULX_H264_BATCH_FRAMES", "5"))))
        self._frame_index = 0
        self._pending: list[tuple[bool, int, bytes]] = []
        self._lock = threading.Lock()
        self._codec = self._create_codec()

    def _create_codec(self):
        codec = self._av.CodecContext.create("libx264", "w")
        codec.width = 512
        codec.height = 512
        codec.pix_fmt = "yuv420p"
        codec.time_base = Fraction(1, 25)
        codec.framerate = Fraction(25, 1)
        codec.bit_rate = int(os.getenv("SOULX_H264_BITRATE", "192000"))
        codec.gop_size = 25
        codec.max_b_frames = 0
        # Match the explicit conversion in push; do not leave browsers to guess
        # the YUV matrix/range. The renderer's RGB values use the sRGB transfer.
        codec.color_range = 1  # MPEG limited range
        codec.colorspace = 1  # BT.709 matrix
        codec.color_primaries = 1  # BT.709 / sRGB primaries
        codec.color_trc = 13  # IEC 61966-2-1 (sRGB)
        codec.options = {
            "preset": "ultrafast",
            "tune": "zerolatency",
            "profile": "baseline",
            "x264-params": "repeat-headers=1:annexb=1:scenecut=0:keyint=25:min-keyint=25",
        }
        codec.open()
        return codec

    def push(self, frame_array) -> bytes:
        with self._lock:
            frame = self._av.VideoFrame.from_ndarray(frame_array, format="rgb24")
            frame = frame.reformat(
                format="yuv420p", dst_colorspace="ITU709",
                src_color_range="JPEG", dst_color_range="MPEG",
                dst_color_trc=13, dst_color_primaries=1,
            )
            frame.pts = self._frame_index
            frame.time_base = Fraction(1, 25)
            self._frame_index += 1
            for packet in self._codec.encode(frame):
                timestamp_us = int((packet.pts if packet.pts is not None else frame.pts) * 40000)
                self._pending.append((bool(packet.is_keyframe), timestamp_us, bytes(packet)))
            # Do not hold the first decodable frame for four more 40ms ticks.
            # Delta batches retain the existing bandwidth-efficient size.
            batch_size = 1 if self._pending and self._pending[0][0] else self._batch_size
            if len(self._pending) < batch_size:
                return b""
            batch = self._pending[:batch_size]
            del self._pending[:batch_size]
            return self._pack_batch(batch)

    def _pack_batch(self, batch) -> bytes:
        if not batch:
            return b""
        payload = bytearray(self.MAGIC)
        payload.extend(struct.pack(">B", len(batch)))
        for is_key, timestamp_us, packet in batch:
            payload.extend(struct.pack(">BQI", 1 if is_key else 0, timestamp_us, len(packet)))
            payload.extend(packet)
        return bytes(payload)

    def drain_pending(self) -> bytes:
        """Send already encoded tail packets without ending or resetting the codec."""
        with self._lock:
            batch, self._pending = self._pending, []
            return self._pack_batch(batch)

    def reset(self) -> None:
        """Start every turn with SPS/PPS plus an immediately decodable keyframe."""

        with self._lock:
            self._pending.clear()
            self._frame_index = 0
            self._codec = self._create_codec()


def _run_soulx_server(server_path: Path) -> None:
    wire_codec = os.getenv("SOULX_WIRE_CODEC", "h264").strip().lower()
    if wire_codec != "h264":
        runpy.run_path(str(server_path), run_name="__main__")
        return

    spec = importlib.util.spec_from_file_location("family_soulx_server", server_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load SoulX server module: {server_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    original_init = module.RenderEngine.__init__
    original_flush = module.RenderEngine.flush
    original_emit = module.AvatarServer.emit_frames_threadsafe
    original_serve = module.AvatarServer.serve

    def speech_only_next_chunk(self, pending):
        """Wait while idle; only pad silence after real speech has arrived.

        VoxEMW continuously infers silent chunks for idle motion. On the shared
        AI Station that creates periodic GPU contention with Nathan TTS and
        vLLM. The browser already has a natural still frame, so we reserve
        SoulX compute for speech while preserving a padded neutral tail.
        """

        import queue

        import numpy as np

        while len(pending) < self.chunk_samples:
            if self._stop.is_set():
                return pending, None
            if self._flushed.is_set():
                return np.zeros(0, dtype=np.float32), None
            try:
                if self._family_stream_ended and self.audio_q.empty():
                    audio = _AUDIO_STREAM_END
                else:
                    audio = self.audio_q.get(timeout=0.2)
                if audio is None:
                    return pending, None
                if self._flushed.is_set():
                    # flush may race with a newly queued full utterance. Put it
                    # back before the outer loop clears pending, otherwise all
                    # but the first 0.96 s can be discarded on the next pass.
                    self.audio_q.put_nowait(audio)
                    return np.zeros(0, dtype=np.float32), None
                if audio is _AUDIO_STREAM_END:
                    if not self._family_streaming:
                        continue
                    self._family_streaming = False
                    self._family_stream_ended = False
                    if not len(pending):
                        return pending, None
                    pending = np.concatenate(
                        [pending, np.zeros(self.chunk_samples - len(pending), dtype=np.float32)]
                    )
                    continue
                pending = np.concatenate([pending, audio])
            except queue.Empty:
                if self._stop.is_set():
                    return pending, None
                # A normal streaming TTS gap can exceed 200 ms. Padding here
                # would add silence only to the mouth's timeline, not speech.
                if self._family_streaming:
                    continue
                if not len(pending):
                    continue
                pending = np.concatenate(
                    [pending, np.zeros(self.chunk_samples - len(pending), dtype=np.float32)]
                )
        return pending[self.chunk_samples :], pending[: self.chunk_samples]

    def begin_audio_stream(self):
        self._family_streaming = True
        self._family_stream_ended = False

    def end_audio_stream(self):
        import queue

        if not self._family_streaming or self._family_stream_ended:
            return
        self._family_stream_ended = True
        try:
            self.audio_q.put_nowait(_AUDIO_STREAM_END)
        except queue.Full:
            # Preserve all queued PCM. The consumer also checks the end flag
            # once that queue has drained, so a full queue cannot lose the end.
            pass

    def paced_accumulate_loop(self):
        """Accept full utterances but release render chunks on the playback clock."""

        import queue

        import numpy as np

        pending = np.zeros(0, dtype=np.float32)
        next_chunk_at = None
        while not self._stop.is_set():
            if self._flushed.is_set():
                pending = np.zeros(0, dtype=np.float32)
                next_chunk_at = None
                self._flushed.clear()
            pending, chunk = self._next_chunk(pending)
            if chunk is None:
                pending = np.zeros(0, dtype=np.float32)
                next_chunk_at = None
                continue
            if len(chunk) < self.chunk_samples:
                continue

            now = time.perf_counter()
            if next_chunk_at is None or now > next_chunk_at + self.chunk_seconds:
                next_chunk_at = now
            delay = max(0.0, next_chunk_at - now)
            if delay and self._flushed.wait(delay):
                pending = np.zeros(0, dtype=np.float32)
                next_chunk_at = None
                continue

            queued = False
            while not self._stop.is_set() and not self._flushed.is_set():
                try:
                    self.chunk_q.put(chunk, timeout=0.2)
                    queued = True
                    break
                except queue.Full:
                    continue
            if queued:
                next_chunk_at += self.chunk_seconds

    def render_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self._family_streaming = False
        self._family_stream_ended = False
        self._family_h264_encoder = _H264BatchEncoder()
        self._family_tail_emit_lock = threading.Lock()
        self._family_warm_ready = threading.Event()
        if os.getenv("SOULX_IDLE_MODE", "speech_only").strip().lower() == "speech_only":
            import numpy as np

            # Compile and warm the model exactly once, then go idle without
            # continuously competing with vLLM/TTS for GPU compute.
            self.audio_q.put_nowait(np.zeros(self.chunk_samples, dtype=np.float32))

    def encode_frame(self, frame_array):
        payload = self._family_h264_encoder.push(frame_array)
        if payload:
            self._family_warm_ready.set()
        return payload

    def interruptible_flush(self):
        with self._family_tail_emit_lock:
            self._family_streaming = False
            self._family_stream_ended = False
            original_flush(self)
        # Codec work stays outside the tail-send lock; no lock-order reversal.
        self._family_h264_encoder.reset()

    async def streaming_handler(self, ws):
        """Preserve the upstream protocol and add explicit streamed-audio bounds."""
        self.clients.add(ws)
        try:
            await ws.send(json.dumps({
                "type": "ready", "fps": self.engine.fps,
                "chunk_seconds": self.engine.chunk_seconds,
                "audio_stream_protocol": True,
            }))
            async for message in ws:
                if not isinstance(message, str):
                    continue
                try:
                    event = json.loads(message)
                except json.JSONDecodeError:
                    continue
                kind = event.get("type")
                if kind == "audio_begin":
                    self.engine.begin_audio_stream()
                elif kind == "audio_end":
                    self.engine.end_audio_stream()
                elif kind == "audio":
                    self.engine.feed(base64.b64decode(event["pcm"]))
                elif kind == "flush":
                    self.engine.flush()
                    await ws.send(json.dumps({"type": "flushed"}))
                elif kind == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
        finally:
            self.clients.discard(ws)

    def interruptible_emit_loop(self):
        """Stop the currently emitting frame group as soon as a turn is interrupted."""

        import queue

        frame_interval = 1.0 / self.fps
        next_t = None
        while not self._stop.is_set():
            try:
                frames = self.emit_q.get(timeout=0.2)
            except queue.Empty:
                next_t = None
                continue
            sequence = self._flush_seq
            for frame in frames:
                if sequence != self._flush_seq or self._flushed.is_set():
                    next_t = None
                    break
                now = time.perf_counter()
                if next_t is None:
                    next_t = now
                if now < next_t:
                    self._stop.wait(next_t - now)
                if sequence != self._flush_seq or self._flushed.is_set():
                    next_t = None
                    break
                self.on_frames(self._to_jpeg(frame))
                next_t += frame_interval
            else:
                # A completed 24-frame group may leave fewer than five encoded
                # frames. Serialize this small send with cancellation, not encoding.
                with self._family_tail_emit_lock:
                    if (sequence == self._flush_seq and not self._flushed.is_set()
                            and not self._stop.is_set()):
                        payload = self._family_h264_encoder.drain_pending()
                        if payload:
                            self.on_frames(payload)

    def emit_nonempty(self, payload: bytes) -> None:
        if payload:
            original_emit(self, payload)

    async def warm_gated_serve(self, host: str, port: int) -> None:
        warmed = await asyncio.to_thread(self.engine._family_warm_ready.wait, 90.0)
        if not warmed:
            raise RuntimeError("SoulX warm-up did not produce a decodable H.264 packet")
        self.engine.flush()
        print("SoulX warm-up complete: accepting browser connections", flush=True)
        await original_serve(self, host, port)

    module.RenderEngine.__init__ = render_init
    module.RenderEngine.flush = interruptible_flush
    module.RenderEngine.begin_audio_stream = begin_audio_stream
    module.RenderEngine.end_audio_stream = end_audio_stream
    module.RenderEngine._emit_loop = interruptible_emit_loop
    module.RenderEngine._to_jpeg = encode_frame
    module.AvatarServer.emit_frames_threadsafe = emit_nonempty
    module.AvatarServer.serve = warm_gated_serve
    module.AvatarServer.handler = streaming_handler
    if os.getenv("SOULX_IDLE_MODE", "speech_only").strip().lower() == "speech_only":
        module.RenderEngine._next_chunk = speech_only_next_chunk
        module.RenderEngine._accumulate_loop = paced_accumulate_loop
        print("SoulX idle mode: speech-only inference", flush=True)
    print("SoulX wire codec: H.264 baseline, FATV1 batches", flush=True)
    module.main()


def main() -> int:
    minimum_free_mib = int(os.getenv("SOULX_MIN_FREE_MIB", "17000"))
    fraction = float(os.getenv("SOULX_GPU_MEMORY_FRACTION", "0.07"))
    if not 0.04 <= fraction <= 0.10:
        raise RuntimeError("SOULX_GPU_MEMORY_FRACTION must stay between 0.04 and 0.10")
    _require_vllm_health()
    free_mib = _gpu_free_mib()
    if free_mib < minimum_free_mib:
        raise RuntimeError(
            f"SoulX start refused: only {free_mib} MiB free; need {minimum_free_mib} MiB"
        )

    import torch

    torch.cuda.set_per_process_memory_fraction(fraction, 0)
    server_path = Path(os.environ["SOULX_SERVER_PATH"]).resolve()
    if not server_path.is_file():
        raise FileNotFoundError(server_path)
    print(
        f"SoulX safety preflight passed: free={free_mib} MiB, fraction={fraction:.3f}",
        flush=True,
    )
    _run_soulx_server(server_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
