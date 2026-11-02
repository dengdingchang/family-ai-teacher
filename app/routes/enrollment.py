"""Parent voice/portrait enrolment and family-data export or deletion."""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from app.parent_avatar import ParentAvatarError
from app.parent_enrollment import EnrollmentError, check_portrait, check_voice, decode_media
from tts.adapter import TTSAdapterError
from tts.streaming import StreamingNathanTTSAdapter

from .. import deps
from ..guards import _require_enrollment_request
from ..schemas import FamilyDataDeleteRequest
from ..text_utils import _child_nickname

router = APIRouter()


@router.get("/api/parent/enrollment")
async def parent_enrollment_status() -> dict[str, Any]:
    return {"active": deps.parent_enrollment.active(),
            "voice_supported": deps.settings.tts_mode == "streaming"}


@router.post("/api/parent/enrollment/preview")
async def preview_parent_enrollment(request: Request) -> dict[str, Any]:
    _require_enrollment_request(request)
    if deps.settings.tts_mode != "streaming" or not isinstance(deps.tts, StreamingNathanTTSAdapter):
        raise HTTPException(status_code=503, detail="当前声音运行模式还不能生成家长试听")
    try:
        claimed_size = int(request.headers.get("content-length", "0") or "0")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="录制内容格式不正确") from exc
    if claimed_size > 4_000_000:
        raise HTTPException(status_code=413, detail="录制内容过大，请重录")
    raw = await request.body()
    if len(raw) > 4_000_000:
        raise HTTPException(status_code=413, detail="录制内容过大，请重录")
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise EnrollmentError("录制内容格式不正确")
        if payload.get("consent") is not True:
            raise EnrollmentError("请先确认这是你本人的声音和形象")
        portrait = decode_media(payload.get("portrait", ""), limit=700_000)
        wav = decode_media(payload.get("voice", ""), limit=2_200_000)
        portrait, picture_quality = check_portrait(portrait)
        voice_quality = check_voice(wav)
        embedding, sample = await asyncio.to_thread(deps.tts.prepare_parent_voice, wav)
        token = deps.parent_enrollment.stage(portrait, embedding)
    except (EnrollmentError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except TTSAdapterError as exc:
        raise HTTPException(status_code=503, detail="声音试听暂时无法生成，请稍后重试") from exc
    return {"token": token, "preview_audio": base64.b64encode(sample).decode("ascii"),
            "quality": {"picture": picture_quality, "voice": voice_quality}}


@router.post("/api/parent/enrollment/activate")
async def activate_parent_enrollment(request: Request) -> dict[str, Any]:
    _require_enrollment_request(request)
    payload = await request.json()
    try:
        token = str(payload.get("token", ""))
        portrait, embedding = deps.parent_enrollment.peek(token)
    except EnrollmentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    prior_path = deps.parent_enrollment.voice_path()
    prior_voice = prior_path.read_bytes() if prior_path else None
    prior_portrait_path = deps.parent_enrollment.portrait_path()
    prior_portrait = prior_portrait_path.read_bytes() if prior_portrait_path else None
    remote_changed = False
    try:
        await asyncio.to_thread(deps.tts.activate_parent_voice, embedding)
        remote_changed = True
        await asyncio.to_thread(deps.parent_avatar.activate, portrait)
        deps.parent_enrollment.commit(portrait, embedding)
        deps.parent_enrollment.discard(token)
    except (OSError, EnrollmentError, TTSAdapterError, ParentAvatarError) as exc:
        if remote_changed:
            try:
                if prior_portrait:
                    await asyncio.to_thread(deps.parent_avatar.activate, prior_portrait)
                else:
                    await asyncio.to_thread(deps.parent_avatar.restore)
            except ParentAvatarError:
                deps.logger.warning("Parent avatar rollback needs attention")
        try:
            if prior_voice:
                await asyncio.to_thread(deps.tts.activate_parent_voice, prior_voice)
            else:
                await asyncio.to_thread(deps.tts.restore_nathan_voice)
        except TTSAdapterError:
            deps.logger.warning("Parent enrollment voice rollback needs attention")
        try:
            if prior_portrait and prior_voice:
                deps.parent_enrollment.commit(prior_portrait, prior_voice)
            else:
                deps.parent_enrollment.clear(preserve_draft=True)
        except (OSError, EnrollmentError):
            deps.logger.warning("Parent enrollment file rollback needs attention")
        raise HTTPException(status_code=503, detail="启用暂未完成，可再次点击确认重试；原有老师保持可用") from exc
    return {"active": True, "avatar_configured": True}


@router.delete("/api/parent/enrollment")
async def delete_parent_enrollment(request: Request) -> dict[str, Any]:
    _require_enrollment_request(request)
    payload = await request.json()
    expected = _child_nickname(deps.memory.get_child_profile()) or "DELETE"
    if payload.get("confirmation") != expected:
        raise HTTPException(status_code=400, detail="确认文字与孩子昵称不一致")
    prior_path = deps.parent_enrollment.portrait_path()
    prior_portrait = prior_path.read_bytes() if prior_path else None
    prior_voice_path = deps.parent_enrollment.voice_path()
    prior_voice = prior_voice_path.read_bytes() if prior_voice_path else None
    try:
        await asyncio.to_thread(deps.parent_avatar.restore)
        await asyncio.to_thread(deps.tts.restore_nathan_voice)
        deps.parent_enrollment.clear()
    except (OSError, TTSAdapterError, ParentAvatarError) as exc:
        if prior_portrait:
            try:
                await asyncio.to_thread(deps.parent_avatar.activate, prior_portrait)
            except ParentAvatarError:
                deps.logger.warning("Parent avatar deletion rollback needs attention")
        if prior_voice:
            try:
                await asyncio.to_thread(deps.tts.activate_parent_voice, prior_voice)
            except TTSAdapterError:
                deps.logger.warning("Parent voice deletion rollback needs attention")
        raise HTTPException(status_code=503, detail="删除没有完成，请稍后重试") from exc
    return {"active": False}


@router.get("/api/parent/export")
async def parent_export() -> dict[str, Any]:
    return deps.memory.export_bundle()


@router.post("/api/parent/data/delete")
async def delete_parent_data(request: FamilyDataDeleteRequest) -> dict[str, Any]:
    """Owner-only destructive action guarded by the current child nickname."""

    profile = deps.memory.get_child_profile()
    expected = _child_nickname(profile) or "DELETE"
    if request.confirmation.strip() != expected:
        raise HTTPException(status_code=400, detail="确认文字与当前宝贝昵称不一致")
    try:
        result = deps.memory.delete_family_data(request.scopes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, **result}
