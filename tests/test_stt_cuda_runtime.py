"""Dependency admission and daemon parameters without loading native models."""

import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from stt import cuda_runtime as cuda
from stt import daemon


def bundle(tmp_path, monkeypatch):
    original, directory = tmp_path / "original", tmp_path / "bundle"
    original.mkdir()
    directory.mkdir()
    main = original / cuda.MAIN_DLL
    main.write_bytes(b"synthetic-main-bytes")
    (directory / cuda.MAIN_DLL).write_bytes(main.read_bytes())
    for name in (*cuda.COMPONENTS, "cublas64_12.dll", "cublasLt64_12.dll"):
        (directory / name).write_bytes(b"synthetic-component")
    monkeypatch.setattr(cuda, "file_version", lambda path: (
        None if path.name in cuda.VERSIONLESS_COMPONENTS else cuda.REVIEWED_VERSION))
    return directory, main


def test_bundle_requires_matching_main_and_all_nonempty_components(tmp_path, monkeypatch):
    directory, main = bundle(tmp_path, monkeypatch)
    assert cuda.validate_bundle(directory, main) == cuda.file_hash(main)
    (directory / cuda.MAIN_DLL).write_bytes(b"other-main-version")
    with pytest.raises(cuda.CudaRuntimeError):
        cuda.validate_bundle(directory, main)
    (directory / cuda.MAIN_DLL).write_bytes(main.read_bytes())
    (directory / cuda.COMPONENTS[0]).unlink()
    with pytest.raises(cuda.CudaRuntimeError):
        cuda.validate_bundle(directory, main)
    (directory / cuda.COMPONENTS[0]).write_bytes(b"synthetic-component")
    (directory / "cublas64_12.dll").write_bytes(b"")
    with pytest.raises(cuda.CudaRuntimeError):
        cuda.validate_bundle(directory, main)


def test_component_version_mismatch_is_rejected(tmp_path, monkeypatch):
    directory, main = bundle(tmp_path, monkeypatch)
    monkeypatch.setattr(cuda, "file_version", lambda path: (
        "9.11.0.1" if path.name == cuda.COMPONENTS[0] else cuda.REVIEWED_VERSION))
    with pytest.raises(cuda.CudaRuntimeError):
        cuda.validate_bundle(directory, main)


@pytest.mark.parametrize("free,reason", [("2791", "insufficient_vram"), ("not available", "cuda_capacity_unavailable")])
def test_cuda_admission_is_one_bounded_probe_and_safe_reason(monkeypatch, free, reason):
    probe = Mock(return_value=free)
    monkeypatch.setattr(cuda.subprocess, "check_output", probe)
    with pytest.raises(cuda.CudaRuntimeError) as caught:
        cuda.require_free_memory()
    assert caught.value.reason == reason
    probe.assert_called_once()
    assert probe.call_args.kwargs["timeout"] == 3
    assert probe.call_args.kwargs["stderr"] == cuda.subprocess.DEVNULL


def test_loaded_dlls_require_single_original_main_and_selected_component_paths(tmp_path, monkeypatch):
    directory, main = bundle(tmp_path, monkeypatch)
    runtime = cuda.CudaRuntime(directory, main, cuda.file_hash(main))
    loaded = [{"name": cuda.MAIN_DLL, "path": main, "version": cuda.REVIEWED_VERSION}]
    loaded.extend({"name": name, "path": directory / name, "version": cuda.REVIEWED_VERSION} for name in cuda.COMPONENTS)
    monkeypatch.setattr(cuda, "loaded_libraries", lambda: loaded)
    runtime.verify()
    loaded.append({"name": cuda.MAIN_DLL, "path": directory / cuda.MAIN_DLL, "version": cuda.REVIEWED_VERSION})
    with pytest.raises(cuda.CudaRuntimeError):
        runtime.verify()
    loaded.pop()
    loaded[1]["path"] = tmp_path / cuda.COMPONENTS[0]
    with pytest.raises(cuda.CudaRuntimeError):
        runtime.verify()


@pytest.mark.parametrize("device,compute", [("cpu", "int8"), ("cuda", "int8_float16")])
def test_daemon_model_device_parameters_are_explicit_and_cpu_skips_cuda(monkeypatch, device, compute):
    factory = Mock(return_value=object())
    runtime = Mock()
    prepare = Mock(return_value=runtime)
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=factory))
    monkeypatch.setattr(daemon, "_prepare_cuda", prepare)
    args = SimpleNamespace(device=device, compute_type=compute, model="synthetic-model", cuda_library_dir="synthetic-dlls")
    model, actual_runtime = daemon.load_model(args)
    factory.assert_called_once_with("synthetic-model", device=device, compute_type=compute,
                                    cpu_threads=4, local_files_only=True)
    if device == "cuda":
        prepare.assert_called_once_with("synthetic-dlls")
        runtime.verify.assert_called_once_with()
        assert actual_runtime is runtime
    else:
        prepare.assert_not_called()
        assert actual_runtime is None


def test_daemon_sibling_import_does_not_require_project_on_sys_path(monkeypatch):
    # An empty directory is rejected before importing CTranslate2 or querying
    # hardware, while exercising the real absolute-file module loader.
    monkeypatch.setattr(sys, "path", [item for item in sys.path if "family-ai-teacher" not in item.lower()])
    if daemon.os.name != "nt":
        def unavailable(*args, **kwargs):
            raise OSError("synthetic missing CUDA runtime")
        monkeypatch.setattr(cuda.subprocess, "check_output", unavailable)
    with pytest.raises(RuntimeError) as caught:
        daemon._prepare_cuda("")
    assert caught.value.reason == "cuda_dependencies_invalid"


@pytest.mark.parametrize("error,retry", [
    (RuntimeError("CUDA failed with private media fragment"), True),
    (RuntimeError("cuDNN execution failure"), True),
    (RuntimeError("out of memory"), True),
    (ValueError("Invalid audio with private path"), False),
    (RuntimeError("Invalid WAV data"), False),
])
def test_only_accelerator_errors_request_cpu_retry(error, retry):
    assert daemon._cuda_failure(error) is retry
    assert daemon._startup_reason(error) == "cuda_start_failed"
