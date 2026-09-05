"""CPU worker lifecycle, privacy, and cancellation without model execution."""

import json
import queue
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from stt.adapter import FasterWhisperCPUAdapter, STTAdapterError


def adapter_with_result(monkeypatch, payload):
    adapter = FasterWhisperCPUAdapter(SimpleNamespace(project_root=Path.cwd(), stt_language="zh"))
    process = Mock()
    process.poll.return_value = None
    monkeypatch.setattr(adapter, "_ensure_process", lambda: process)
    monkeypatch.setattr(adapter, "_send", Mock())
    adapter._responses.put(payload)
    return adapter, process


def transcript(request_id="1", text="蓝色积木"):
    return {"event": "transcript", "id": request_id, "text": text,
            "language": "zh", "duration_s": 2.3}


def test_repeated_transcription_reuses_worker_and_never_runs_gpu_probe(monkeypatch):
    adapter, process = adapter_with_result(monkeypatch, transcript())
    result = adapter.transcribe_bytes(b"synthetic-wav")
    assert result.text == "蓝色积木"
    assert result.gpu.available is False
    adapter._responses.put(transcript("2", "红色积木"))
    assert adapter.transcribe_bytes(b"different-wav").text == "红色积木"
    assert adapter._send.call_count == 2
    assert all('audio_base64' in call.args[1] for call in adapter._send.call_args_list)
    process.terminate.assert_not_called()


def test_cancelled_waiter_does_not_start_or_send_audio(monkeypatch):
    adapter, _ = adapter_with_result(monkeypatch, transcript())
    stop = threading.Event()
    with ThreadPoolExecutor(max_workers=1) as executor:
        with adapter._lock:
            future = executor.submit(adapter.transcribe_bytes, b"synthetic", cancel_event=stop)
            stop.set()
            with pytest.raises(STTAdapterError, match="cancelled"):
                future.result(timeout=1)
    adapter._send.assert_not_called()


def test_cancelled_live_request_is_drained_and_cannot_return_old_text(monkeypatch):
    adapter, process = adapter_with_result(monkeypatch, transcript())
    stop = threading.Event()
    sent = []

    def send(_process, payload):
        sent.append(payload)
        if 'audio_base64' in payload:
            stop.set()

    monkeypatch.setattr(adapter, "_send", send)
    with pytest.raises(STTAdapterError, match="cancelled"):
        adapter.transcribe_bytes(b"synthetic", cancel_event=stop)
    assert any(item.get('command') == 'cancel' for item in sent)
    assert adapter._responses.empty()
    process.terminate.assert_not_called()


def test_errors_hide_decoder_details_and_next_request_can_recover(monkeypatch):
    adapter, process = adapter_with_result(monkeypatch, {
        "event": "error", "id": "1", "error": "private child words and private file path",
    })
    with pytest.raises(STTAdapterError) as caught:
        adapter.transcribe_bytes(b"broken")
    assert 'private' not in str(caught.value)
    adapter._responses.put(transcript("2"))
    assert adapter.transcribe_bytes(b"valid").text == "蓝色积木"
    process.terminate.assert_not_called()


def test_response_id_mismatch_stops_worker(monkeypatch):
    adapter, _ = adapter_with_result(monkeypatch, transcript("old"))
    close = Mock()
    monkeypatch.setattr(adapter, "_close_process", close)
    with pytest.raises(STTAdapterError, match="invalid response"):
        adapter.transcribe_bytes(b"synthetic")
    close.assert_called_once()


def test_normalized_browser_audio_is_removed_on_transcription_failure(monkeypatch, tmp_path):
    original = tmp_path / "original.webm"
    original.write_bytes(b"original")
    converted = tmp_path / "temporary.wav"
    converted.write_bytes(b"converted")
    adapter = FasterWhisperCPUAdapter(SimpleNamespace(project_root=Path.cwd(), stt_ready=True))
    monkeypatch.setattr(adapter, "_normalize_browser_audio", lambda path: (converted, converted))
    monkeypatch.setattr(adapter, "transcribe_bytes", Mock(side_effect=STTAdapterError("decode failed")))
    with pytest.raises(STTAdapterError):
        adapter.transcribe(original)
    assert original.read_bytes() == b"original"
    assert not converted.exists()


def test_shutdown_closes_worker_and_refuses_new_audio(monkeypatch):
    adapter, process = adapter_with_result(monkeypatch, transcript())
    adapter._process = process
    adapter.shutdown()
    process.terminate.assert_called_once()
    with pytest.raises(STTAdapterError, match="cancelled"):
        adapter.transcribe_bytes(b"synthetic")
