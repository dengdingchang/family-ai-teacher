"""Device admission, fallback and cancellation with synthetic RAM bytes only."""

import io
import json
import os
import queue
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import stt.adapter as adapter_module
from stt.adapter import FasterWhisperCPUAdapter, STTAdapterError


def make_adapter(tmp_path, **kwargs):
    primary, fallback = tmp_path / "small", tmp_path / "base"
    primary.mkdir(exist_ok=True)
    fallback.mkdir(exist_ok=True)
    settings = SimpleNamespace(project_root=Path.cwd(), stt_ready=True,
        stt_python=tmp_path / "python.exe", stt_model_path=primary,
        stt_fallback_model_path=fallback, stt_cuda_library_dir=tmp_path / "dlls",
        stt_language="zh", stt_compute_type="int8_float16", stt_device="cuda")
    return FasterWhisperCPUAdapter(settings, **kwargs)


def fake_process():
    process = Mock()
    process.poll.return_value = None
    process.stdin = io.StringIO()
    process.terminate.side_effect = lambda: setattr(process.poll, "return_value", 0)
    return process


def mock_launch(monkeypatch, adapter):
    launches = []

    def launch(device, model_path, compute_type):
        process = fake_process()
        launches.append((device, model_path, compute_type, process))
        adapter._process = process
        adapter._responses = queue.Queue()
        adapter._runtime.update(status="ready", device=device, compute_type=compute_type)
        return process

    monkeypatch.setattr(adapter, "_launch_process", launch)
    return launches


def transcript(request_id, text="new result"):
    return {"event": "transcript", "id": request_id, "text": text,
            "language": "zh", "duration_s": 1.2}


@pytest.mark.parametrize("first_payload,reason", [
    ({"event": "startup_error", "reason": "insufficient_vram"}, "insufficient_vram"),
    ({"event": "startup_error", "reason": "cuda_dependencies_invalid"}, "cuda_dependencies_invalid"),
    (None, "cuda_start_failed"),
])
def test_cuda_startup_failure_uses_fresh_cpu_base_once(monkeypatch, tmp_path, first_payload, reason):
    adapter = make_adapter(tmp_path)
    calls = []
    original_path = os.environ.get("PATH")

    def popen(command, **kwargs):
        process = fake_process()
        payload = first_payload if not calls else {"event": "ready", "device": "cpu", "compute_type": "int8_float32"}
        process.stdout = io.StringIO(json.dumps(payload) + "\n")
        calls.append((command, kwargs, process))
        return process

    monkeypatch.setattr(adapter_module.subprocess, "Popen", popen)
    adapter.warmup()
    adapter.warmup()
    assert len(calls) == 2
    gpu_command, cpu_command = calls[0][0], calls[1][0]
    assert gpu_command[gpu_command.index("--device") + 1] == "cuda"
    assert cpu_command[cpu_command.index("--device") + 1] == "cpu"
    assert cpu_command[cpu_command.index("--model") + 1] == str(adapter.settings.stt_fallback_model_path)
    assert cpu_command[cpu_command.index("--compute-type") + 1] == "int8"
    assert "--cuda-library-dir" not in cpu_command
    assert all(call[1]["env"].get("PATH") == original_path for call in calls)
    assert os.environ.get("PATH") == original_path
    assert all(call[1]["stderr"] == adapter_module.subprocess.DEVNULL for call in calls)
    assert adapter.runtime_status["device"] == "cpu"
    assert adapter.runtime_status["compute_type"] == "int8_float32"
    assert adapter.runtime_status["fallback_reason"] == reason
    adapter.runtime_status["device"] = "changed"
    assert adapter.runtime_status["device"] == "cpu"
    assert str(tmp_path) not in json.dumps(adapter.runtime_status)


def test_tts_not_ready_never_attempts_cuda_even_after_tts_recovers(monkeypatch, tmp_path):
    admission = Mock(return_value=False)
    adapter = make_adapter(tmp_path, cuda_start_allowed=admission)
    launches = mock_launch(monkeypatch, adapter)
    adapter.warmup()
    admission.return_value = True
    adapter._close_process()
    adapter.warmup()
    assert [item[0] for item in launches] == ["cpu", "cpu"]
    assert all(item[1] == adapter.settings.stt_fallback_model_path and item[2] == "int8" for item in launches)
    assert adapter.runtime_status["fallback_reason"] == "tts_not_ready"
    admission.assert_called_once()


def test_cpu_default_does_not_consult_gpu_admission_or_fallback(monkeypatch, tmp_path):
    admission = Mock(side_effect=AssertionError("CPU must not query GPU admission"))
    adapter = make_adapter(tmp_path, cuda_start_allowed=admission)
    del adapter.settings.stt_device
    adapter.settings.stt_compute_type = "int8"
    launches = mock_launch(monkeypatch, adapter)
    adapter.warmup()
    adapter.warmup()
    assert [(item[0], item[1], item[2]) for item in launches] == [("cpu", adapter.settings.stt_model_path, "int8")]
    admission.assert_not_called()


@pytest.mark.parametrize("failure", [None, {"event": "error", "id": "1", "retry_on_cpu": True}])
def test_gpu_crash_retries_ram_bytes_once_without_old_queue_results(monkeypatch, tmp_path, failure):
    adapter = make_adapter(tmp_path)
    launches = mock_launch(monkeypatch, adapter)
    sent, old_queues = [], []

    def send(process, payload):
        sent.append(payload)
        if payload["id"] == "1":
            old_queues.append(adapter._responses)
            adapter._responses.put(failure)
            adapter._responses.put(transcript("1", "discarded old result"))
        else:
            adapter._responses.put(transcript(payload["id"]))

    monkeypatch.setattr(adapter, "_send", send)
    assert adapter.transcribe_bytes(b"synthetic-wav").text == "new result"
    assert adapter.transcribe_bytes(b"another-synthetic-wav").text == "new result"
    assert [item[0] for item in launches] == ["cuda", "cpu"]
    assert [item["id"] for item in sent] == ["1", "2", "3"]
    assert sent[0]["audio_base64"] == sent[1]["audio_base64"]
    assert old_queues[0] is not adapter._responses
    assert not old_queues[0].empty()
    assert adapter.runtime_status["fallback_reason"] in {"cuda_worker_stopped", "cuda_inference_failed"}


def test_bad_wav_does_not_disable_gpu_and_next_request_reuses_it(monkeypatch, tmp_path):
    adapter = make_adapter(tmp_path)
    launches = mock_launch(monkeypatch, adapter)

    def send(process, payload):
        result = {"event": "error", "id": "1", "error": "private media text", "retry_on_cpu": False}
        adapter._responses.put(result if payload["id"] == "1" else transcript(payload["id"]))

    monkeypatch.setattr(adapter, "_send", send)
    with pytest.raises(STTAdapterError, match="could not decode") as caught:
        adapter.transcribe_bytes(b"invalid-synthetic")
    assert "private" not in str(caught.value)
    assert adapter.transcribe_bytes(b"valid-synthetic").text == "new result"
    assert len(launches) == 1
    assert adapter.runtime_status["device"] == "cuda"
    assert adapter.runtime_status["fallback_reason"] is None


def test_cancel_before_gpu_error_does_not_replay_and_next_result_is_new(monkeypatch, tmp_path):
    stop = threading.Event()
    adapter = make_adapter(tmp_path)
    launches = mock_launch(monkeypatch, adapter)
    sent = []

    def send(process, payload):
        sent.append(payload)
        if payload.get("command") == "cancel":
            return
        if payload["id"] == "1":
            stop.set()
            adapter._responses.put({"event": "error", "id": "1", "retry_on_cpu": True})
        else:
            adapter._responses.put(transcript(payload["id"]))

    monkeypatch.setattr(adapter, "_send", send)
    with pytest.raises(STTAdapterError, match="cancelled"):
        adapter.transcribe_bytes(b"cancelled-synthetic", cancel_event=stop)
    assert len(launches) == 1
    assert adapter._responses.empty()
    assert adapter.transcribe_bytes(b"different-synthetic").text == "new result"
    assert [item["id"] for item in sent if "audio_base64" in item] == ["1", "2"]


def test_no_implicit_small_model_cpu_fallback(monkeypatch, tmp_path):
    adapter = make_adapter(tmp_path, cuda_start_allowed=lambda: False)
    adapter.settings.stt_fallback_model_path = None
    launches = mock_launch(monkeypatch, adapter)
    with pytest.raises(STTAdapterError, match="fallback model is not available"):
        adapter.warmup()
    assert launches == []


def test_cancel_during_failed_cuda_start_does_not_start_cpu(monkeypatch, tmp_path):
    stop = threading.Event()
    adapter = make_adapter(tmp_path)
    launches = []

    def launch(device, model_path, compute_type):
        launches.append(device)
        stop.set()
        raise STTAdapterError("STT worker did not become ready")

    monkeypatch.setattr(adapter, "_launch_process", launch)
    with pytest.raises(STTAdapterError, match="cancelled"):
        adapter.transcribe_bytes(b"synthetic", cancel_event=stop)
    assert launches == ["cuda"]


def test_gpu_timeout_switches_once_to_cpu(monkeypatch, tmp_path):
    adapter = make_adapter(tmp_path)
    launches = mock_launch(monkeypatch, adapter)
    sent = []

    def send(process, payload):
        sent.append(payload)
        if payload["id"] != "1":
            adapter._responses.put(transcript(payload["id"]))

    monkeypatch.setattr(adapter, "_send", send)
    clock_values = iter([0, 121, 122, 123, 124, 125])
    monkeypatch.setattr(adapter_module.time, "monotonic", lambda: next(clock_values))
    assert adapter.transcribe_bytes(b"synthetic").text == "new result"
    assert [item[0] for item in launches] == ["cuda", "cpu"]
    assert adapter.runtime_status["fallback_reason"] == "cuda_inference_failed"


def test_cpu_failure_after_cuda_crash_does_not_start_third_worker(monkeypatch, tmp_path):
    adapter = make_adapter(tmp_path)
    launches = mock_launch(monkeypatch, adapter)
    monkeypatch.setattr(adapter, "_send", lambda process, payload: adapter._responses.put(None))
    with pytest.raises(STTAdapterError, match="invalid response"):
        adapter.transcribe_bytes(b"synthetic")
    assert [item[0] for item in launches] == ["cuda", "cpu"]
