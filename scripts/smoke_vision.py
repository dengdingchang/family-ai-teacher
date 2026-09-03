"""Send one explicit local test image to the AI Station Vision endpoint."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from app.config import Settings
from llm.client import LLMError, LLMNotConfiguredError, OpenAICompatibleClient


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    image = Path(args.image)
    if not image.is_file():
        print(json.dumps({"status": "FAIL", "reason": "test image is missing"}))
        return 1
    client = OpenAICompatibleClient(Settings.load())
    if not client.configured:
        print(json.dumps({"status": "BLOCKED", "reason": "LLM settings are incomplete"}))
        return 2
    started = time.perf_counter()
    try:
        result = client.describe_image(
            image.read_bytes(),
            "image/jpeg",
            "请只用一句适合4岁孩子的中文描述这张纯色测试图，不要猜测图片之外的信息。",
            max_tokens=60,
        )
    except (LLMError, LLMNotConfiguredError) as exc:
        print(json.dumps({"status": "FAIL", "reason": str(exc)[:240]}, ensure_ascii=True))
        return 1
    print(
        json.dumps(
            {
                "status": "PASS" if result.text else "FAIL_EMPTY_TEXT",
                "elapsed_s": round(time.perf_counter() - started, 3),
                "description_chars": len(result.text),
                "description_nonempty": bool(result.text),
            },
            ensure_ascii=True,
        )
    )
    return 0 if result.text else 1


if __name__ == "__main__":
    raise SystemExit(main())
