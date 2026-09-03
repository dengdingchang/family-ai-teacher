"""Single-process local Family AI Teacher MVP."""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
import queue
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from camera.adapter import BrowserCameraAdapter, CameraAdapterError
from llm.client import LLMError, LLMNotConfiguredError, OpenAICompatibleClient
from memory.store import MemoryStore
from stt.adapter import FasterWhisperCPUAdapter, STTAdapterError
from tts.adapter import NathanTTSAdapter, TTSAdapterError
from tts.persistent import PersistentNathanTTSAdapter

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
tts = (
    PersistentNathanTTSAdapter(settings)
    if settings.tts_mode == "persistent"
    else NathanTTSAdapter(settings)
)
llm = OpenAICompatibleClient(settings)
camera = BrowserCameraAdapter()

app = FastAPI(title="Family AI Teacher", version="0.2.0")


@app.on_event("shutdown")
async def shutdown_tts() -> None:
    shutdown = getattr(tts, "shutdown", None)
    if shutdown is not None:
        await asyncio.to_thread(shutdown)


class TextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)


def _system_prompt(
    profile: dict[str, Any],
    recent: list[dict[str, Any]],
    learning_events: list[dict[str, Any]],
    vision_context: str = "",
) -> str:
    profile_json = json.dumps(profile, ensure_ascii=False)
    recent_json = json.dumps(recent[-4:], ensure_ascii=False)
    events_json = json.dumps(learning_events[-4:], ensure_ascii=False)
    return (
        "你是‘Nathan 设计的 AI 爸爸老师’，不是 Nathan 本人。\n"
        "孩子年龄：4 岁。\n"
        "请用中文为主，句子短，一次只讲一个概念，多鼓励孩子回答。"
        "每次最多回答2句，每句尽量不超过25个汉字。不要使用 Markdown 符号。不要连续输出长篇内容。"
        "尽量通过提问、故事、游戏教学数字、颜色、动物、英语启蒙、画画和故事。"
        "不要声称是真人 Nathan 正在实时说话；表达为 Nathan 设计的 AI 爸爸老师。\n"
        f"孩子资料：{profile_json}\n"
        f"最近对话（仅作短期上下文）：{recent_json}\n"
        f"最近学习事件（仅作短期文字上下文）：{events_json}"
        + (f"\n刚刚由 AI Station Vision 看到的画面（只作本轮上下文）：{vision_context}" if vision_context else "")
    )


def _messages_for(text: str, vision_context: str = "") -> list[dict[str, Any]]:
    recent = memory.get_recent_context()
    learning_events = memory.get_recent_learning_events()
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": _system_prompt(memory.get_child_profile(), recent, learning_events, vision_context),
        }
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


def _clean_text(text: str) -> str:
    clean_text = " ".join(text.strip().split())
    if not clean_text:
        raise HTTPException(status_code=400, detail="没有识别到可回答的文字")
    if len(clean_text) > 500:
        raise HTTPException(status_code=400, detail="这句话太长了，请分成短句再说")
    return clean_text


async def _answer_text(text: str, stt_result: Any | None = None) -> dict[str, Any]:
    clean_text = _clean_text(text)
    if not llm.configured:
        raise HTTPException(
            status_code=503,
            detail="AI Station 尚未配置：请在 .env 填写 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL",
        )

    started = time.perf_counter()
    try:
        llm_result = await asyncio.to_thread(llm.chat, _messages_for(clean_text), 96)
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


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _completed_sentences(buffer: str) -> tuple[list[str], str]:
    """Split short Chinese responses early enough for sentence-level TTS."""

    completed: list[str] = []
    remaining = buffer
    punctuation = set("。！？!?；;\n")
    while remaining:
        boundary = next((index for index, char in enumerate(remaining) if char in punctuation), -1)
        if boundary < 0:
            if len(remaining) < 72:
                break
            comma = max(remaining.rfind("，", 0, 72), remaining.rfind(",", 0, 72))
            boundary = comma if comma >= 16 else 71
        sentence = remaining[: boundary + 1].strip()
        remaining = remaining[boundary + 1 :]
        if sentence:
            completed.append(sentence)
    return completed, remaining


async def _stream_conversation(
    clean_text: str,
    stt_result: Any | None = None,
    vision_context: str = "",
):
    """Stream LLM deltas while a single persistent TTS worker speaks sentences in order."""

    events: queue.Queue[dict[str, Any]] = queue.Queue()
    tts_jobs: queue.Queue[dict[str, Any]] = queue.Queue()
    state: dict[str, Any] = {
        "assistant_text": "",
        "llm_elapsed_s": None,
        "tts_error": None,
        "audio_count": 0,
    }
    started = time.perf_counter()
    events.put({"event": "user_text", "text": clean_text})
    if vision_context:
        events.put({"event": "vision_context", "description": vision_context})

    def produce_llm() -> None:
        buffer = ""
        tail = ""
        first_sentence_sent = False
        llm_started = time.perf_counter()
        try:
            for delta in llm.stream_chat(_messages_for(clean_text, vision_context), max_tokens=64):
                delta_text = str(delta)
                state["assistant_text"] += delta_text
                events.put({"event": "assistant_delta", "text": delta_text})
                if first_sentence_sent:
                    tail += delta_text
                    continue
                buffer += delta_text
                sentences, buffer = _completed_sentences(buffer)
                if sentences:
                    tts_jobs.put({"kind": "sentence", "text": sentences[0]})
                    first_sentence_sent = True
                    tail = "".join(sentences[1:]) + buffer
                    buffer = ""
            remaining = tail if first_sentence_sent else buffer
            if remaining.strip():
                tts_jobs.put({"kind": "sentence", "text": remaining.strip()})
            state["llm_elapsed_s"] = round(time.perf_counter() - llm_started, 3)
            tts_jobs.put({"kind": "finish"})
        except Exception as exc:
            state["llm_elapsed_s"] = round(time.perf_counter() - llm_started, 3)
            state["tts_error"] = f"LLM: {exc}"
            events.put({"event": "error", "message": str(exc)[:280] or "AI Station streaming failed"})
            tts_jobs.put({"kind": "finish"})

    def speak_sentences() -> None:
        while True:
            job = tts_jobs.get()
            if job.get("kind") == "finish":
                assistant_text = str(state["assistant_text"]).strip()
                if state["tts_error"] is None and assistant_text:
                    try:
                        memory.save_session_turn(clean_text, assistant_text)
                        memory.save_learning_event(
                            "conversation",
                            {"user_text": clean_text, "assistant_text": assistant_text},
                        )
                    except OSError as exc:
                        state["tts_error"] = f"本地文字记录失败: {exc}"
                events.put(
                    {
                        "event": "done",
                        "ok": state["tts_error"] is None and bool(assistant_text),
                        "user_text": clean_text,
                        "assistant_text": assistant_text,
                        "audio_count": state["audio_count"],
                        "stt_elapsed_s": getattr(stt_result, "elapsed_s", None),
                        "llm_elapsed_s": state["llm_elapsed_s"],
                        "total_elapsed_s": round(time.perf_counter() - started, 3),
                    }
                )
                events.put({"event": "end"})
                return
            if state["tts_error"] is not None:
                continue
            try:
                result = tts.synthesize(str(job.get("text", "")))
                state["audio_count"] += 1
                events.put(
                    {
                        "event": "audio",
                        "sequence": state["audio_count"],
                        "audio_base64": base64.b64encode(result.audio_bytes).decode("ascii"),
                        "audio_mime": "audio/wav",
                        "audio_duration_s": result.duration_s,
                        "tts_elapsed_s": result.elapsed_s,
                        "tts_gpu": _gpu_payload(result.gpu),
                    }
                )
            except Exception as exc:
                state["tts_error"] = str(exc)
                events.put({"event": "error", "message": str(exc)[:280] or "TTS failed"})

    llm_thread = threading.Thread(target=produce_llm, name="family-llm-stream", daemon=True)
    tts_thread = threading.Thread(target=speak_sentences, name="family-tts-stream", daemon=True)
    tts_thread.start()
    llm_thread.start()
    while True:
        payload = await asyncio.to_thread(events.get)
        if payload.get("event") == "end":
            break
        yield _sse(payload)


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
        "tts_mode": settings.tts_mode,
        "camera": "browser_preview_and_explicit_capture",
        "raw_audio_persisted": False,
        "raw_video_persisted": False,
        "automatic_frame_upload": True,
        "automatic_frame_upload_only_with_next_voice_turn": True,
        "automatic_vision_during_conversation": True,
        "automatic_vision_interval_s": 15,
        "manual_video_analysis": "temporary_keyframes",
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


@app.post("/api/conversation/stream")
async def streaming_conversation(
    audio: UploadFile = File(...),
    frame: UploadFile | None = File(default=None),
) -> StreamingResponse:
    transcription = await transcribe(audio)
    clean_text = _clean_text(str(transcription["text"]))
    if not llm.configured:
        raise HTTPException(
            status_code=503,
            detail="AI Station 尚未配置：请在 .env 填写 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL",
        )
    vision_context = ""
    if frame is not None:
        try:
            frame_bytes = await frame.read()
            camera.capture_frame(frame_bytes, content_type=frame.content_type or "image/jpeg")
            vision_result = await asyncio.to_thread(
                llm.describe_image,
                frame_bytes,
                frame.content_type or "image/jpeg",
                f"孩子刚刚说：{clean_text}\n请只根据这张图片，告诉爸爸老师一个适合4岁孩子的可见事实，并给出一个可以回应孩子的简单问题。",
            )
            vision_context = vision_result.text
            memory.save_learning_event(
                "vision_auto",
                {"trigger": "conversation_frame", "description": vision_context},
            )
        except (CameraAdapterError, LLMError, OSError):
            # Vision is an enhancement; a bad/expired frame must not block speech.
            vision_context = ""
    return StreamingResponse(
        _stream_conversation(clean_text, stt_result=transcription, vision_context=vision_context),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/conversation/text/stream")
async def streaming_text_conversation(request: TextRequest) -> StreamingResponse:
    clean_text = _clean_text(request.text)
    if not llm.configured:
        raise HTTPException(
            status_code=503,
            detail="AI Station 尚未配置：请在 .env 填写 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL",
        )
    return StreamingResponse(
        _stream_conversation(clean_text),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/conversation/frame/stream")
async def streaming_frame_conversation(request: Request) -> StreamingResponse:
    """Let a manually captured photo start a normal spoken conversation turn."""

    image_bytes = await request.body()
    content_type = request.headers.get("content-type", "image/jpeg")
    try:
        camera.capture_frame(image_bytes, content_type=content_type)
    except CameraAdapterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not llm.configured:
        raise HTTPException(status_code=503, detail="AI Station 尚未配置")
    try:
        vision_result = await asyncio.to_thread(
            llm.describe_image,
            image_bytes,
            content_type,
            "请只根据这张照片，用适合4岁孩子的简短中文说出一个可见事实，帮助爸爸老师主动和孩子聊一句。",
            120,
        )
    except LLMNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    memory.save_learning_event(
        "vision",
        {"operation": "conversation-frame", "description": vision_result.text},
    )
    return StreamingResponse(
        _stream_conversation("爸爸你看", vision_context=vision_result.text),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
        "automatic_upload": True,
        "automatic_upload_only_with_next_voice_turn": True,
        "persisted": False,
        "automatic_vision_during_conversation": True,
        "automatic_vision_interval_s": 15,
        "manual_vision_requires_explicit_click": True,
        "manual_video_analysis": "/api/vision/describe-video",
    }


@app.post("/api/camera/capture")
async def capture_frame(request: Request) -> dict[str, Any]:
    image_bytes = await request.body()
    content_type = request.headers.get("content-type", "image/jpeg")
    try:
        return camera.capture_frame(image_bytes, content_type=content_type)
    except CameraAdapterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _vision_request(request: Request, operation: str) -> dict[str, Any]:
    image_bytes = await request.body()
    content_type = request.headers.get("content-type", "image/jpeg")
    try:
        camera.capture_frame(image_bytes, content_type=content_type)
    except CameraAdapterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not llm.configured:
        raise HTTPException(status_code=503, detail="AI Station 尚未配置")
    if operation == "describe-frame":
        prompt = "请用适合4岁孩子的简短中文，只说画面中最重要的一个物体或场景，然后问孩子一个简单问题。"
    else:
        prompt = "请用适合4岁孩子的简短中文，只描述画面里可见的物体和活动，不判断身份、情绪或健康，然后问孩子一个问题。"
    try:
        result = await asyncio.to_thread(llm.describe_image, image_bytes, content_type, prompt)
    except LLMNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    memory.save_learning_event(
        "vision",
        {"operation": operation, "description": result.text},
    )
    return {
        "operation": operation,
        "description": result.text,
        "elapsed_s": result.elapsed_s,
        "persisted_image": False,
    }


@app.post("/api/vision/describe-frame")
async def describe_frame(request: Request) -> dict[str, Any]:
    return await _vision_request(request, "describe-frame")


@app.post("/api/vision/observe-child")
async def observe_child(request: Request) -> dict[str, Any]:
    return await _vision_request(request, "observe-child")


@app.post("/api/vision/describe-video")
async def describe_video(video: UploadFile = File(...)) -> dict[str, Any]:
    """Analyze a short child clip through a few temporary keyframes.

    AI Station currently receives image content through the OpenAI-compatible
    Vision contract. The clip itself is never persisted; ffmpeg extracts up to
    three frames in the OS temp directory and deletes them before returning.
    """

    if not video.filename:
        raise HTTPException(status_code=400, detail="没有收到视频文件")
    video_bytes = await video.read()
    if not video_bytes:
        raise HTTPException(status_code=400, detail="视频为空")
    if len(video_bytes) > camera.MAX_VIDEO_BYTES:
        raise HTTPException(status_code=413, detail="视频文件过大")
    try:
        keyframes = await asyncio.to_thread(
            camera.extract_video_keyframes,
            video_bytes,
            video.filename,
        )
    except CameraAdapterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not llm.configured:
        raise HTTPException(status_code=503, detail="AI Station 尚未配置")
    prompt = (
        "下面是同一段儿童短视频的关键画面。请只根据可见内容，用适合4岁孩子的简短中文，"
        "说明孩子可能正在做的一个动作或正在接触的物体，并问孩子一个简单问题。"
        "不要猜测身份、情绪、健康或画面之外的连续过程。"
    )
    try:
        result = await asyncio.to_thread(
            llm.describe_images,
            [(frame, "image/jpeg") for frame in keyframes],
            prompt,
            120,
        )
    except LLMNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    memory.save_learning_event(
        "vision_video",
        {"frames": len(keyframes), "description": result.text},
    )
    return {
        "operation": "describe-video-keyframes",
        "description": result.text,
        "frames": len(keyframes),
        "elapsed_s": result.elapsed_s,
        "persisted_video": False,
        "persisted_frames": False,
    }


@app.post("/api/conversation/video/stream")
async def streaming_video_conversation(video: UploadFile = File(...)) -> StreamingResponse:
    """Turn a manually recorded action clip into a spoken assistant turn."""

    analysis = await describe_video(video)
    return StreamingResponse(
        _stream_conversation("爸爸你看我刚才做的动作", vision_context=str(analysis["description"])),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/memory/context")
async def memory_context() -> dict[str, Any]:
    return {
        "profile": memory.get_child_profile(),
        "recent_context": memory.get_recent_context(),
        "recent_learning_events": memory.get_recent_learning_events(),
    }


@app.get("/api/avatar")
async def avatar() -> FileResponse:
    path, media_type = _avatar_path()
    return FileResponse(path, media_type=media_type)


app.mount("/", StaticFiles(directory=str(settings.frontend_dir), html=True), name="frontend")
