"""Request bodies accepted by the HTTP API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class TextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    chess_context: str = Field(default="", max_length=3000)


class MediaSuggestionRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=80)
    kind: Literal["image", "video", "link"] = "image"
    generate_image: bool = False
    image_job_id: str = Field(default="", max_length=32, pattern=r"^[0-9a-f]*$")


class InteractionIntervalRequest(BaseModel):
    session_id: str = Field(min_length=32, max_length=36)
    sequence: int = Field(strict=True, gt=0, le=9007199254740991)
    start_at: str = Field(min_length=1, max_length=64)
    end_at: str = Field(min_length=1, max_length=64)


class ActivityPlayRequest(BaseModel):
    event_id: str = Field(min_length=36, max_length=36)
    activity: Literal["chess", "drawing", "piano", "singing", "story", "game"]
    kind: Literal["session", "stage", "challenge"]
    step: str = Field(default="", max_length=80)
    duration_seconds: int = Field(default=0, ge=0, le=3600)
    level: str = Field(default="", max_length=20)
    result: str = Field(default="", max_length=12)
    independent: bool = False


class ProfileUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=16)
    age: int | None = Field(default=None, ge=2, le=17)
    preferred_language: str | None = Field(default=None, max_length=48)
    interests: list[str] | None = None
    teaching_preferences: list[str] | None = None
    learning_goals: list[str] | None = None
    daily_guidance: str | None = Field(default=None, max_length=120)
    daily_guidance_date: str | None = Field(default=None, max_length=10)
    teacher_style: str | None = Field(default=None, max_length=32)
    content_boundaries: list[str] | None = None
    enabled_activities: list[str] | None = None
    brain_mode: str | None = Field(default=None, max_length=32)


class MemoryCreateRequest(BaseModel):
    summary: str = Field(min_length=1, max_length=240)
    category: str = "episodic"
    status: str = "candidate"
    tags: list[str] = Field(default_factory=list)


class MemoryUpdateRequest(BaseModel):
    summary: str | None = Field(default=None, max_length=240)
    category: str | None = None
    status: str | None = None
    tags: list[str] | None = None


class SkillUpdateRequest(BaseModel):
    status: str | None = None
    mastery_score: float | None = Field(default=None, ge=0, le=1)
    last_evidence: str | None = Field(default=None, max_length=240)


class ParentMessageRequest(BaseModel):
    text: str = Field(min_length=1, max_length=120)


class FamilyDataDeleteRequest(BaseModel):
    scopes: list[str] = Field(min_length=1, max_length=8)
    confirmation: str = Field(min_length=1, max_length=48)
