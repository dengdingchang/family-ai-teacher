"""Explicit, ephemeral camera-frame contract. The browser owns camera preview."""

from __future__ import annotations

from datetime import datetime, timezone
import shutil
import subprocess
import tempfile
from pathlib import Path


class CameraAdapterError(ValueError):
    pass


class BrowserCameraAdapter:
    MAX_FRAME_BYTES = 8 * 1024 * 1024
    MAX_VIDEO_BYTES = 32 * 1024 * 1024

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

    def extract_video_keyframes(self, video_bytes: bytes, filename: str = "child-action.webm") -> list[bytes]:
        """Decode a short browser clip into a few in-memory JPEG keyframes.

        The raw clip is written only to the OS temporary directory so ffmpeg can
        decode it, then the temporary directory is removed before this returns.
        The current AI Station contract accepts images, so three keyframes are a
        small bridge for action-oriented video questions.
        """

        if not video_bytes:
            raise CameraAdapterError("video is empty")
        if len(video_bytes) > self.MAX_VIDEO_BYTES:
            raise CameraAdapterError("video is too large")

        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            raise CameraAdapterError("ffmpeg and ffprobe are required for video analysis")

        suffix = Path(filename).suffix.lower()
        if suffix not in {".webm", ".mp4", ".mov", ".m4v", ".ogv"}:
            suffix = ".webm"

        with tempfile.TemporaryDirectory(prefix="family-ai-teacher-video-") as temp_dir:
            video_path = Path(temp_dir) / f"input{suffix}"
            video_path.write_bytes(video_bytes)
            duration_s = 0.0
            try:
                probe = subprocess.run(
                    [
                        ffprobe,
                        "-v",
                        "error",
                        "-show_entries",
                        "format=duration",
                        "-of",
                        "default=noprint_wrappers=1:nokey=1",
                        str(video_path),
                    ],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=8,
                    check=True,
                )
                duration_s = max(0.0, float(probe.stdout.strip()))
            except (OSError, ValueError, subprocess.SubprocessError):
                # Browser clips can omit duration metadata; first-frame fallback
                # is still useful and does not block the rest of the conversation.
                duration_s = 0.0

            if duration_s > 0.2:
                times = [0.0, duration_s / 2.0, max(0.0, duration_s - 0.2)]
            else:
                times = [0.0]

            frames: list[bytes] = []
            for timestamp in times:
                try:
                    result = subprocess.run(
                        [
                            ffmpeg,
                            "-hide_banner",
                            "-loglevel",
                            "error",
                            "-ss",
                            f"{timestamp:.3f}",
                            "-i",
                            str(video_path),
                            "-frames:v",
                            "1",
                            "-vf",
                            "scale=640:-2:force_original_aspect_ratio=decrease",
                            "-q:v",
                            "5",
                            "-f",
                            "image2pipe",
                            "-vcodec",
                            "mjpeg",
                            "pipe:1",
                        ],
                        capture_output=True,
                        timeout=12,
                        check=True,
                    )
                except (OSError, subprocess.SubprocessError):
                    continue
                frame = result.stdout
                if frame.startswith(b"\xff\xd8\xff"):
                    frames.append(frame)

        if not frames:
            raise CameraAdapterError("could not extract a frame from the video")
        return frames
