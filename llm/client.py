"""Small OpenAI-compatible client for the AI Station vLLM endpoint."""

from __future__ import annotations

import json
import time
import base64
from dataclasses import dataclass
from typing import Any, Iterator

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

    def _request_payload(self, messages: list[dict[str, Any]], max_tokens: int, stream: bool) -> tuple[str, dict]:
        if getattr(self.settings, "llm_provider", "compatible") != "openai":
            return "/chat/completions", {"model": self.settings.llm_model, "messages": messages,
                "temperature": 0.45, "max_tokens": max_tokens, "stream": stream}
        converted = []
        for message in messages:
            content = message.get("content", "")
            if isinstance(content, list):
                content = [
                    {"type": "input_image", "image_url": part["image_url"]["url"]}
                    if part.get("type") == "image_url" else
                    {"type": "input_text", "text": part.get("text", "")}
                    for part in content
                ]
            converted.append({"role": message["role"], "content": content})
        payload = {"model": self.settings.llm_model, "input": converted, "store": False,
                   "max_output_tokens": max(900, max_tokens), "stream": stream}
        if self.settings.llm_model.startswith(("gpt-5", "gpt-6")):
            payload["reasoning"] = {"effort": "low"}
        return "/responses", payload

    @staticmethod
    def _extract_text(payload: dict[str, Any]) -> str:
        if "output" in payload:
            return "".join(part.get("text", "") for item in payload.get("output", [])
                           if item.get("type") == "message"
                           for part in item.get("content", []) if part.get("type") == "output_text").strip()
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

    def chat(
        self,
        messages: list[dict[str, Any]],
        max_tokens: int = 180,
        timeout_seconds: float | None = None,
    ) -> LLMResult:
        self._require_configured()
        endpoint, payload = self._request_payload(messages, max_tokens, False)
        started = time.perf_counter()
        try:
            with httpx.Client(
                timeout=timeout_seconds or self.settings.llm_timeout_seconds,
                trust_env=False,
            ) as client:
                response = client.post(self._url(endpoint), headers=self._headers(), json=payload)
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPStatusError as exc:
            raise LLMError(f"AI Station returned HTTP {exc.response.status_code}") from exc
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise LLMError("AI Station request failed") from exc
        try:
            if not isinstance(data, dict) or data.get("status") in {"failed", "incomplete"}:
                raise LLMError("Model returned an invalid or incomplete response")
            text = self._extract_text(data)
        except (AttributeError, TypeError, IndexError, KeyError):
            raise LLMError("Model returned an invalid response format") from None
        if not text:
            raise LLMError("AI Station returned empty assistant text")
        return LLMResult(text=text, elapsed_s=round(time.perf_counter() - started, 3))

    def stream_chat(self, messages: list[dict[str, Any]], max_tokens: int = 180) -> Iterator[str]:
        """Yield OpenAI-compatible SSE deltas for diagnostics and future UI streaming."""

        self._require_configured()
        endpoint, payload = self._request_payload(messages, max_tokens, True)
        try:
            with httpx.Client(
                timeout=self.settings.llm_timeout_seconds,
                trust_env=False,
            ) as client:
                with client.stream(
                    "POST",
                    self._url(endpoint),
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
                        if data.get("type") == "response.output_text.delta":
                            yield str(data.get("delta") or "")
                            continue
                        if data.get("type") in {"error", "response.failed", "response.incomplete"}:
                            raise LLMError("Model streaming response failed")
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
        except (AttributeError, TypeError, IndexError, KeyError):
            raise LLMError("Model returned an invalid streaming response format") from None

    def describe_image(
        self,
        image_bytes: bytes,
        content_type: str,
        prompt: str,
        max_tokens: int = 120,
    ) -> LLMResult:
        """Send one explicitly requested image to the AI Station VLM endpoint."""

        return self.describe_images(
            [(image_bytes, content_type)],
            prompt,
            max_tokens=max_tokens,
        )

    def describe_images(
        self,
        images: list[tuple[bytes, str]],
        prompt: str,
        max_tokens: int = 120,
    ) -> LLMResult:
        """Send a small set of in-memory images to the AI Station VLM."""

        if not images or any(not image_bytes for image_bytes, _ in images):
            raise LLMError("Vision image is empty")
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for image_bytes, content_type in images[:4]:
            safe_type = content_type.split(";", 1)[0].strip().lower()
            if safe_type not in {"image/jpeg", "image/png", "image/webp"}:
                safe_type = "image/jpeg"
            image_url = f"data:{safe_type};base64,{base64.b64encode(image_bytes).decode('ascii')}"
            content.append({"type": "image_url", "image_url": {"url": image_url}})
        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": "你是家庭 AI 爸爸老师的视觉助手。只根据图片中可见内容回答，不猜测身份、隐私、健康或情绪。",
            },
            {
                "role": "user",
                "content": content,
            },
        ]
        return self.chat(
            messages,
            max_tokens=max_tokens,
            timeout_seconds=self.settings.llm_vision_timeout_seconds,
        )

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
