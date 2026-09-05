"""Configuration loaded from the project's .env without exposing secrets."""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_dotenv(path: Path) -> None:
    """Load simple KEY=VALUE lines, keeping already-exported values authoritative."""

    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


def _path_env(name: str, default: str) -> Path:
    return Path(os.getenv(name, default)).expanduser()


@dataclass(frozen=True)
class Settings:
    project_root: Path
    frontend_dir: Path
    data_dir: Path
    profile_path: Path
    history_path: Path
    learning_events_path: Path
    fallback_avatar_path: Path

    app_host: str
    app_port: int

    llm_base_url: str
    llm_api_key: str
    llm_model: str
    llm_timeout_seconds: float
    llm_vision_timeout_seconds: float

    stt_python: Path
    stt_model_path: Path
    stt_language: str
    stt_compute_type: str

    tts_python: Path
    tts_runner: Path
    tts_model: Path
    tts_ref_audio: Path
    tts_ref_text_file: Path
    tts_ref_text: str
    tts_language: str
    tts_dtype: str
    tts_timeout_seconds: float
    tts_mode: str
    tts_prompt_mode: str
    tts_remote_base_url: str
    tts_remote_timeout_seconds: float
    tts_cpu: bool

    avatar_image_path: Path | None
    avatar_ws_url: str
    avatar_audio_lead_ms: int
    tts_remote_retry_cooldown_seconds: float = 30.0
    tts_streaming_python: Path | None = None
    avatar_idle_path: Path | None = None

    @classmethod
    def load(cls) -> "Settings":
        load_dotenv(PROJECT_ROOT / ".env")

        configured_host = os.getenv("APP_HOST", "127.0.0.1").strip()
        # The MVP deliberately stays local. A future LAN mode must be an explicit change.
        app_host = configured_host if configured_host in {"127.0.0.1", "localhost"} else "127.0.0.1"
        try:
            app_port = int(os.getenv("APP_PORT", "8760"))
        except ValueError:
            app_port = 8760

        data_dir = PROJECT_ROOT / "data"
        avatar_value = os.getenv("AVATAR_IMAGE_PATH", "").strip()
        avatar_path = Path(avatar_value).expanduser() if avatar_value else None
        idle_value = os.getenv("AVATAR_IDLE_PATH", "").strip()
        idle_path = Path(idle_value).expanduser() if idle_value else None
        if idle_path is not None and not idle_path.is_absolute():
            idle_path = PROJECT_ROOT / idle_path
        tts_prompt_mode = os.getenv("TTS_PROMPT_MODE", "speaker_vector").strip().lower()
        if tts_prompt_mode not in {"speaker_vector", "icl"}:
            tts_prompt_mode = "speaker_vector"

        return cls(
            project_root=PROJECT_ROOT,
            frontend_dir=PROJECT_ROOT / "frontend",
            data_dir=data_dir,
            profile_path=data_dir / "child_profile.json",
            history_path=data_dir / "session_history.jsonl",
            learning_events_path=data_dir / "learning_events.jsonl",
            fallback_avatar_path=PROJECT_ROOT / "frontend" / "avatar.svg",
            app_host=app_host,
            app_port=app_port,
            llm_base_url=os.getenv("LLM_BASE_URL", "").strip().rstrip("/"),
            llm_api_key=os.getenv("LLM_API_KEY", "").strip(),
            llm_model=os.getenv("LLM_MODEL", "").strip(),
            llm_timeout_seconds=max(2.0, min(30.0, float(os.getenv("LLM_TIMEOUT_SECONDS", "8")))),
            llm_vision_timeout_seconds=max(
                5.0,
                min(120.0, float(os.getenv("LLM_VISION_TIMEOUT_SECONDS", "25"))),
            ),
            stt_python=_path_env(
                "STT_PYTHON",
                r"X:\AI\faster-whisper-offline\python-3.10.11-embed-amd64\python.exe",
            ),
            stt_model_path=_path_env(
                "STT_MODEL_PATH",
                r"X:\AI\faster-whisper-offline\models\models--Systran--faster-whisper-base\snapshots\ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
            ),
            stt_language=os.getenv("STT_LANGUAGE", "zh").strip() or "zh",
            stt_compute_type=os.getenv("STT_COMPUTE_TYPE", "int8").strip() or "int8",
            tts_python=_path_env(
                "TTS_PYTHON",
                r"X:\AI\local\qwen3-tts-runtime311\.venv\Scripts\python.exe",
            ),
            tts_runner=_path_env(
                "TTS_RUNNER",
                r"X:\AI\local\qwen3-tts-runtime311\qwen3_clone.py",
            ),
            tts_model=_path_env(
                "TTS_MODEL",
                r"X:\AI\local\qwen3-tts-models\Qwen3-TTS-12Hz-1.7B-Base",
            ),
            tts_ref_audio=_path_env(
                "TTS_REF_AUDIO",
                r"X:\UserData\Desktop\暴富工具素材\08_配音\raw\nathan_voice_v2_reference.wav",
            ),
            tts_ref_text_file=_path_env(
                "TTS_REF_TEXT_FILE",
                r"X:\AI\local\qwen3-tts-runtime311\nathan_reference_matrix.json",
            ),
            tts_ref_text=os.getenv("TTS_REF_TEXT", "").strip(),
            tts_language=os.getenv("TTS_LANGUAGE", "Chinese").strip() or "Chinese",
            tts_dtype=os.getenv("TTS_DTYPE", "float16").strip() or "float16",
            tts_timeout_seconds=float(os.getenv("TTS_TIMEOUT_SECONDS", "180")),
            tts_mode=os.getenv("TTS_MODE", "persistent").strip().lower() or "persistent",
            tts_prompt_mode=tts_prompt_mode,
            tts_remote_base_url=os.getenv(
                "TTS_REMOTE_BASE_URL", "http://127.0.0.1:8792"
            ).strip(),
            tts_remote_timeout_seconds=float(os.getenv("TTS_REMOTE_TIMEOUT_SECONDS", "30")),
            tts_remote_retry_cooldown_seconds=float(os.getenv("TTS_REMOTE_RETRY_COOLDOWN_SECONDS", "30")),
            tts_streaming_python=_path_env(
                "TTS_STREAMING_PYTHON", str(PROJECT_ROOT / "runtime/tts-streaming-probe-venv/Scripts/python.exe"),
            ),
            tts_cpu=os.getenv("TTS_CPU", "0").strip().lower() in {"1", "true", "yes", "on"},
            avatar_image_path=avatar_path,
            avatar_idle_path=idle_path,
            avatar_ws_url=os.getenv("AVATAR_WS_URL", "ws://127.0.0.1:8791").strip(),
            avatar_audio_lead_ms=max(0, min(1500, int(os.getenv("AVATAR_AUDIO_LEAD_MS", "900")))),
        )

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_base_url and self.llm_api_key and self.llm_model)

    @property
    def stt_ready(self) -> bool:
        return self.stt_python.is_file() and self.stt_model_path.is_dir()

    @property
    def tts_ready(self) -> bool:
        return all(
            path.is_file() or path.is_dir()
            for path in (
                self.tts_python,
                self.tts_runner,
                self.tts_model,
                self.tts_ref_audio,
                self.tts_ref_text_file,
            )
        )

    @property
    def temp_dir(self) -> Path:
        path = Path(tempfile.gettempdir()) / "family-ai-teacher"
        path.mkdir(parents=True, exist_ok=True)
        return path
