"""One-family bridge to the existing SoulX renderer on AI Station."""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


class ParentAvatarError(RuntimeError):
    pass


class ParentAvatarBridge:
    def __init__(self, data_dir: Path, host: str = "ai") -> None:
        self.marker = data_dir / "parent_identity" / "avatar.sha256"
        self.host = host

    def _remote(self, action: str, image: bytes | None = None) -> None:
        # ssh runs the remote command from the remote user's home directory,
        # so a home-relative default works on any self-hosted machine.
        # Override with PARENT_AVATAR_REMOTE_SCRIPT when the layout differs.
        remote_script = os.getenv(
            "PARENT_AVATAR_REMOTE_SCRIPT",
            "family-ai-teacher/services/parent_avatar.py",
        )
        command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", self.host,
                   "python3", remote_script, action]
        if os.getenv("PARENT_AVATAR_TRANSPORT", "ssh") == "local":
            command = [sys.executable, os.environ["PARENT_AVATAR_SCRIPT"], action]
        for attempt in range(2):
            try:
                result = subprocess.run(command, input=image, capture_output=True, timeout=50)
            except (OSError, subprocess.TimeoutExpired) as exc:
                if attempt:
                    raise ParentAvatarError("AI Station 数字人暂时无法连接") from exc
            else:
                if not result.returncode and result.stdout.strip().startswith(b"PASS parent_avatar="):
                    return
                if attempt:
                    raise ParentAvatarError("AI Station 没有确认数字人形象切换")
            time.sleep(1)

    def activate(self, image: bytes) -> None:
        self._remote("activate", image)
        self.marker.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".avatar-state-", dir=self.marker.parent)
        try:
            with os.fdopen(fd, "w", encoding="ascii") as stream:
                stream.write(hashlib.sha256(image).hexdigest())
            os.replace(temporary, self.marker)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def restore(self) -> None:
        self._remote("restore")
        self.marker.unlink(missing_ok=True)

    def configured_for(self, image: bytes | None) -> bool:
        try:
            return bool(image and self.marker.read_text(encoding="ascii") == hashlib.sha256(image).hexdigest())
        except OSError:
            return False
