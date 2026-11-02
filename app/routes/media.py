"""Trusted media search and generated picture jobs."""

from __future__ import annotations

import asyncio
import re
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.media import canonical_media_topic, normalize_image_subject

from .. import deps
from ..activity_flow import _blocked_content_topic
from ..schemas import MediaSuggestionRequest

router = APIRouter()


@router.post("/api/media/suggestions")
async def media_suggestions(
    request: MediaSuggestionRequest,
) -> dict[str, Any]:
    """The explicit media subject is sent, without family context or raw media."""
    topic = normalize_image_subject(request.topic)
    if not topic or topic != request.topic.strip():
        raise HTTPException(status_code=422, detail="请提供明确的图片或学习资料主题")
    if _blocked_content_topic(topic, deps.memory.get_child_profile()):
        raise HTTPException(status_code=422, detail="这个主题不在当前家庭允许的内容中")
    if request.kind != "image":
        return await asyncio.to_thread(deps.public_learning_search.search, topic, request.kind, deps.settings)
    generation = deps.image_generator.request(topic, request.image_job_id) if request.generate_image else None
    # Start generation first, while a fast known-subject image lookup runs independently.
    result = await asyncio.to_thread(deps.media_search.search, topic) if canonical_media_topic(topic) else {
        "topic": topic, "cards": [], "online_search": False, "reason": "no_suitable_result"}
    if generation is None:
        return result
    result["image_generation"] = generation["status"]
    if generation["status"] in {"queued", "running"}:
        result["image_generation_job"] = generation
    elif generation["status"] == "completed" and generation.get("card"):
        result["cards"] = [generation["card"], *result.get("cards", [])]
    return result


@router.get("/api/image-generation/jobs/{job_id}")
async def image_generation_status(job_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(status_code=404, detail="image generation job not found")
    result = deps.image_generator.status(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail="image generation job not found")
    return result


@router.post("/api/image-generation/jobs/{job_id}/cancel")
async def cancel_image_generation(job_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(status_code=404, detail="image generation job not found")
    result = deps.image_generator.cancel(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail="image generation job not found")
    return result


@router.get("/api/generated-media/{filename}")
async def generated_media(filename: str) -> FileResponse:
    if not re.fullmatch(r"[0-9a-f]{24}\.png", filename):
        raise HTTPException(status_code=404, detail="generated image not found")
    path = deps.image_generator.safe_file(filename)
    if path is None:
        raise HTTPException(status_code=404, detail="generated image not found")
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"},
    )
