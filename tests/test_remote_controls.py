"""Avatar interruption must remain responsive during next-sentence synthesis."""

import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import httpx
import pytest

from audio.metrics import unavailable_gpu_measurement
from tts.adapter import TTSResult
from tts.remote import RemoteNathanTTSAdapter
from tts.remote import FallbackNathanTTSAdapter
from unittest.mock import Mock


@pytest.mark.parametrize("failure", ["ReadTimeout", "ConnectTimeout", "HTTPStatusError"])
def test_fallback_logs_safe_failure_category_without_sensitive_payload(caplog, failure):
    def transport(request):
        if failure == "HTTPStatusError":
            return httpx.Response(503, text="secret-response")
        raise getattr(httpx, failure)("secret-exception", request=request)

    primary = RemoteNathanTTSAdapter(SimpleNamespace(
        tts_remote_base_url="http://private-host.invalid", tts_remote_timeout_seconds=2,
    ))
    primary._client.close()
    primary._client = httpx.Client(transport=httpx.MockTransport(transport))
    fallback = Mock()
    fallback.synthesize.return_value = Mock(backend="local")
    adapter = FallbackNathanTTSAdapter(primary, fallback)
    try:
        assert adapter.synthesize("private-child-text").backend == "local"
        assert f"kind={failure}" in caplog.text
        assert "remote_elapsed_s=" in caplog.text
        if failure == "HTTPStatusError":
            assert "status=503" in caplog.text
        for sensitive in ("private-host", "secret-response", "secret-exception", "private-child-text"):
            assert sensitive not in caplog.text
    finally:
        primary.shutdown()


@pytest.mark.parametrize("operation", ["flush_avatar", "discard_avatar", "cue_avatar"])
def test_avatar_controls_do_not_wait_for_synthesis(operation):
    synthesizing = threading.Event()
    release_synthesis = threading.Event()
    control_received = threading.Event()

    def transport(request):
        if request.url.path == "/synthesize":
            assert request.extensions['timeout']['read'] == 12.0
            synthesizing.set()
            if not release_synthesis.wait(5):
                raise AssertionError("test failed to release synthesis")
            return httpx.Response(200, content=b"generated-audio", headers={
                "X-TTS-Duration-S": "1", "Content-Type": "audio/webm",
            })
        assert request.extensions['timeout']['read'] == 2.0
        assert request.extensions['timeout']['connect'] == 1.0
        control_received.set()
        return httpx.Response(200, json={"cued": True})

    adapter = RemoteNathanTTSAdapter(SimpleNamespace(
        tts_remote_base_url="http://test.invalid", tts_remote_timeout_seconds=12,
    ))
    adapter._client.close()
    adapter._client = httpx.Client(timeout=httpx.Timeout(12, connect=2), transport=httpx.MockTransport(transport))
    result = TTSResult(b"audio", 1, 0.1, unavailable_gpu_measurement(),
                       avatar_cue_id="test-single-use-cue")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            synthesis = executor.submit(adapter.synthesize, "下一句话")
            try:
                assert synthesizing.wait(1)
                method = getattr(adapter, operation)
                control = executor.submit(method, *(() if operation == "flush_avatar" else (result,)))
                assert control_received.wait(0.5), "avatar control blocked behind synthesis"
                control.result(timeout=1)
                assert not synthesis.done()
            finally:
                release_synthesis.set()
            synthesis.result(timeout=1)
    finally:
        adapter.shutdown()


@pytest.mark.parametrize("header,expected", [("1.25", 1.25), ("nan", None), ("bad", None), ("-1", None)])
def test_optional_server_timing_cannot_break_speech(header, expected):
    adapter = RemoteNathanTTSAdapter(SimpleNamespace(
        tts_remote_base_url="http://test.invalid", tts_remote_timeout_seconds=2,
    ))
    adapter._client.close()
    adapter._client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(
        200, content=b"audio", headers={"X-TTS-Duration-S": "1", "X-TTS-Elapsed-S": header},
    )))
    try:
        result = adapter.synthesize("hello")
        assert result.audio_bytes == b"audio"
        assert result.server_elapsed_s == expected
    finally:
        adapter.shutdown()
