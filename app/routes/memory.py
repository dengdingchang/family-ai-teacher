"""Parent-editable memory notes and the child's skill graph."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from .. import deps
from ..schemas import MemoryCreateRequest, MemoryUpdateRequest, SkillUpdateRequest

router = APIRouter()


@router.get("/api/memory/history")
async def memory_history() -> dict[str, Any]:
    """Return the complete text-only history for the local conversation view."""

    history = deps.memory.get_history()
    return {"history": history, "count": len(history)}


@router.get("/api/memories")
async def list_memories(status: str = "") -> dict[str, Any]:
    if status and status not in {"candidate", "durable"}:
        raise HTTPException(status_code=400, detail="status must be candidate or durable")
    items = deps.memory.get_memories(status=status, limit=None)
    return {"memories": items, "count": len(items)}


@router.post("/api/memories")
async def create_memory(request: MemoryCreateRequest) -> dict[str, Any]:
    try:
        return deps.memory.add_memory(
            request.summary,
            category=request.category,
            status=request.status,
            source="parent",
            confidence=1.0,
            tags=request.tags,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/api/memories/{memory_id}")
async def update_memory(memory_id: str, request: MemoryUpdateRequest) -> dict[str, Any]:
    try:
        return deps.memory.update_memory(memory_id, request.model_dump(exclude_none=True))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="deps.memory not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/api/memories/{memory_id}")
async def delete_memory(memory_id: str) -> dict[str, Any]:
    if not deps.memory.delete_memory(memory_id):
        raise HTTPException(status_code=404, detail="deps.memory not found")
    return {"deleted": True, "id": memory_id}


@router.get("/api/skills")
async def get_skills() -> dict[str, Any]:
    return deps.memory.get_skill_graph()


@router.patch("/api/skills/{skill_id}")
async def update_skill(skill_id: str, request: SkillUpdateRequest) -> dict[str, Any]:
    try:
        return deps.memory.update_skill(skill_id, request.model_dump(exclude_none=True))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="skill not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
