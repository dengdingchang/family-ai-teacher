"""Parent-space messages, dashboard summary and play receipts."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from .. import deps
from ..guards import _same_origin_request
from ..profiles import _profile_for_client
from ..schemas import ActivityPlayRequest, ParentMessageRequest

router = APIRouter()


@router.get("/api/parent/messages")
async def get_parent_messages() -> dict[str, Any]:
    messages = deps.memory.get_parent_messages(limit=None)
    return {"messages": messages, "count": len(messages)}


@router.post("/api/parent/messages")
async def create_parent_message(request: ParentMessageRequest) -> dict[str, Any]:
    try:
        return deps.memory.add_parent_message(request.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/parent/messages/{message_id}/cancel")
async def cancel_parent_message(message_id: str) -> dict[str, Any]:
    try:
        return deps.memory.cancel_parent_message(message_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="parent message not found") from exc


@router.get("/api/parent/dashboard")
async def parent_dashboard() -> dict[str, Any]:
    dashboard = deps.memory.get_parent_dashboard()
    dashboard["profile"] = _profile_for_client(dashboard.get("profile", {}))
    dashboard["brain"] = {
        "mode": dashboard.get("profile", {}).get("brain_mode", "ai_station"),
        "provider": "AI Station",
        "model": deps.settings.llm_model or "未配置",
        "configured": deps.llm.configured,
    }
    return dashboard


@router.get("/api/activities/summary")
async def activity_summary() -> dict[str, Any]:
    return deps.memory.get_activity_summary()


@router.post("/api/activities/event")
async def record_activity_play(request: ActivityPlayRequest) -> dict[str, Any]:
    try:
        recorded = await asyncio.to_thread(deps.memory.record_activity_event, request.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail="这次活动进度暂未保存") from exc
    return {"ok": True, "recorded": recorded,
            "summary": deps.memory.get_activity_summary() if request.kind == "challenge" else None}


@router.post("/api/parent/rewards/{reward_id}/redeem")
async def redeem_activity_reward(reward_id: str, request: Request) -> dict[str, Any]:
    if request.headers.get("x-family-parent-action") != "redeem" or not _same_origin_request(request):
        raise HTTPException(status_code=403, detail="请从家长空间确认兑换")
    try:
        redeemed = await asyncio.to_thread(deps.memory.redeem_activity_reward, reward_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=404, detail="没有找到这份礼物") from exc
    return {"ok": True, "redeemed": redeemed}
