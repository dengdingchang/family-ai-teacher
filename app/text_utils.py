"""Pure text helpers shared by the conversation pipeline.

Everything here works on strings alone: no storage, no models, no network.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from fastapi import HTTPException


def _clean_text(text: str) -> str:
    clean_text = " ".join(text.strip().split())
    if not clean_text:
        raise HTTPException(status_code=400, detail="没有识别到可回答的文字")
    if len(clean_text) > 500:
        raise HTTPException(status_code=400, detail="这句话太长了，请分成短句再说")
    return clean_text


def _child_nickname(profile: dict[str, Any] | None) -> str:
    """Return a short spoken nickname configured by the parent."""

    if not isinstance(profile, dict):
        return ""
    value = " ".join(str(profile.get("name", "")).strip().split())
    value = re.sub(r"[，,。！？!?：:；;\n\r\t]", "", value)
    return value[:16]


def _personalize_reply(reply: str, profile: dict[str, Any] | None) -> str:
    nickname = _child_nickname(profile)
    clean = str(reply).strip()
    if not nickname or not clean or nickname in clean[:24]:
        return clean
    return _compact_assistant_text(f"{nickname}，{clean}", max_chars=64)


def _compact_assistant_text(
    text: str,
    max_chars: int = 52,
    max_sentences: int = 2,
) -> str:
    """Keep the spoken teaching turn plain, short, and limited to two sentences."""

    clean = " ".join(str(text).strip().split())
    clean = re.sub(r"^[>*_`#\-\d.)\s]+", "", clean)
    clean = re.sub(r"[*_`#~]", "", clean)
    clean = "".join(char for char in clean if unicodedata.category(char) not in {"So", "Sk"})
    clean = " ".join(clean.split()).strip()
    if not clean:
        return ""

    boundaries = list(re.finditer(r"[。！？!?；;]", clean))
    if len(boundaries) >= max_sentences:
        clean = clean[: boundaries[max_sentences - 1].end()].strip()
    if len(clean) > max_chars:
        clipped = clean[:max_chars].rstrip(" ，,、：:;；")
        if len(clipped) >= 8:
            clean = clipped
            if not clean.endswith(("。", "！", "？", "!", "?")):
                clean += "。"
    return clean


def _activity_answer(text: str, limit: int = 10) -> str:
    clean = re.sub(
        r"^(?:我想要?|我要|我选|我選|我猜|选择|選擇|选|選|是|用|涂|塗)+",
        "",
        text.strip(),
    )
    clean = re.sub(r"[^0-9A-Za-z\u3400-\u9fff]", "", clean)
    return clean[:limit]


def _spoken_chunks(text: str, leading_vocative: str = "") -> list[str]:
    """Split a final two-sentence turn without ever speaking text twice."""

    clean = " ".join(str(text).strip().split())
    clean = re.sub(r"[*_`#~]", "", clean)
    vocative = ""
    expected_vocative = f"{leading_vocative}，" if leading_vocative else ""
    if expected_vocative and clean.startswith(expected_vocative):
        vocative = expected_vocative
        clean = clean[len(expected_vocative) :].lstrip()
    chunks = [part.strip() for part in re.findall(r"[^。！？!?；;]+[。！？!?；;]?", clean)]
    chunks = [part for part in chunks if part]
    if vocative:
        chunks.insert(0, vocative)
    if len(chunks) <= 1:
        return chunks
    first_content_index = 1 if vocative else 0
    first_plain = re.sub(r"[\s。！？!?，,、：:；;“”'\"]", "", chunks[first_content_index])
    if len(first_plain) < 4:
        return ["".join(chunks)]
    if vocative:
        return [vocative, chunks[1], "".join(chunks[2:])] if len(chunks) > 2 else chunks
    return [chunks[0], "".join(chunks[1:])]


def _early_spoken_chunk(text: str) -> str:
    """Return a safe first teaching sentence before the LLM stream is complete."""

    boundary = re.search(r"[。！!；;]", text)
    if boundary is None:
        return ""
    candidate = _compact_assistant_text(text[: boundary.end()], max_sentences=1)
    plain = re.sub(r"[\s。！？!?，,、：:；;“”'\"]", "", candidate).casefold()
    if len(plain) < 4 or plain in {"好的", "听见了", "聽見了", "真棒", "可以", "我们开始", "我們開始"}:
        return ""
    return candidate
