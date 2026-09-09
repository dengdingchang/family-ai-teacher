"""Bounded Codex image generation for allowlisted educational topics.

The local app never sends raw child speech to Codex. Callers must pass one
canonical topic selected by the application allowlist.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
logger = logging.getLogger(__name__)


class ImageGenerationError(RuntimeError):
    """Raised when the isolated Codex job cannot produce a safe PNG."""


def _is_reparse_point(path: Path) -> bool:
    try:
        value = path.lstat()
    except OSError:
        return False
    return bool(value.st_mode & 0o120000 == 0o120000 or getattr(value, "st_file_attributes", 0) & 0x400)


def _bounded_path(root: Path, path: Path) -> Path:
    root = root.resolve(strict=False)
    resolved = path.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ImageGenerationError("path_outside_runtime") from exc
    current = root
    for part in resolved.relative_to(root).parts:
        current = current / part
        if current.exists() and _is_reparse_point(current):
            raise ImageGenerationError("reparse_path_rejected")
    return resolved


def _minimal_codex_environment() -> dict[str, str]:
    names = {
        "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE",
        "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
        "CODEX_HOME", "USERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
    }
    result = {name: value for name, value in os.environ.items() if name.upper() in names}
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"):
        value = os.environ.get(name) or os.environ.get(name.lower())
        if not value:
            continue
        if name == "NO_PROXY":
            result[name] = value
            continue
        parsed = urlsplit(value)
        if parsed.username or parsed.password:
            continue
        result[name] = value
    result["NO_COLOR"] = "1"
    return result


class _WindowsProcessJob:
    """Own exactly one app-server process tree and kill it when the job closes."""

    def __init__(self, process: subprocess.Popen[str]) -> None:
        self.handle = None
        self.parent_pid = process.pid
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class BASIC_LIMITS(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED_LIMITS(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC_LIMITS),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise ImageGenerationError("job_object_create_failed")
        limits = EXTENDED_LIMITS()
        limits.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            kernel32.CloseHandle(handle)
            raise ImageGenerationError("job_object_config_failed")
        if not kernel32.AssignProcessToJobObject(handle, wintypes.HANDLE(int(process._handle))):
            kernel32.CloseHandle(handle)
            raise ImageGenerationError("job_object_assign_failed")
        self.handle = handle
        self._kernel32 = kernel32

    def close_and_wait(self) -> bool:
        if os.name != "nt" or self.handle is None:
            return True
        import ctypes
        from ctypes import wintypes

        class PID_LIST(ctypes.Structure):
            _fields_ = [
                ("NumberOfAssignedProcesses", wintypes.DWORD),
                ("NumberOfProcessIdsInList", wintypes.DWORD),
                ("ProcessIdList", ctypes.c_size_t * 128),
            ]

        value = PID_LIST()
        pids = {self.parent_pid}
        if self._kernel32.QueryInformationJobObject(
            self.handle, 3, ctypes.byref(value), ctypes.sizeof(value), None
        ):
            pids.update(
                int(value.ProcessIdList[index])
                for index in range(min(value.NumberOfProcessIdsInList, len(value.ProcessIdList)))
            )
        if self.handle is not None:
            self._kernel32.CloseHandle(self.handle)
            self.handle = None
        all_exited = True
        for pid in pids:
            process_handle = self._kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
            if not process_handle:
                continue
            if self._kernel32.WaitForSingleObject(process_handle, 5000) == 0x00000102:
                all_exited = False
            self._kernel32.CloseHandle(process_handle)
        return all_exited


@dataclass
class ImageGenerationJob:
    job_id: str
    topic: str
    status: str
    created_at: float
    updated_at: float
    filename: str = ""
    error: str = ""


def _png_dimensions(path: Path) -> tuple[int, int]:
    size = path.stat().st_size
    if size < 64 or size > 12 * 1024 * 1024:
        raise ImageGenerationError("invalid_png_size")
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise ImageGenerationError("invalid_png")
    offset = len(PNG_SIGNATURE)
    width = height = 0
    saw_idat = saw_iend = False
    first = True
    while offset + 12 <= len(data):
        length = int.from_bytes(data[offset:offset + 4], "big")
        if length > 12 * 1024 * 1024 or offset + 12 + length > len(data):
            raise ImageGenerationError("invalid_png_chunk")
        chunk_type = data[offset + 4:offset + 8]
        chunk_data = data[offset + 8:offset + 8 + length]
        expected_crc = int.from_bytes(data[offset + 8 + length:offset + 12 + length], "big")
        if zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF != expected_crc:
            raise ImageGenerationError("invalid_png_crc")
        if first:
            if chunk_type != b"IHDR" or length != 13:
                raise ImageGenerationError("invalid_png_header")
            width = int.from_bytes(chunk_data[0:4], "big")
            height = int.from_bytes(chunk_data[4:8], "big")
            first = False
        elif chunk_type == b"IDAT":
            saw_idat = True
        elif chunk_type == b"IEND":
            if length != 0 or offset + 12 != len(data):
                raise ImageGenerationError("invalid_png_end")
            saw_iend = True
            break
        offset += 12 + length
    if not saw_idat or not saw_iend:
        raise ImageGenerationError("incomplete_png")
    if width < 64 or height < 64 or width > 4096 or height > 4096:
        raise ImageGenerationError("invalid_dimensions")
    return width, height


class CodexImageGenerationManager:
    """Serializes ephemeral Codex app-server jobs and exposes safe status only."""

    def __init__(
        self,
        *,
        enabled: bool,
        codex_path: str,
        model: str,
        skill_path: Path,
        runtime_root: Path,
        output_dir: Path,
        jobs_dir: Path,
        timeout_seconds: float,
        retry_backoff_seconds: float = 120.0,
        runner=None,
    ) -> None:
        self.enabled = enabled
        self.codex_path = codex_path
        self.model = model
        self.skill_path = skill_path
        self.runtime_root = runtime_root.resolve(strict=False)
        self.output_dir = _bounded_path(self.runtime_root, output_dir)
        self.jobs_dir = _bounded_path(self.runtime_root, jobs_dir)
        self.timeout_seconds = timeout_seconds
        self.retry_backoff_seconds = retry_backoff_seconds
        self._runner = runner or self._run_codex
        self._jobs: dict[str, ImageGenerationJob] = {}
        self._topic_jobs: dict[str, str] = {}
        self._cancelled_requests: dict[str, float] = {}
        self._lock = threading.RLock()
        self._pending: queue.Queue[str | None] = queue.Queue(maxsize=3)
        self._stop = threading.Event()
        self._process: subprocess.Popen[str] | None = None
        self._current_job_id = ""
        self._worker: threading.Thread | None = None

    @property
    def configured(self) -> bool:
        executable = shutil.which(self.codex_path) if not Path(self.codex_path).is_file() else self.codex_path
        try:
            _bounded_path(self.runtime_root, self.output_dir)
            _bounded_path(self.runtime_root, self.jobs_dir)
        except ImageGenerationError:
            return False
        return bool(self.enabled and executable and self.skill_path.is_file() and self.model)

    def _ensure_worker(self) -> None:
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(
                target=self._worker_loop,
                name="family-imagegen-worker",
                daemon=True,
            )
            self._worker.start()

    @staticmethod
    def _filename(topic: str) -> str:
        return f"{hashlib.sha256(topic.encode('utf-8')).hexdigest()[:24]}.png"

    def request(self, topic: str, requested_job_id: str = "") -> dict[str, Any]:
        if not self.configured:
            return {"topic": topic, "status": "not_configured"}
        if requested_job_id and not re.fullmatch(r"[0-9a-f]{32}", requested_job_id):
            return {"topic": topic, "status": "rejected"}
        filename = self._filename(topic)
        if self.safe_file(filename) is not None:
            return self._cached_job(topic, filename)
        try:
            target = self.output_dir / filename
            if target.exists():
                raise ImageGenerationError("invalid_cache")
        except (OSError, ImageGenerationError):
            logger.warning("Ignoring invalid generated image cache: topic=%s", topic)

        with self._lock:
            now = time.time()
            self._cancelled_requests = {
                key: value for key, value in self._cancelled_requests.items() if now - value < 300
            }
            if requested_job_id in self._cancelled_requests:
                return {
                    "job_id": requested_job_id,
                    "topic": topic,
                    "status": "cancelled",
                    "status_url": f"/api/image-generation/jobs/{requested_job_id}",
                }
            existing_id = self._topic_jobs.get(topic)
            if existing_id:
                existing = self._jobs.get(existing_id)
                if existing and existing.status in {"queued", "running"}:
                    return self._public(existing)
                if existing and existing.status == "failed" and time.time() - existing.updated_at < self.retry_backoff_seconds:
                    return self._public(existing)
            if self._pending.full():
                return {"topic": topic, "status": "busy"}
            job_id = requested_job_id or uuid.uuid4().hex
            job = ImageGenerationJob(job_id, topic, "queued", now, now)
            self._jobs[job.job_id] = job
            self._topic_jobs[topic] = job.job_id
            self._pending.put(job.job_id)
        self._ensure_worker()
        return self._public(job)

    def safe_file(self, filename: str) -> Path | None:
        if not re.fullmatch(r"[0-9a-f]{24}\.png", filename):
            return None
        try:
            root = _bounded_path(self.runtime_root, self.output_dir)
            path = _bounded_path(root, root / filename)
            manifest_path = _bounded_path(root, root / f"{filename}.json")
            if _is_reparse_point(path) or _is_reparse_point(manifest_path):
                return None
            if not path.is_file() or not manifest_path.is_file():
                return None
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(manifest, dict) or manifest.get("filename") != filename:
                return None
            _png_dimensions(path)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if not hmac.compare_digest(digest, str(manifest.get("sha256") or "")):
                return None
            return path
        except (OSError, ValueError, json.JSONDecodeError, ImageGenerationError):
            return None

    def _cached_job(self, topic: str, filename: str) -> dict[str, Any]:
        with self._lock:
            existing_id = self._topic_jobs.get(topic)
            existing = self._jobs.get(existing_id or "")
            if existing and existing.status == "completed":
                return self._public(existing)
            now = time.time()
            job = ImageGenerationJob(uuid.uuid4().hex, topic, "completed", now, now, filename)
            self._jobs[job.job_id] = job
            self._topic_jobs[topic] = job.job_id
            return self._public(job)

    def status(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job and job.status == "completed" and self.safe_file(job.filename) is None:
                job.status = "failed"
                job.error = "cache_validation_failed"
                job.updated_at = time.time()
            return self._public(job) if job else None

    def cancel(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                self._cancelled_requests[job_id] = time.time()
                if len(self._cancelled_requests) > 64:
                    oldest = min(self._cancelled_requests, key=self._cancelled_requests.get)
                    self._cancelled_requests.pop(oldest, None)
                return {
                    "job_id": job_id,
                    "topic": "",
                    "status": "cancelled",
                    "status_url": f"/api/image-generation/jobs/{job_id}",
                }
            if job.status not in {"queued", "running"}:
                return self._public(job)
            job.status = "cancelled"
            job.updated_at = time.time()
            process = self._process if self._current_job_id == job_id else None
        if process is not None and process.poll() is None:
            process.terminate()
        return self._public(job)

    def _public(self, job: ImageGenerationJob) -> dict[str, Any]:
        result: dict[str, Any] = {
            "job_id": job.job_id,
            "topic": job.topic,
            "status": job.status,
            "status_url": f"/api/image-generation/jobs/{job.job_id}",
        }
        if job.status == "completed" and job.filename:
            media_url = f"/api/generated-media/{job.filename}"
            result["card"] = {
                "kind": "image",
                "title": f"爸爸老师画的{job.topic}",
                "description": "为这次学习生成的儿童友好插图",
                "url": media_url,
                "thumbnail_url": media_url,
                "source": "爸爸老师生成",
                "topic": job.topic,
                "generated": True,
            }
        elif job.status == "failed":
            result["reason"] = "generation_failed"
            result["retry_after_seconds"] = max(
                0, int(self.retry_backoff_seconds - (time.time() - job.updated_at))
            )
        return result

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            job_id = self._pending.get()
            if job_id is None:
                return
            with self._lock:
                job = self._jobs.get(job_id)
                if job is None:
                    continue
                if job.status == "cancelled":
                    continue
                job.status = "running"
                job.updated_at = time.time()
                self._current_job_id = job_id
            try:
                self.output_dir.mkdir(parents=True, exist_ok=True)
                _bounded_path(self.runtime_root, self.output_dir)
                self.jobs_dir.mkdir(parents=True, exist_ok=True)
                _bounded_path(self.runtime_root, self.jobs_dir)
                job_dir = _bounded_path(self.jobs_dir, self.jobs_dir / job.job_id)
                job_dir.mkdir(parents=True, exist_ok=False)
                result_path = self._runner(job.topic, job_dir)
                with self._lock:
                    if job.status == "cancelled":
                        continue
                result_path = result_path.resolve(strict=True)
                if result_path.parent != job_dir.resolve(strict=True) or _is_reparse_point(result_path):
                    raise ImageGenerationError("untrusted_result_path")
                width, height = _png_dimensions(result_path)
                filename = self._filename(job.topic)
                target = _bounded_path(self.output_dir, self.output_dir / filename)
                manifest_path = _bounded_path(self.output_dir, self.output_dir / f"{filename}.json")
                temporary = _bounded_path(self.output_dir, self.output_dir / f".{filename}.{job.job_id}.tmp")
                temporary_manifest = _bounded_path(
                    self.output_dir, self.output_dir / f".{filename}.{job.job_id}.json.tmp"
                )
                shutil.copyfile(result_path, temporary)
                _png_dimensions(temporary)
                digest = hashlib.sha256(temporary.read_bytes()).hexdigest()
                receipt = {
                    "job_id": job.job_id,
                    "topic": job.topic,
                    "status": "completed",
                    "filename": filename,
                    "width": width,
                    "height": height,
                    "sha256": digest,
                    "model": self.model,
                    "transport": "codex-app-server-stdio",
                    "raw_child_input_sent": False,
                }
                (job_dir / "receipt.json").write_text(
                    json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                with self._lock:
                    if job.status != "cancelled":
                        temporary_manifest.write_text(
                            json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8"
                        )
                        os.replace(temporary, target)
                        os.replace(temporary_manifest, manifest_path)
                        job.status = "completed"
                        job.filename = filename
                        job.updated_at = time.time()
                    else:
                        temporary.unlink(missing_ok=True)
                        temporary_manifest.unlink(missing_ok=True)
            except Exception as exc:
                logger.warning("Codex image generation failed: kind=%s", type(exc).__name__)
                with self._lock:
                    if job.status != "cancelled":
                        job.status = "failed"
                        job.error = type(exc).__name__
                        job.updated_at = time.time()
            finally:
                with self._lock:
                    if self._current_job_id == job_id:
                        self._current_job_id = ""

    def _run_codex(self, topic: str, job_dir: Path) -> Path:
        executable = shutil.which(self.codex_path) if not Path(self.codex_path).is_file() else self.codex_path
        if not executable:
            raise ImageGenerationError("codex_not_found")
        if not self.skill_path.is_file():
            raise ImageGenerationError("imagegen_skill_not_found")

        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        process = subprocess.Popen(
            [str(executable), "app-server", "--stdio", "--enable", "image_generation"],
            cwd=job_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=flags,
            env=_minimal_codex_environment(),
        )
        try:
            process_tree = _WindowsProcessJob(process)
        except Exception:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            raise
        with self._lock:
            self._process = process
        messages: queue.Queue[dict[str, Any] | None] = queue.Queue()

        def read_messages() -> None:
            assert process.stdout is not None
            for line in iter(process.stdout.readline, ""):
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    # Never retain the base64 image body carried by completion events.
                    item = ((value.get("params") or {}).get("item") or {})
                    if isinstance(item, dict) and item.get("type") == "imageGeneration":
                        item.pop("result", None)
                    messages.put(value)
            messages.put(None)

        reader = threading.Thread(target=read_messages, name="imagegen-protocol-reader", daemon=True)
        reader.start()
        deadline = time.monotonic() + self.timeout_seconds

        def send(message: dict[str, Any]) -> None:
            if process.stdin is None:
                raise ImageGenerationError("app_server_stdin_unavailable")
            process.stdin.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
            process.stdin.flush()

        def response(request_id: int) -> dict[str, Any]:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ImageGenerationError("app_server_timeout")
                try:
                    message = messages.get(timeout=min(1.0, remaining))
                except queue.Empty:
                    if process.poll() is not None:
                        raise ImageGenerationError("app_server_exited")
                    continue
                if message is None:
                    raise ImageGenerationError("app_server_closed")
                if message.get("id") == request_id:
                    if message.get("error"):
                        raise ImageGenerationError(f"protocol_request_{request_id}_failed")
                    return message

        try:
            send({
                "id": 1,
                "method": "initialize",
                "params": {"clientInfo": {"name": "family-ai-teacher", "version": "0.3.0"}},
            })
            response(1)
            send({
                "id": 2,
                "method": "thread/start",
                "params": {
                    "cwd": str(job_dir),
                    "model": self.model,
                    "allowProviderModelFallback": False,
                    "approvalPolicy": "never",
                    "sandbox": "workspace-write",
                    "ephemeral": True,
                    "baseInstructions": (
                        "Work only inside the provided job directory. Do not read family data, "
                        "project files, credentials, or other conversations. Use only the supplied "
                        "system imagegen skill and its default built-in image_gen tool. Do not use "
                        "CLI/API fallback and do not request credentials."
                    ),
                },
            })
            started = response(2)
            thread_id = str((((started.get("result") or {}).get("thread") or {}).get("id") or ""))
            if not thread_id:
                raise ImageGenerationError("thread_id_missing")
            prompt = (
                f"Generate exactly one child-friendly educational illustration about {topic}. "
                "Use a plain light background, a clear centered subject, cheerful simple 2D cartoon "
                "style, and age-appropriate details. Include no words, letters, numbers, labels, "
                "logos, watermark, people, or personal data. Use only the default built-in image_gen "
                "tool. Copy the selected result into the current job directory as result.png. "
                "Verify the PNG exists, then report only its filename and dimensions."
            )
            send({
                "id": 3,
                "method": "turn/start",
                "params": {
                    "threadId": thread_id,
                    "effort": "low",
                    "input": [
                        {"type": "skill", "name": "imagegen", "path": str(self.skill_path)},
                        {"type": "text", "text": prompt},
                    ],
                },
            })
            response(3)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ImageGenerationError("image_generation_timeout")
                try:
                    message = messages.get(timeout=min(1.0, remaining))
                except queue.Empty:
                    if self._stop.is_set():
                        raise ImageGenerationError("shutdown")
                    if process.poll() is not None:
                        raise ImageGenerationError("app_server_exited")
                    continue
                if message is None:
                    raise ImageGenerationError("app_server_closed")
                if message.get("method") == "turn/completed":
                    turn = (message.get("params") or {}).get("turn") or {}
                    if turn.get("status") != "completed" or turn.get("error"):
                        raise ImageGenerationError("turn_failed")
                    break
            result = job_dir / "result.png"
            _png_dimensions(result)
            return result
        finally:
            with self._lock:
                self._process = None
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
            if os.name != "nt":
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)
            else:
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
                if not process_tree.close_and_wait():
                    raise ImageGenerationError("process_tree_cleanup_failed")
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired as exc:
                    raise ImageGenerationError("app_server_cleanup_failed") from exc

    def shutdown(self) -> None:
        self._stop.set()
        try:
            self._pending.put_nowait(None)
        except queue.Full:
            pass
        with self._lock:
            process = self._process
        if process is not None and process.poll() is None:
            process.terminate()
        worker = self._worker
        if worker is not None and worker.is_alive():
            worker.join(timeout=3)
