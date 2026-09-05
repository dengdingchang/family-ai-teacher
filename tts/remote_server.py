"""Loopback-only Nathan TTS inference service for the private AI Station."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import threading
import time
import urllib.request
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field


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


class NathanEngine:
    def __init__(self) -> None:
        minimum_free_mib = int(os.getenv("TTS_MIN_FREE_MIB", "17000"))
        fraction = float(os.getenv("TTS_GPU_MEMORY_FRACTION", "0.06"))
        if not 0.04 <= fraction <= 0.08:
            raise RuntimeError("TTS_GPU_MEMORY_FRACTION must stay between 0.04 and 0.08")
        _require_vllm_health()
        free_mib = _gpu_free_mib()
        if free_mib < minimum_free_mib:
            raise RuntimeError(
                f"Nathan TTS start refused: only {free_mib} MiB free; need {minimum_free_mib} MiB"
            )

        import torch
        from qwen_tts import Qwen3TTSModel

        torch.cuda.set_per_process_memory_fraction(fraction, 0)
        self._torch = torch
        self._lock = threading.RLock()
        self.model_path = Path(os.environ["TTS_MODEL_PATH"]).resolve()
        self.reference_audio = Path(os.environ["TTS_REF_AUDIO"]).resolve()
        if not (self.model_path / "config.json").is_file():
            raise FileNotFoundError(self.model_path / "config.json")
        if not self.reference_audio.is_file():
            raise FileNotFoundError(self.reference_audio)
        self.language = os.getenv("TTS_LANGUAGE", "Chinese").strip() or "Chinese"
        self.attention = os.getenv(
            "TTS_ATTENTION_IMPLEMENTATION", "flash_attention_2"
        ).strip()
        self.model = Qwen3TTSModel.from_pretrained(
            str(self.model_path),
            device_map="cuda:0",
            dtype=torch.float16,
            attn_implementation=self.attention,
        )
        self.voice_prompt = self.model.create_voice_clone_prompt(
            ref_audio=str(self.reference_audio),
            ref_text=None,
            x_vector_only_mode=True,
        )
        self.last_elapsed_s: float | None = None
        self._pending_avatar_lock = threading.RLock()
        self._pending_avatar: dict[str, tuple[float, bytes]] = {}
        self.avatar_url = os.getenv("AVATAR_WS_URL", "ws://127.0.0.1:8791").strip()
        self.avatar_lead_ms = max(0, min(1500, int(os.getenv("TTS_AVATAR_LEAD_MS", "320"))))
        # Warm the autoregressive and codec paths before accepting child turns.
        self.synthesize("你好。", cue_avatar=False)
        print(
            f"Nathan TTS ready: free_before={free_mib} MiB, fraction={fraction:.3f}",
            flush=True,
        )

    @staticmethod
    def _pcm16_16k(waveform: np.ndarray, sample_rate: int) -> bytes:
        from scipy.signal import resample_poly

        mono = np.asarray(waveform, dtype=np.float32).reshape(-1)
        if sample_rate != 16000:
            divisor = int(np.gcd(sample_rate, 16000))
            mono = resample_poly(mono, 16000 // divisor, sample_rate // divisor)
        return (np.clip(mono, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()

    @staticmethod
    def _encode_opus(waveform: np.ndarray, sample_rate: int) -> bytes:
        completed = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "f32le",
                "-ar",
                str(sample_rate),
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-c:a",
                "libopus",
                "-b:a",
                "40k",
                "-application",
                "voip",
                "-f",
                "webm",
                "pipe:1",
            ],
            input=np.asarray(waveform, dtype="<f4").reshape(-1).tobytes(),
            capture_output=True,
            check=True,
            timeout=15,
        )
        if not completed.stdout:
            raise RuntimeError("ffmpeg returned empty Opus audio")
        return completed.stdout

    def _cue_avatar(self, pcm: bytes, *, flush: bool = True) -> bool:
        if not self.avatar_url or not pcm:
            return False
        try:
            from websockets.sync.client import connect

            with connect(
                self.avatar_url,
                open_timeout=2,
                close_timeout=2,
                max_size=16 * 1024 * 1024,
            ) as socket:
                socket.recv(timeout=2)
                if flush:
                    socket.send(json.dumps({"type": "flush"}))
                    while True:
                        flushed = socket.recv(timeout=2)
                        if isinstance(flushed, str) and json.loads(flushed).get("type") == "flushed":
                            break
                socket.send(
                    json.dumps(
                        {"type": "audio", "pcm": base64.b64encode(pcm).decode("ascii")}
                    )
                )
                # Keep the local socket open until the server has consumed the
                # large audio event. A pong is ordered after feed() in the same
                # WebSocket stream, so closing after it cannot truncate audio.
                socket.send(json.dumps({"type": "ping"}))
                while True:
                    reply = socket.recv(timeout=2)
                    if isinstance(reply, str) and json.loads(reply).get("type") == "pong":
                        break
            return True
        except Exception:
            return False

    def _store_avatar(self, pcm: bytes) -> str:
        now = time.monotonic()
        with self._pending_avatar_lock:
            self._pending_avatar = {
                cue_id: item
                for cue_id, item in self._pending_avatar.items()
                if now - item[0] <= 30.0
            }
            while len(self._pending_avatar) >= 8:
                oldest = min(self._pending_avatar, key=lambda cue_id: self._pending_avatar[cue_id][0])
                self._pending_avatar.pop(oldest, None)
            cue_id = uuid.uuid4().hex
            self._pending_avatar[cue_id] = (now, pcm)
            return cue_id

    def cue_pending_avatar(self, cue_id: str, *, flush: bool = True) -> bool:
        with self._pending_avatar_lock:
            item = self._pending_avatar.pop(cue_id, None)
        if item is None or time.monotonic() - item[0] > 30.0:
            return False
        return self._cue_avatar(item[1], flush=flush)

    def discard_pending_avatar(self, cue_id: str) -> bool:
        with self._pending_avatar_lock:
            return self._pending_avatar.pop(cue_id, None) is not None

    def flush_avatar(self) -> bool:
        if not self.avatar_url:
            return False
        try:
            from websockets.sync.client import connect

            with connect(
                self.avatar_url,
                open_timeout=2,
                close_timeout=2,
                max_size=16 * 1024 * 1024,
            ) as socket:
                socket.recv(timeout=2)
                socket.send(json.dumps({"type": "flush"}))
                while True:
                    reply = socket.recv(timeout=2)
                    if isinstance(reply, str) and json.loads(reply).get("type") == "flushed":
                        return True
        except Exception:
            return False

    def synthesize(
        self,
        text: str,
        *,
        cue_avatar: bool = True,
        avatar_flush: bool = True,
        defer_avatar: bool = False,
    ) -> tuple[bytes, float, float, bool, str]:
        clean = " ".join(text.strip().split())
        if not clean:
            raise ValueError("text is empty")
        started = time.perf_counter()
        with self._lock, self._torch.inference_mode():
            acquired = time.perf_counter()
            wavs, sample_rate = self.model.generate_voice_clone(
                text=clean,
                language=self.language,
                voice_clone_prompt=self.voice_prompt,
                non_streaming_mode=True,
            )
        generated = time.perf_counter()
        duration = len(wavs[0]) / int(sample_rate)
        pcm = self._pcm16_16k(wavs[0], int(sample_rate))
        avatar_cue_id = self._store_avatar(pcm) if cue_avatar and defer_avatar else ""
        avatar_cued = (
            self._cue_avatar(pcm, flush=avatar_flush)
            if cue_avatar and not defer_avatar
            else False
        )
        prepared = time.perf_counter()
        opus_audio = self._encode_opus(wavs[0], int(sample_rate))
        total_elapsed = time.perf_counter() - started
        print(json.dumps({
            "event": "tts_timing",
            "queue_s": round(acquired - started, 3),
            "generation_s": round(generated - acquired, 3),
            "avatar_prepare_s": round(prepared - generated, 3),
            "encode_s": round(total_elapsed - (prepared - started), 3),
            "total_s": round(total_elapsed, 3),
            "audio_duration_s": round(duration, 3),
        }), flush=True)
        self.last_elapsed_s = total_elapsed
        return opus_audio, duration, total_elapsed, avatar_cued, avatar_cue_id


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200)
    avatar_flush: bool = True
    defer_avatar: bool = False


class AvatarCueRequest(BaseModel):
    cue_id: str = Field(min_length=16, max_length=64)
    avatar_flush: bool = True


class AvatarDiscardRequest(BaseModel):
    cue_id: str = Field(min_length=16, max_length=64)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = await asyncio.to_thread(NathanEngine)
    yield
    app.state.engine = None


app = FastAPI(title="Family AI Teacher Nathan TTS", version="1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, object]:
    engine = getattr(app.state, "engine", None)
    return {
        "status": "ok" if engine is not None else "starting",
        "backend": "nathan-qwen3-tts-remote",
        "last_elapsed_s": getattr(engine, "last_elapsed_s", None),
        "raw_audio_persisted": False,
    }


@app.post("/synthesize")
async def synthesize(request: SynthesisRequest) -> Response:
    engine: NathanEngine | None = getattr(app.state, "engine", None)
    if engine is None:
        raise HTTPException(status_code=503, detail="Nathan TTS is still starting")
    try:
        audio, duration, elapsed, avatar_cued, avatar_cue_id = await asyncio.to_thread(
            engine.synthesize,
            request.text,
            avatar_flush=request.avatar_flush,
            defer_avatar=request.defer_avatar,
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Nathan TTS failed: {type(exc).__name__}") from exc
    headers = {
        "X-TTS-Duration-S": f"{duration:.3f}",
        "X-TTS-Elapsed-S": f"{elapsed:.3f}",
        "X-TTS-Backend": "self-host",
        "X-Avatar-Cued": "1" if avatar_cued else "0",
        "X-Avatar-Lead-Ms": str(
            engine.avatar_lead_ms if avatar_cued and request.avatar_flush else 0
        ),
        "Cache-Control": "no-store",
    }
    if avatar_cue_id:
        headers["X-Avatar-Cue-ID"] = avatar_cue_id
    return Response(
        content=audio,
        media_type="audio/webm",
        headers=headers,
    )


@app.post("/avatar/cue")
async def cue_avatar(request: AvatarCueRequest) -> dict[str, object]:
    engine: NathanEngine | None = getattr(app.state, "engine", None)
    if engine is None:
        raise HTTPException(status_code=503, detail="Nathan TTS is still starting")
    cued = await asyncio.to_thread(
        engine.cue_pending_avatar,
        request.cue_id,
        flush=request.avatar_flush,
    )
    return {
        "cued": cued,
        "avatar_audio_lead_ms": engine.avatar_lead_ms if cued and request.avatar_flush else 0,
    }


@app.post("/avatar/discard")
async def discard_avatar(request: AvatarDiscardRequest) -> dict[str, bool]:
    engine: NathanEngine | None = getattr(app.state, "engine", None)
    if engine is None:
        raise HTTPException(status_code=503, detail="Nathan TTS is still starting")
    return {"discarded": engine.discard_pending_avatar(request.cue_id)}


@app.post("/avatar/flush")
async def flush_avatar() -> dict[str, bool]:
    engine: NathanEngine | None = getattr(app.state, "engine", None)
    if engine is None:
        raise HTTPException(status_code=503, detail="Nathan TTS is still starting")
    return {"flushed": await asyncio.to_thread(engine.flush_avatar)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.getenv("TTS_PORT", "8792")),
        access_log=False,
    )
