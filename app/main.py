"""Single-process local Family AI Teacher MVP."""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from camera.adapter import BrowserCameraAdapter, CameraAdapterError
from llm.client import LLMError, LLMNotConfiguredError, OpenAICompatibleClient
from memory.store import MemoryStore
from stt.adapter import FasterWhisperCPUAdapter, STTAdapterError
from tts.adapter import NathanTTSAdapter, TTSAdapterError

from .config import Settings


settings = Settings.load()
settings.data_dir.mkdir(parents=True, exist_ok=True)
memory = MemoryStore(
    data_dir=settings.data_dir,
    profile_path=settings.profile_path,
    history_path=settings.history_path,
    learning_events_path=settings.learning_events_path,
    template_path=settings.project_root / "config" / "child_profile.example.json",
)
stt = FasterWhisperCPUAdapter(settings)
tts = NathanTTSAdapter(settings)
llm = OpenAICompatibleClient(settings)
camera = BrowserCameraAdapter()

app = FastAPI(title="Family AI Teacher", version="0.1.0")


class TextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)


def _system_prompt(profile: dict[str, Any], recent: list[dict[str, Any]]) -> str:
    profile_json = json.dumps(profile, ensure_ascii=False)
    recent_json = json.dumps(recent[-4:], ensure_ascii=False)
    return (
        "你是‘Nathan 设计的 AI 爸爸老师’，不是 Nathan 本人。\n"
        "孩子年龄：4 岁。\n"
        "请用中文为主，句子短，一次只讲一个概念，多鼓励孩子回答。"
        "不要连续输出长篇内容。尽量通过提问、故事、游戏教学数字、颜色、动物、英语启蒙、画画和故事。"
        "不要声称是真人 Nathan 正在实时说话；表达为 Nathan 设计的 AI 爸爸老师。\n"
        f"孩子资料：{profile_json}\n"
        f"最近对话（仅作短期上下文）：{recent_json}"
    )


def _messages_for(text: str) -> list[dict[str, str]]:
    recent = memory.get_recent_context()
    messages: list[dict[str, str]] = [
        {"role": "system", "content": _system_prompt(memory.get_child_profile(), recent)}
    ]
    for record in recent[-4:]:
        user_text = str(record.get("user_text", "")).strip()
        assistant_text = str(record.get("assistant_text", "")).strip()
        if user_text:
            messages.append({"role": "user", "content": user_text})
        if assistant_text:
            messages.append({"role": "assistant", "content": assistant_text})
    messages.append({"role": "user", "content": text})
    return messages


def _gpu_payload(measurement: Any) -> dict[str, Any]:
    return {
        "available": measurement.available,
        "start_mib": measurement.start_mib,
        "peak_mib": measurement.peak_mib,
        "end_mib": measurement.end_mib,
        "sample_count": measurement.sample_count,
    }


def _avatar_path() -> tuple[Path, str]:
    configured = settings.avatar_image_path
    if configured and configured.is_file() and configured.suffix.lower() in {
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
    }:
        return configured, mimetypes.guess_type(configured.name)[0] or "image/jpeg"
    return settings.fallback_avatar_path, "image/svg+xml"


async def _answer_text(text: str, stt_result: Any | None = None) -> dict[str, Any]:
    clean_text = " ".join(text.strip().split())
    if not clean_text:
        raise HTTPException(status_code=400, detail="没有识别到可回答的文字")
    if len(clean_text) > 500:
        raise HTTPException(status_code=400, detail="这句话太长了，请分成短句再说")
    if not llm.configured:
        raise HTTPException(
            status_code=503,
            detail="AI Station 尚未配置：请在 .env 填写 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL",
        )

    started = time.perf_counter()
    try:
        llm_result = await asyncio.to_thread(llm.chat, _messages_for(clean_text))
        tts_result = await asyncio.to_thread(tts.synthesize, llm_result.text)
    except LLMNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except TTSAdapterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    # Only text is persisted. The TTS WAV is returned in memory and deleted by the adapter.
    memory.save_session_turn(clean_text, llm_result.text)
    memory.save_learning_event(
        "conversation",
        {"user_text": clean_text, "assistant_text": llm_result.text},
    )
    result: dict[str, Any] = {
        "user_text": clean_text,
        "assistant_text": llm_result.text,
        "audio_base64": base64.b64encode(tts_result.audio_bytes).decode("ascii"),
        "audio_mime": "audio/wav",
        "stt_elapsed_s": getattr(stt_result, "elapsed_s", None),
        "llm_elapsed_s": llm_result.elapsed_s,
        "tts_elapsed_s": tts_result.elapsed_s,
        "audio_duration_s": tts_result.duration_s,
        "total_elapsed_s": round(time.perf_counter() - started, 3),
        "tts_gpu": _gpu_payload(tts_result.gpu),
    }
    return result


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "app": "family-ai-teacher",
        "version": app.version,
        "bind": settings.app_host,
        "port": settings.app_port,
        "llm_configured": llm.configured,
        "stt_ready": stt.ready,
        "tts_ready": tts.ready,
        "camera": "browser_preview_and_explicit_capture",
        "raw_audio_persisted": False,
        "raw_video_persisted": False,
        "automatic_frame_upload": False,
    }


@app.get("/api/health/llm")
async def llm_health() -> dict[str, Any]:
    if not llm.configured:
        raise HTTPException(status_code=503, detail="LLM settings are incomplete in .env")
    ok, latency_s, detail = await asyncio.to_thread(llm.check_models)
    if not ok:
        raise HTTPException(status_code=502, detail={"ok": False, "latency_s": latency_s, "detail": detail})
    return {"ok": True, "latency_s": latency_s, "detail": detail, "model": settings.llm_model}


@app.get("/api/profile")
async def get_child_profile() -> dict[str, Any]:
    return memory.get_child_profile()


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> dict[str, Any]:
    if not audio.filename:
        raise HTTPException(status_code=400, detail="没有收到音频文件")
    raw = await audio.read()
    if not raw:
        raise HTTPException(status_code=400, detail="音频为空")
    if len(raw) > 16 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="音频文件过大")
    suffix = Path(audio.filename).suffix.lower() or ".webm"
    temporary = tempfile.NamedTemporaryFile(
        prefix="family-ai-teacher-stt-",
        suffix=suffix,
        dir=settings.temp_dir,
        delete=False,
    )
    temporary_path = Path(temporary.name)
    try:
        temporary.write(raw)
        temporary.close()
        try:
            result = await asyncio.to_thread(stt.transcribe, temporary_path)
        except STTAdapterError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {
            "text": result.text,
            "language": result.language,
            "audio_duration_s": result.duration_s,
            "elapsed_s": result.elapsed_s,
            "gpu": _gpu_payload(result.gpu),
        }
    finally:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            pass


@app.post("/api/conversation")
async def conversation(audio: UploadFile = File(...)) -> dict[str, Any]:
    transcription = await transcribe(audio)
    return await _answer_text(str(transcription["text"]), stt_result=transcription)


@app.post("/api/conversation/text")
async def text_conversation(request: TextRequest) -> dict[str, Any]:
    return await _answer_text(request.text)


@app.post("/api/tts")
async def synthesize_tts(request: TextRequest) -> dict[str, Any]:
    try:
        result = await asyncio.to_thread(tts.synthesize, request.text)
    except TTSAdapterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "audio_base64": base64.b64encode(result.audio_bytes).decode("ascii"),
        "audio_mime": "audio/wav",
        "audio_duration_s": result.duration_s,
        "elapsed_s": result.elapsed_s,
        "gpu": _gpu_payload(result.gpu),
    }


@app.get("/api/camera/status")
async def camera_status() -> dict[str, Any]:
    return {
        "preview": "browser",
        "capture_frame": "/api/camera/capture",
        "automatic_upload": False,
        "persisted": False,
    }


@app.post("/api/camera/capture")
async def capture_frame(request: Request) -> dict[str, Any]:
    image_bytes = await request.body()
    content_type = request.headers.get("content-type", "image/jpeg")
    try:
        return camera.capture_frame(image_bytes, content_type=content_type)
    except CameraAdapterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/vision/describe-frame")
async def describe_frame() -> None:
    raise HTTPException(status_code=501, detail="Phase 2: describe_frame() uses AI Station Vision")


@app.post("/api/vision/observe-child")
async def observe_child() -> None:
    raise HTTPException(status_code=501, detail="Phase 2: observe_child() uses AI Station Vision")


@app.get("/api/avatar")
async def avatar() -> FileResponse:
    path, media_type = _avatar_path()
    return FileResponse(path, media_type=media_type)


app.mount("/", StaticFiles(directory=str(settings.frontend_dir), html=True), name="frontend")
