"""One-family, explicit parent enrollment without retained recording media."""

from __future__ import annotations

import base64
from array import array
import hashlib
import io
import json
import math
import os
import secrets
import struct
import tempfile
import threading
import wave
from pathlib import Path


class EnrollmentError(ValueError):
    pass


def decode_media(value: str, *, limit: int) -> bytes:
    if not isinstance(value, str) or len(value) > (limit * 4 // 3 + 16):
        raise EnrollmentError("录制内容过大，请重新录制")
    try:
        content = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise EnrollmentError("录制内容无法读取，请重新录制") from exc
    if not content or len(content) > limit:
        raise EnrollmentError("录制内容过大，请重新录制")
    return content


def check_portrait(content: bytes) -> tuple[bytes, dict]:
    try:
        from PIL import Image, ImageFilter, ImageOps, ImageStat

        image = ImageOps.exif_transpose(Image.open(io.BytesIO(content)))
        image.load()
    except (ImportError, OSError, ValueError) as exc:
        raise EnrollmentError("画面无法读取，请重新录制") from exc
    if image.width < 320 or image.height < 320 or image.width * image.height > 4_000_000:
        raise EnrollmentError("请让脸和肩膀完整进入画面，再重新录制")
    image = image.convert("RGB")
    image.thumbnail((768, 768))
    gray = image.convert("L")
    mean = ImageStat.Stat(gray).mean[0]
    contrast = ImageStat.Stat(gray).stddev[0]
    edge = ImageStat.Stat(gray.filter(ImageFilter.FIND_EDGES)).stddev[0]
    if mean < 48:
        raise EnrollmentError("画面太暗，请面向窗户或开灯后重录")
    if mean > 223:
        raise EnrollmentError("画面过亮，请避开强逆光后重录")
    if contrast < 23 or edge < 12:
        raise EnrollmentError("画面不够清晰，请擦净镜头、保持不动后重录")
    output = io.BytesIO()
    image.save(output, "JPEG", quality=88, optimize=True)
    return output.getvalue(), {"light": "合格", "sharpness": "合格", "size": "合格"}


def check_voice(content: bytes) -> dict:
    try:
        with wave.open(io.BytesIO(content), "rb") as source:
            channels, width, rate = source.getnchannels(), source.getsampwidth(), source.getframerate()
            frames = source.getnframes()
            if channels != 1 or width != 2 or not 16000 <= rate <= 48000:
                raise EnrollmentError("声音格式不支持，请在页面中重新录制")
            duration = frames / rate
            if not 5 <= duration <= 22:
                raise EnrollmentError("请完整读完引导句，录制约八到十五秒")
            pcm = source.readframes(frames)
    except (EOFError, wave.Error) as exc:
        raise EnrollmentError("声音无法读取，请重新录制") from exc
    samples = array("h")
    samples.frombytes(pcm)
    if not samples:
        raise EnrollmentError("没有录到声音，请重新录制")
    stride = max(1, len(samples) // 12000)
    sample = samples[::stride]
    rms = math.sqrt(sum(value * value for value in sample) / len(sample))
    clipped = sum(abs(value) >= 32000 for value in sample) / len(sample)
    if rms < 320:
        raise EnrollmentError("声音太小，请靠近设备麦克风并在安静环境重录")
    if clipped > 0.025:
        raise EnrollmentError("声音有破音，请稍微离麦克风远一点重录")
    window_size = max(1, rate // 2)
    windows = [samples[start:start + window_size] for start in range(0, len(samples), window_size)]
    voiced = sum(
        math.sqrt(sum(value * value for value in window) / len(window)) >= 320
        for window in windows if window
    )
    if voiced < max(6, math.ceil(len(windows) * 0.4)):
        raise EnrollmentError("说话时间太短，请完整读完提示句后重录")
    return {"duration_seconds": round(duration, 1), "volume": "合格", "clipping": "合格",
            "speaking_duration_seconds": round(voiced * 0.5, 1)}


def validate_embedding(value: bytes) -> None:
    if not value or len(value) % 4 or len(value) > 16384:
        raise EnrollmentError("声音特征无法读取，请重新录制")
    numbers = struct.unpack("<" + "f" * (len(value) // 4), value)
    if not all(math.isfinite(item) for item in numbers) or max(map(abs, numbers)) > 100:
        raise EnrollmentError("声音特征无效，请重新录制")


class ParentEnrollmentStore:
    def __init__(self, data_dir: Path) -> None:
        self.root = data_dir / "parent_identity"
        self._lock = threading.RLock()
        self._draft: dict | None = None

    def _paths(self) -> tuple[Path, Path, Path]:
        return self.root / "active.json", self.root / "portrait.jpg", self.root / "voice.f32"

    def active(self) -> bool:
        manifest, portrait, voice = self._paths()
        try:
            record = json.loads(manifest.read_text(encoding="utf-8"))
            return (record.get("version") == 1 and
                    hashlib.sha256(portrait.read_bytes()).hexdigest() == record.get("portrait_sha256") and
                    hashlib.sha256(voice.read_bytes()).hexdigest() == record.get("voice_sha256"))
        except (OSError, ValueError, TypeError):
            return False

    def voice_path(self) -> Path | None:
        return self._paths()[2] if self.active() else None

    def portrait_path(self) -> Path | None:
        return self._paths()[1] if self.active() else None

    def stage(self, portrait: bytes, embedding: bytes) -> str:
        validate_embedding(embedding)
        token = secrets.token_urlsafe(24)
        with self._lock:
            self._draft = {"token": token, "portrait": portrait, "embedding": embedding}
        return token

    def take(self, token: str) -> tuple[bytes, bytes]:
        with self._lock:
            if not self._draft or not secrets.compare_digest(token, self._draft["token"]):
                raise EnrollmentError("试听已失效，请重新录制")
            draft, self._draft = self._draft, None
            return draft["portrait"], draft["embedding"]

    def peek(self, token: str) -> tuple[bytes, bytes]:
        """Keep the confirmed preview available if remote activation needs a retry."""
        with self._lock:
            if not self._draft or not secrets.compare_digest(token, self._draft["token"]):
                raise EnrollmentError("试听已失效，请重新录制")
            return self._draft["portrait"], self._draft["embedding"]

    def discard(self, token: str) -> None:
        with self._lock:
            if self._draft and secrets.compare_digest(token, self._draft["token"]):
                self._draft = None

    def commit(self, portrait_bytes: bytes, voice_bytes: bytes) -> None:
        validate_embedding(voice_bytes)
        self.root.mkdir(parents=True, exist_ok=True)
        manifest, portrait, voice = self._paths()
        def atomic_write(target: Path, content: bytes) -> None:
            fd, temporary = tempfile.mkstemp(prefix=".enroll-", dir=self.root)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        with self._lock:
            atomic_write(portrait, portrait_bytes)
            atomic_write(voice, voice_bytes)
            record = {"version": 1,
                      "portrait_sha256": hashlib.sha256(portrait_bytes).hexdigest(),
                      "voice_sha256": hashlib.sha256(voice_bytes).hexdigest()}
            atomic_write(manifest, json.dumps(record).encode("utf-8"))

    def clear(self, *, preserve_draft: bool = False) -> None:
        with self._lock:
            if not preserve_draft:
                self._draft = None
            for path in self._paths():
                path.unlink(missing_ok=True)
