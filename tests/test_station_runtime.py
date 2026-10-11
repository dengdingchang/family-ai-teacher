import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest

from tts.streaming_daemon import gpu_memory_fraction
from app.parent_avatar import ParentAvatarBridge
from scripts.backup_station import backup


def test_station_budget_preserves_default_guard_and_bounds_allocation(monkeypatch):
    gib = 2**30
    monkeypatch.delenv("TTS_STREAMING_GPU_BUDGET_MIB", raising=False)
    with pytest.raises(RuntimeError):
        gpu_memory_fraction(40*gib, 96*gib)
    monkeypatch.setenv("TTS_STREAMING_GPU_BUDGET_MIB", "8192")
    assert gpu_memory_fraction(40*gib, 96*gib) == pytest.approx(8/96)
    with pytest.raises(RuntimeError):
        gpu_memory_fraction(7*gib, 96*gib)
    monkeypatch.setenv("TTS_STREAMING_GPU_BUDGET_MIB", "70000")
    with pytest.raises(RuntimeError):
        gpu_memory_fraction(80*gib, 96*gib)


def test_local_portrait_bridge_does_not_use_ssh(tmp_path, monkeypatch):
    monkeypatch.setenv("PARENT_AVATAR_TRANSPORT", "local")
    monkeypatch.setenv("PARENT_AVATAR_SCRIPT", "/approved/parent_avatar.py")
    run = Mock(return_value=subprocess.CompletedProcess([], 0, b"PASS parent_avatar=configured", b""))
    monkeypatch.setattr(subprocess, "run", run)
    bridge = ParentAvatarBridge(tmp_path)
    bridge.activate(b"approved-derived-portrait")
    assert run.call_args.args[0][1:] == ["/approved/parent_avatar.py", "activate"]
    assert bridge.configured_for(b"approved-derived-portrait")


def test_private_backup_allowlist_and_verified_bytes(tmp_path):
    import tarfile
    root = tmp_path / "app"
    (root / "data").mkdir(parents=True)
    (root / "data/child_profile.json").write_text("{}")
    (root / "data/raw.wav").write_bytes(b"must not archive")
    (root / ".env").write_text("EXAMPLE=synthetic")
    target = backup(root, tmp_path / "backups")
    with tarfile.open(target) as archive:
        assert set(archive.getnames()) == {"data/child_profile.json", ".env", "SHA256.json"}


def test_standby_cannot_start_a_second_writable_service(monkeypatch):
    from app.config import require_primary_deployment
    monkeypatch.setenv("DEPLOYMENT_ROLE", "standby")
    with pytest.raises(RuntimeError, match="Sync current primary data"):
        require_primary_deployment()
    monkeypatch.setenv("DEPLOYMENT_ROLE", "primary")
    require_primary_deployment()
