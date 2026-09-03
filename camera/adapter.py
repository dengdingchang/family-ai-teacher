"""Explicit, ephemeral camera-frame contract. The browser owns camera preview."""

from __future__ import annotations

from datetime import datetime, timezone


class CameraAdapterError(ValueError):
    pass


class BrowserCameraAdapter:
    MAX_FRAME_BYTES = 8 * 1024 * 1024

    def capture_frame(self, image_bytes: bytes, content_type: str = "image/jpeg") -> dict[str, object]:
        if not image_bytes:
            raise CameraAdapterError("camera frame is empty")
        if len(image_bytes) > self.MAX_FRAME_BYTES:
            raise CameraAdapterError("camera frame is too large")
        is_jpeg = image_bytes.startswith(b"\xff\xd8\xff")
        is_png = image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
        if not (is_jpeg or is_png):
            raise CameraAdapterError("camera frame must be JPEG or PNG")
        return {
            "captured": True,
            "content_type": "image/png" if is_png else content_type,
            "bytes": len(image_bytes),
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "persisted": False,
            "uploaded_to_vision": False,
        }

    def describe_frame(self, _image_bytes: bytes) -> None:
        raise NotImplementedError("Vision is reserved for the AI Station phase")

    def observe_child(self, _image_bytes: bytes) -> None:
        raise NotImplementedError("Child observation is reserved for the AI Station phase")
