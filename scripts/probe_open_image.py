"""Explicit synthetic image probe. No microphone, camera, history or family writes."""
import json
import time
import uuid
from app.config import Settings
from app.image_generation import CodexImageGenerationManager


def main():
    settings = Settings.load()
    manager = CodexImageGenerationManager(enabled=settings.imagegen_enabled,
        codex_path=settings.imagegen_codex_path, model=settings.imagegen_model,
        skill_path=settings.imagegen_skill_path, runtime_root=settings.project_root / "runtime",
        output_dir=settings.imagegen_output_dir, jobs_dir=settings.imagegen_jobs_dir,
        timeout_seconds=settings.imagegen_timeout_seconds)
    started = time.monotonic()
    result = manager.request("小熊乘着积木火车去月球", uuid.uuid4().hex)
    try:
        while result.get("status") in {"queued", "running"}:
            time.sleep(2)
            result = manager.status(result["job_id"])
        print(json.dumps({"elapsed_s": round(time.monotonic() - started, 1), "result": result}, ensure_ascii=False))
    finally:
        manager.shutdown()


if __name__ == "__main__":
    main()
