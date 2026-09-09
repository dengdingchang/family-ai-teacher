"""Parent-owned model configuration. Secrets stay in the existing local .env."""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from urllib.parse import urlsplit

from app.config import Settings

_lock = threading.RLock()


class ConfigurationConflict(ValueError):
    pass


def revision(path: Path) -> str:
    return hashlib.sha256(path.read_bytes() if path.exists() else b"").hexdigest()


def public_settings(settings: Settings, path: Path) -> dict:
    return {
        "provider": settings.llm_provider,
        "base_url": settings.llm_base_url,
        "model": settings.llm_model,
        "api_key_configured": bool(settings.llm_api_key),
        "timeout_seconds": settings.llm_timeout_seconds,
        "search_provider": settings.search_provider,
        "image_provider": settings.imagegen_provider,
        "image_enabled": settings.imagegen_enabled or settings.imagegen_provider == "openai",
        "image_agent_model": settings.imagegen_model,
        "revision": revision(path),
    }


def candidate_settings(settings: Settings, values: dict) -> Settings:
    provider = str(values.get("provider", settings.llm_provider))
    if provider not in {"compatible", "openai"}:
        raise ValueError("请选择 OpenAI API 或兼容服务")
    base_url = str(values.get("base_url", settings.llm_base_url)).strip().rstrip("/")
    if provider == "openai":
        base_url = "https://api.openai.com/v1"
    parsed = urlsplit(base_url)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or any(c in base_url for c in '\n\r\x00"\'')):
        raise ValueError("服务地址需为不含密码或参数的 HTTP/HTTPS 地址")
    model = str(values.get("model", settings.llm_model)).strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,159}", model):
        raise ValueError("请填写有效的模型名称")
    key = str(values.get("api_key") or "").strip()
    # A masked/blank field can retain the saved key only for the same endpoint.
    if not key:
        if base_url != settings.llm_base_url:
            raise ValueError("切换服务地址时，请填写该服务的密钥，避免发送旧密钥")
        key = settings.llm_api_key
    if not key or len(key) > 4096 or any(c in key for c in '\n\r\x00"\''):
        raise ValueError("请填写有效密钥；无鉴权的本地兼容服务可填 local")
    try:
        timeout = float(values.get("timeout_seconds", settings.llm_timeout_seconds))
    except (ValueError, TypeError):
        raise ValueError("等待时间需为 2 到 30 秒") from None
    if not 2 <= timeout <= 30:
        raise ValueError("等待时间需为 2 到 30 秒")
    search = str(values.get("search_provider", settings.search_provider))
    if search not in {"codex", "openai", "off"}:
        raise ValueError("请选择有效的联网搜索方式")
    if search == "openai" and provider != "openai":
        raise ValueError("OpenAI 联网搜索需要选择 OpenAI API 服务")
    image_provider = str(values.get("image_provider", settings.imagegen_provider))
    if image_provider not in {"codex", "openai"}:
        raise ValueError("请选择有效的图片生成方式")
    if image_provider == "openai" and provider != "openai":
        raise ValueError("Images 2.5 API 生图需要选择 OpenAI API 服务和密钥")
    return replace(settings, llm_provider=provider, llm_base_url=base_url,
                   llm_model=model, llm_api_key=key, llm_timeout_seconds=timeout,
                   search_provider=search, imagegen_provider=image_provider)


def save_settings(settings: Settings, values: dict, path: Path) -> Settings:
    with _lock:
        if values.get("revision") != revision(path):
            raise ConfigurationConflict("设置已在其他窗口更新，请重新载入再保存")
        candidate = candidate_settings(settings, values)
        changes = {
            "LLM_PROVIDER": candidate.llm_provider, "LLM_BASE_URL": candidate.llm_base_url,
            "LLM_MODEL": candidate.llm_model, "LLM_API_KEY": candidate.llm_api_key,
            "LLM_TIMEOUT_SECONDS": str(candidate.llm_timeout_seconds),
            "SEARCH_PROVIDER": candidate.search_provider,
            "IMAGEGEN_PROVIDER": candidate.imagegen_provider,
        }
        original = path.read_text(encoding="utf-8-sig") if path.exists() else ""
        lines, seen = [], set()
        for line in original.splitlines():
            match = re.match(r"\s*(?:export\s+)?([A-Z_]+)\s*=", line)
            name = match.group(1) if match else ""
            if name in changes:
                if name not in seen:
                    lines.append(f'{name}="{changes[name]}"')
                    seen.add(name)
            else:
                lines.append(line)
        lines.extend(f'{name}="{value}"' for name, value in changes.items() if name not in seen)
        # Atomic replace: a failed write never leaves half a configuration.
        descriptor, temporary = tempfile.mkstemp(prefix=".model-settings-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                handle.write("\n".join(lines) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        # The existing loader treats exported values as authoritative.
        os.environ.update(changes)
        return candidate
