"""Check authenticated AI Station model access, normal chat, and SSE streaming."""

from __future__ import annotations

import json

from app.config import Settings
from llm.client import LLMError, LLMNotConfiguredError, OpenAICompatibleClient


def main() -> int:
    settings = Settings.load()
    client = OpenAICompatibleClient(settings)
    if not client.configured:
        print(json.dumps({"status": "BLOCKED", "reason": "LLM settings are incomplete in .env"}))
        return 2
    messages = [
        {"role": "system", "content": "你是一个简短回答助手。"},
        {"role": "user", "content": "请用中文回答：恐龙是什么？只说两句。"},
    ]
    try:
        models_ok, models_latency, models_detail = client.check_models()
        normal = client.chat(messages, max_tokens=80)
        streamed = "".join(client.stream_chat(messages, max_tokens=80))
    except (LLMError, LLMNotConfiguredError) as exc:
        print(json.dumps({"status": "FAIL", "reason": str(exc)}, ensure_ascii=True))
        return 1
    payload = {
        "status": "PASS" if models_ok and normal.text and streamed else "FAIL",
        "models": {"ok": models_ok, "latency_s": models_latency, "detail": models_detail},
        "normal_chat_latency_s": normal.elapsed_s,
        "normal_chat_text": normal.text,
        "streaming_text_nonempty": bool(streamed),
    }
    print(json.dumps(payload, ensure_ascii=True))
    return 0 if payload["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
