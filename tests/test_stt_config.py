"""Explicit optional GPU configuration using temporary runtime paths."""

from dataclasses import replace
import os

import app.config as config


def load_clean_settings(monkeypatch):
    monkeypatch.setattr(config, "load_dotenv", lambda path: None)
    for key in list(os.environ):
        if key.startswith("STT_"):
            monkeypatch.delenv(key)
    return config.Settings.load()


def test_settings_remain_cpu_without_cuda_configuration(monkeypatch, tmp_path):
    settings = load_clean_settings(monkeypatch)
    assert settings.stt_device == "cpu"
    assert settings.stt_compute_type == "int8"
    assert settings.stt_language == "zh"
    assert settings.stt_cuda_library_dir is None
    assert settings.stt_fallback_model_path is None
    python = tmp_path / "python.exe"
    model = tmp_path / "base"
    python.write_bytes(b"synthetic")
    model.mkdir()
    assert replace(settings, stt_python=python, stt_model_path=model).stt_ready


def test_cuda_and_fallback_paths_are_only_taken_from_explicit_configuration(monkeypatch, tmp_path):
    load_clean_settings(monkeypatch)
    python, primary, fallback, libraries = [tmp_path / name for name in ("python.exe", "small", "base", "dlls")]
    python.write_bytes(b"synthetic")
    fallback.mkdir()
    monkeypatch.setenv("STT_PYTHON", str(python))
    monkeypatch.setenv("STT_MODEL_PATH", str(primary))
    monkeypatch.setenv("STT_DEVICE", "CUDA")
    monkeypatch.setenv("STT_CUDA_LIBRARY_DIR", str(libraries))
    monkeypatch.setenv("STT_FALLBACK_MODEL_PATH", str(fallback))
    settings = config.Settings.load()
    assert settings.stt_device == "cuda"
    assert settings.stt_cuda_library_dir == libraries
    assert settings.stt_fallback_model_path == fallback
    assert settings.stt_ready  # The explicitly configured CPU fallback exists.
    assert not replace(settings, stt_device="cpu").stt_ready
    assert not replace(settings, stt_fallback_model_path=None).stt_ready


def test_unknown_device_defaults_to_cpu(monkeypatch):
    load_clean_settings(monkeypatch)
    monkeypatch.setenv("STT_DEVICE", "automatic")
    assert config.Settings.load().stt_device == "cpu"
