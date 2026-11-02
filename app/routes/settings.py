"""Child profile editing and the parent-only model settings."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from app.model_settings import ConfigurationConflict, candidate_settings, public_settings, save_settings
from llm.client import LLMError, LLMNotConfiguredError, OpenAICompatibleClient

from .. import deps
from ..guards import _require_local_settings_request
from ..profiles import _profile_for_client
from ..schemas import ProfileUpdateRequest
from ..text_utils import _child_nickname

router = APIRouter()


@router.get("/api/profile")
async def get_child_profile() -> dict[str, Any]:
    return _profile_for_client(deps.memory.get_child_profile())


@router.get("/api/parent/models")
async def parent_models(request: Request) -> dict[str, Any]:
    _require_local_settings_request(request)
    return public_settings(deps.settings, deps.settings.project_root / ".env")


@router.post("/api/parent/models/test")
async def test_parent_models(request: Request) -> dict[str, Any]:
    _require_local_settings_request(request)
    try:
        values = await request.json()
        if not isinstance(values, dict):
            raise ValueError("设置格式无效")
        candidate = candidate_settings(deps.settings, values)
        client = OpenAICompatibleClient(candidate)
        # A model list does not prove this particular model can answer.
        result = await asyncio.to_thread(client.chat, [{"role": "user", "content": "只回复：连接成功"}], 40)
        return {"ok": True, "model": candidate.llm_model, "latency_s": result.elapsed_s}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except (LLMError, LLMNotConfiguredError):
        raise HTTPException(status_code=502, detail="连接测试失败，请检查地址、密钥、模型权限和网络") from None


@router.post("/api/parent/models")
async def update_parent_models(request: Request) -> dict[str, Any]:
    _require_local_settings_request(request)
    try:
        values = await request.json()
        if not isinstance(values, dict):
            raise ValueError("设置格式无效")
        candidate = candidate_settings(deps.settings, values)
        image_changed = candidate.imagegen_provider != deps.settings.imagegen_provider or (
            candidate.imagegen_provider == "openai" and candidate.llm_api_key != deps.settings.llm_api_key)
        next_generator = deps._build_image_generator(candidate) if image_changed else None
        deps.replace("settings", save_settings(deps.settings, values, deps.settings.project_root / ".env"))
        deps.replace("llm", OpenAICompatibleClient(deps.settings))
        if next_generator is not None:
            previous_generator = deps.image_generator
            deps.replace("image_generator", next_generator)
            await asyncio.to_thread(previous_generator.shutdown)
    except ConfigurationConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except OSError:
        raise HTTPException(status_code=500, detail="本机设置保存失败，原配置仍保留") from None
    return {"ok": True, **public_settings(deps.settings, deps.settings.project_root / ".env")}


@router.patch("/api/profile")
async def update_child_profile(request: ProfileUpdateRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    try:
        previous_name = _child_nickname(deps.memory.get_child_profile())
        updates = request.model_dump(exclude_none=True)
        if "daily_guidance" in updates:
            updates["daily_guidance_date"] = (
                datetime.now().astimezone().date().isoformat()
                if str(updates["daily_guidance"]).strip() else ""
            )
        else:
            updates.pop("daily_guidance_date", None)
        profile = deps.memory.update_child_profile(updates)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    nickname = _child_nickname(profile)
    if nickname and nickname != previous_name:
        # This only uses the already loaded local Nathan voice. It does not call
        # AI Station, start another model, or block the Mac deps.settings response.
        background_tasks.add_task(deps._prewarm_nickname, nickname)
    return _profile_for_client(profile)
