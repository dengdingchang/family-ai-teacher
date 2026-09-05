"""Streaming protocol, cancellation, and PCM integrity without loading a model."""

import base64
import io
import json
import threading
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from tts.adapter import TTSAdapterError
from tts.streaming import StreamingNathanTTSAdapter, join_wav_chunks


def wav(samples=b"\x01\x00" * 160, rate=16000):
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(rate)
        target.writeframes(samples)
    return output.getvalue()


def adapter_with_events(monkeypatch, events):
    settings = SimpleNamespace(project_root=Path.cwd(), tts_timeout_seconds=2)
    adapter = StreamingNathanTTSAdapter(settings)
    process = Mock(stdin=io.StringIO())
    process.poll.return_value = None
    monkeypatch.setattr(adapter, "_ensure_process", lambda: process)
    lines = iter(json.dumps({"id": "1", **event}) for event in events)
    monkeypatch.setattr(adapter, "_readline", lambda *args: next(lines))
    return adapter, process


def chunk(sequence=1):
    return {"event": "chunk", "sequence": sequence, "duration_s": .01,
            "audio_base64": base64.b64encode(wav()).decode()}


def test_join_preserves_all_pcm_without_riff_headers():
    merged, duration = join_wav_chunks([wav(), wav()])
    with wave.open(io.BytesIO(merged), "rb") as source:
        assert source.getnframes() == 320
        assert source.readframes(320) == b"\x01\x00" * 320
    assert duration == .02


def test_join_rejects_changed_sample_rate():
    with pytest.raises(TTSAdapterError, match="changed audio format"):
        join_wav_chunks([wav(), wav(rate=24000)])


def test_chunks_arrive_before_done_and_only_complete_sentence_is_cached(monkeypatch):
    adapter, _ = adapter_with_events(monkeypatch, [chunk(), chunk(2), {"event": "done", "chunks": 2}])
    stream = adapter.synthesize_stream("你好")
    assert next(stream).duration_s == .01
    assert adapter.cache_entries == 0
    assert next(stream).duration_s == .01
    with pytest.raises(StopIteration):
        next(stream)
    assert adapter.is_cached("你好")
    assert list(adapter.synthesize_stream("你好"))[0].duration_s == .02


def test_cancel_drains_old_request_without_caching_or_destroying_warm_worker(monkeypatch):
    adapter, process = adapter_with_events(monkeypatch, [chunk(), chunk(2), {"event": "cancelled", "chunks": 2}])
    stop = threading.Event()
    stream = adapter.synthesize_stream("未说完", cancel_event=stop)
    next(stream)
    stop.set()
    with pytest.raises(TTSAdapterError, match="cancelled"):
        next(stream)
    assert adapter.cache_entries == 0
    assert '"command": "cancel"' in process.stdin.getvalue()
    process.terminate.assert_not_called()


def test_generator_close_also_cancels_and_drains(monkeypatch):
    adapter, process = adapter_with_events(monkeypatch, [chunk(), {"event": "cancelled", "chunks": 1}])
    stream = adapter.synthesize_stream("关闭这句话")
    next(stream)
    stream.close()
    assert '"command": "cancel"' in process.stdin.getvalue()
    assert adapter.cache_entries == 0


def test_incomplete_terminal_cannot_be_cached(monkeypatch):
    adapter, _ = adapter_with_events(monkeypatch, [chunk(), {"event": "done", "chunks": 2}])
    with pytest.raises(TTSAdapterError, match="incomplete"):
        list(adapter.synthesize_stream("断掉的话"))
    assert adapter.cache_entries == 0


def test_precancelled_cache_is_silent(monkeypatch):
    adapter, _ = adapter_with_events(monkeypatch, [])
    adapter._audio_cache["hello"] = (wav(), .01)
    stop = threading.Event()
    stop.set()
    with pytest.raises(TTSAdapterError, match="cancelled"):
        list(adapter.synthesize_stream("hello", cancel_event=stop))


@pytest.mark.parametrize("handshake", ["ready", "error"])
def test_worker_readiness_belongs_to_current_successful_model_handshake(monkeypatch, handshake):
    settings = SimpleNamespace(project_root=Path.cwd(), tts_timeout_seconds=2,
                               tts_model=Path("unused-model"), tts_ref_audio=Path("unused-reference"),
                               tts_language="Chinese")
    adapter = StreamingNathanTTSAdapter(settings)
    process = Mock(stdin=io.StringIO(), stderr=io.StringIO())
    process.poll.return_value = None
    monkeypatch.setattr(StreamingNathanTTSAdapter, "ready", property(lambda self: True))
    monkeypatch.setattr(adapter, "_environment", lambda: {})
    monkeypatch.setattr("tts.streaming.subprocess.Popen", lambda *args, **kwargs: process)

    def response(*args):
        assert adapter._process is process
        assert adapter.worker_ready is False
        return json.dumps({"event": handshake})

    monkeypatch.setattr(adapter, "_readline", response)
    if handshake == "error":
        with pytest.raises(TTSAdapterError):
            adapter._start_process()
        assert adapter.worker_ready is False
    else:
        adapter._start_process()
        assert adapter.worker_ready is True
        process.poll.return_value = 1
        assert adapter.worker_ready is False
        replacement = Mock()
        replacement.poll.return_value = None
        adapter._process = replacement
        assert adapter.worker_ready is False
