"""Small OpenAI-compatible client for the AI Station vLLM endpoint."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Iterator

import httpx

from app.config import Settings


class LLMNotConfiguredError(RuntimeError):
    pass


class LLMError(RuntimeError):
    pass


@dataclass(frozen=True)
class LLMResult:
    text: str
    elapsed_s: float


class OpenAICompatibleClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def configured(self) -> bool:
        return self.settings.llm_configured

    def _require_configured(self) -> None:
        if not self.configured:
            raise LLMNotConfiguredError(
                "LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL must be set in .env"
            )

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.settings.llm_api_key:
            headers["Authorization"] = f"Bearer {self.settings.llm_api_key}"
        return headers

    def _url(self, suffix: str) -> str:
        return f"{self.settings.llm_base_url}/{suffix.lstrip('/')}"

    @staticmethod
    def _extract_text(payload: dict) -> str:
        choices = payload.get("choices") or []
        if not choices:
            return ""
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
        if not content:
            content = message.get("reasoning_content", "")
        return str(content or "").strip()

    def chat(self, messages: list[dict[str, str]], max_tokens: int = 180) -> LLMResult:
        self._require_configured()
        payload = {
            "model": self.settings.llm_model,
            "messages": messages,
            "temperature": 0.45,
            "max_tokens": max_tokens,
            "stream": False,
        }
        started = time.perf_counter()
        try:
            with httpx.Client(
                timeout=self.settings.llm_timeout_seconds,
                trust_env=False,
            ) as client:
                response = client.post(self._url("/chat/completions"), headers=self._headers(), json=payload)
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPStatusError as exc:
            raise LLMError(f"AI Station returned HTTP {exc.response.status_code}") from exc
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise LLMError("AI Station request failed") from exc
        text = self._extract_text(data)
        if not text:
            raise LLMError("AI Station returned empty assistant text")
        return LLMResult(text=text, elapsed_s=round(time.perf_counter() - started, 3))

    def stream_chat(self, messages: list[dict[str, str]], max_tokens: int = 180) -> Iterator[str]:
        """Yield OpenAI-compatible SSE deltas for diagnostics and future UI streaming."""

        self._require_configured()
        payload = {
            "model": self.settings.llm_model,
            "messages": messages,
            "temperature": 0.45,
            "max_tokens": max_tokens,
            "stream": True,
        }
        try:
            with httpx.Client(
                timeout=self.settings.llm_timeout_seconds,
                trust_env=False,
            ) as client:
                with client.stream(
                    "POST",
                    self._url("/chat/completions"),
                    headers=self._headers(),
                    json=payload,
                ) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if raw == "[DONE]":
                            break
                        try:
                            data = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        choices = data.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        content = delta.get("content") or ""
                        if content:
                            yield str(content)
        except httpx.HTTPStatusError as exc:
            raise LLMError(f"AI Station returned HTTP {exc.response.status_code}") from exc
        except httpx.HTTPError as exc:
            raise LLMError("AI Station streaming request failed") from exc

    def check_models(self) -> tuple[bool, float, str]:
        self._require_configured()
        started = time.perf_counter()
        try:
            with httpx.Client(
                timeout=self.settings.llm_timeout_seconds,
                trust_env=False,
            ) as client:
                response = client.get(self._url("/models"), headers=self._headers())
                response.raise_for_status()
            return True, round(time.perf_counter() - started, 3), "ok"
        except httpx.HTTPStatusError as exc:
            return False, round(time.perf_counter() - started, 3), f"http_{exc.response.status_code}"
        except httpx.HTTPError:
            return False, round(time.perf_counter() - started, 3), "unreachable"
