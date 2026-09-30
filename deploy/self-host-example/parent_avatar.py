"""Switch the existing one-family SoulX service to a consented parent portrait.

Run only through authenticated SSH from the Windows family app. The approved
JPEG is the only transferred media. The stock Nathan service unit stays intact.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path


HOME = Path.home()
IDENTITY = HOME / "family-ai-teacher" / "assets" / "parent" / "portrait.jpg"
DROPIN = HOME / ".config" / "systemd" / "user" / "family-ai-soulx.service.d" / "20-parent-avatar.conf"
PYTHON = "/home/selfhost/family-ai-teacher/runtime/flashhead/.venv/bin/python"
RUNNER = "/home/selfhost/family-ai-teacher/services/remote_soulx_runner.py"
CKPT = "/media/selfhost/ssd4t-data1/family-ai-teacher/models/SoulX-FlashHead-1_3B"
WAV2VEC = "/media/selfhost/ssd4t-data1/family-ai-teacher/models/wav2vec2-base-960h"


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".parent-avatar-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.chmod(temporary, 0o600)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def systemctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, timeout=25)


def apply(active: bool) -> None:
    result = systemctl("daemon-reload")
    if result.returncode:
        raise RuntimeError("systemd reload failed")
    state = systemctl("is-active", "family-ai-soulx.service")
    if state.stdout.strip() == "active":
        restarted = systemctl("restart", "family-ai-soulx.service")
        if restarted.returncode:
            raise RuntimeError("SoulX restart failed")
    print("PASS parent_avatar=" + ("configured" if active else "restored"))


def activate() -> None:
    content = sys.stdin.buffer.read(700_001)
    if not 10_000 <= len(content) <= 700_000 or not content.startswith(b"\xff\xd8") or not content.endswith(b"\xff\xd9"):
        raise ValueError("A bounded JPEG portrait is required")
    prior_image = IDENTITY.read_bytes() if IDENTITY.exists() else None
    prior_dropin = DROPIN.read_bytes() if DROPIN.exists() else None
    unit = ("[Service]\nExecStart=\nExecStart=" + PYTHON + " " + RUNNER +
            " --cond-image " + str(IDENTITY) + " --ckpt " + CKPT +
            " --wav2vec " + WAV2VEC + " --host 127.0.0.1 --port 8791\n")
    try:
        atomic_write(IDENTITY, content)
        atomic_write(DROPIN, unit.encode("utf-8"))
        apply(True)
    except Exception:
        if prior_image is None:
            IDENTITY.unlink(missing_ok=True)
        else:
            atomic_write(IDENTITY, prior_image)
        if prior_dropin is None:
            DROPIN.unlink(missing_ok=True)
        else:
            atomic_write(DROPIN, prior_dropin)
        systemctl("daemon-reload")
        raise


def restore() -> None:
    prior = DROPIN.read_bytes() if DROPIN.exists() else None
    try:
        DROPIN.unlink(missing_ok=True)
        apply(False)
    except Exception:
        if prior is not None:
            atomic_write(DROPIN, prior)
            systemctl("daemon-reload")
        raise
    IDENTITY.unlink(missing_ok=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["activate"]:
        activate()
    elif sys.argv[1:] == ["restore"]:
        restore()
    elif sys.argv[1:] == ["status"]:
        print("configured" if DROPIN.is_file() and IDENTITY.is_file() else "original")
    else:
        raise SystemExit("Expected activate, restore or status")
