from __future__ import annotations

import struct
import sys
import os
import subprocess
import threading
import time
import zlib
from pathlib import Path

import pytest

from app.image_generation import (
    CodexImageGenerationManager,
    ImageGenerationError,
    _WindowsProcessJob,
    _minimal_codex_environment,
    _png_dimensions,
)


def write_png(path: Path, width: int = 64, height: int = 64) -> Path:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    rows = b"".join(b"\x00" + b"\xff\xd8\x60\xff" * width for _ in range(height))
    payload = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(payload)
    return path


def make_manager(tmp_path: Path, runner) -> CodexImageGenerationManager:
    skill = tmp_path / "SKILL.md"
    skill.write_text("fixture", encoding="utf-8")
    return CodexImageGenerationManager(
        enabled=True,
        codex_path=sys.executable,
        model="fixture-agent",
        skill_path=skill,
        runtime_root=tmp_path,
        output_dir=tmp_path / "generated",
        jobs_dir=tmp_path / "jobs",
        timeout_seconds=30,
        runner=runner,
    )


def wait_for(manager: CodexImageGenerationManager, job_id: str, status: str) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        result = manager.status(job_id)
        if result and result["status"] == status:
            return result
        time.sleep(0.01)
    raise AssertionError(f"job did not reach {status}")


def test_png_validation_checks_structure_crc_size_and_dimensions(tmp_path: Path) -> None:
    valid = write_png(tmp_path / "valid.png", 96, 80)
    assert _png_dimensions(valid) == (96, 80)
    broken = tmp_path / "broken.png"
    broken.write_bytes(valid.read_bytes()[:-1] + b"x")
    with pytest.raises(ImageGenerationError):
        _png_dimensions(broken)


def test_duplicate_topic_reuses_one_serial_job_and_fixed_local_card(tmp_path: Path) -> None:
    started = threading.Event()
    release = threading.Event()
    calls = []

    def runner(topic: str, job_dir: Path) -> Path:
        calls.append(topic)
        started.set()
        assert release.wait(2)
        return write_png(job_dir / "result.png")

    manager = make_manager(tmp_path, runner)
    first = manager.request("蝴蝶")
    assert started.wait(2)
    second = manager.request("蝴蝶")
    assert second["job_id"] == first["job_id"]
    release.set()
    completed = wait_for(manager, first["job_id"], "completed")
    assert calls == ["蝴蝶"]
    assert completed["card"]["thumbnail_url"].startswith("/api/generated-media/")
    assert "蝴蝶" in completed["card"]["title"]
    filename = completed["card"]["thumbnail_url"].rsplit("/", 1)[-1]
    assert manager.safe_file(filename) is not None
    manifest = tmp_path / "generated" / f"{filename}.json"
    value = manifest.read_text(encoding="utf-8").replace('"sha256": "', '"sha256": "bad')
    manifest.write_text(value, encoding="utf-8")
    assert manager.safe_file(filename) is None
    manager.shutdown()


def test_queue_is_bounded_and_cancelled_job_is_not_published(tmp_path: Path) -> None:
    started = threading.Event()
    release = threading.Event()

    def runner(_topic: str, job_dir: Path) -> Path:
        started.set()
        assert release.wait(2)
        return write_png(job_dir / "result.png")

    manager = make_manager(tmp_path, runner)
    running = manager.request("蝴蝶")
    assert started.wait(2)
    queued = [manager.request(topic) for topic in ("火山", "彩虹", "熊猫")]
    assert all(job["status"] == "queued" for job in queued)
    assert manager.request("蜜蜂")["status"] == "busy"
    assert manager.cancel(running["job_id"])["status"] == "cancelled"
    release.set()
    assert wait_for(manager, running["job_id"], "cancelled")["status"] == "cancelled"
    assert not (tmp_path / "generated" / manager._filename("蝴蝶")).exists()
    manager.shutdown()


def test_failed_topic_is_backed_off_before_an_explicit_retry(tmp_path: Path) -> None:
    calls = []

    def runner(topic: str, _job_dir: Path) -> Path:
        calls.append(topic)
        raise ImageGenerationError("fixture_failure")

    manager = make_manager(tmp_path, runner)
    first = manager.request("火山")
    failed = wait_for(manager, first["job_id"], "failed")
    repeated = manager.request("火山")
    assert repeated["job_id"] == first["job_id"]
    assert repeated["retry_after_seconds"] > 0
    with manager._lock:
        manager._jobs[first["job_id"]].updated_at -= manager.retry_backoff_seconds + 1
    retried = manager.request("火山")
    assert retried["job_id"] != first["job_id"]
    wait_for(manager, retried["job_id"], "failed")
    assert calls == ["火山", "火山"]
    manager.shutdown()


def test_disabled_manager_never_creates_a_job(tmp_path: Path) -> None:
    manager = CodexImageGenerationManager(
        enabled=False,
        codex_path="codex",
        model="gpt-5.6-sol",
        skill_path=tmp_path / "missing",
        runtime_root=tmp_path,
        output_dir=tmp_path / "generated",
        jobs_dir=tmp_path / "jobs",
        timeout_seconds=30,
    )
    assert manager.request("蝴蝶") == {"topic": "蝴蝶", "status": "not_configured"}


def test_codex_subprocess_environment_does_not_inherit_application_keys(monkeypatch) -> None:
    monkeypatch.setenv("LLM_API_KEY", "private-llm-key")
    monkeypatch.setenv("OPENAI_API_KEY", "private-api-key")
    monkeypatch.setenv("TTS_REF_TEXT", "private-voice-text")
    environment = _minimal_codex_environment()
    assert "LLM_API_KEY" not in environment
    assert "OPENAI_API_KEY" not in environment
    assert "TTS_REF_TEXT" not in environment
    assert environment.get("USERPROFILE")


def test_safe_file_rejects_truncated_png_and_reparse_target(tmp_path: Path) -> None:
    manager = make_manager(tmp_path, lambda _topic, job_dir: write_png(job_dir / "result.png"))
    job = manager.request("彩虹")
    completed = wait_for(manager, job["job_id"], "completed")
    filename = completed["card"]["thumbnail_url"].rsplit("/", 1)[-1]
    path = tmp_path / "generated" / filename
    path.write_bytes(path.read_bytes()[:-1])
    assert manager.safe_file(filename) is None

    external = write_png(tmp_path / "outside.png")
    path.unlink()
    try:
        path.symlink_to(external)
    except OSError:
        manager.shutdown()
        pytest.skip("file symlinks are unavailable on this Windows account")
    assert manager.safe_file(filename) is None
    manager.shutdown()


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object behavior")
def test_windows_job_object_closes_only_its_owned_process_tree() -> None:
    code = (
        "import subprocess,sys,time; time.sleep(0.4); "
        "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']); "
        "print(p.pid,flush=True); time.sleep(60)"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", code], stdout=subprocess.PIPE, text=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    owned = _WindowsProcessJob(process)
    assert process.stdout is not None
    child_pid = int(process.stdout.readline().strip())
    assert child_pid > 0
    assert owned.close_and_wait() is True
    process.wait(timeout=3)
