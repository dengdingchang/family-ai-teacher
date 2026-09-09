from __future__ import annotations

from pathlib import Path

from app import config


def test_blank_skill_path_uses_current_codex_home(monkeypatch) -> None:
    codex_home = Path.home() / ".codex"
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    monkeypatch.setenv("IMAGEGEN_SKILL_PATH", "")
    assert config.Settings.load().imagegen_skill_path == codex_home / "skills/.system/imagegen/SKILL.md"


def test_generated_image_directories_cannot_escape_project_runtime(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("IMAGEGEN_OUTPUT_DIR", str(tmp_path / "outside"))
    monkeypatch.setenv("IMAGEGEN_JOBS_DIR", str(tmp_path / "outside-jobs"))
    settings = config.Settings.load()
    assert settings.imagegen_output_dir == config.PROJECT_ROOT / "runtime/generated-media"
    assert settings.imagegen_jobs_dir == config.PROJECT_ROOT / "runtime/imagegen-jobs"
