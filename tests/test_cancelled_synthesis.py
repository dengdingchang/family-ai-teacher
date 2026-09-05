"""Abandoned turns must not spend resources on fallback or queued synthesis."""

import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

from tts.adapter import TTSAdapterError
from tts.adapter import TTSResult
from audio.metrics import unavailable_gpu_measurement
from tts.remote import FallbackNathanTTSAdapter


def test_cancelled_remote_failure_never_loads_local_fallback():
    stop = threading.Event()
    primary, fallback = Mock(), Mock()

    def fail(*args, **kwargs):
        stop.set()
        raise TTSAdapterError("remote timeout")

    primary.synthesize.side_effect = fail
    adapter = FallbackNathanTTSAdapter(primary, fallback)
    with pytest.raises(TTSAdapterError, match="cancelled"):
        adapter.synthesize_cancellable("old reply", cancel_event=stop)
    fallback.synthesize.assert_not_called()
    assert adapter.last_backend == "not_started"


def test_cancelled_waiter_exits_while_another_synthesis_still_holds_slot():
    primary, fallback = Mock(), Mock()
    adapter = FallbackNathanTTSAdapter(primary, fallback)
    stop = threading.Event()
    entered = threading.Event()

    def waiting_turn():
        entered.set()
        return adapter.synthesize_cancellable("old reply", cancel_event=stop)

    with ThreadPoolExecutor(max_workers=1) as executor:
        with adapter._lock:
            future = executor.submit(waiting_turn)
            assert entered.wait(1)
            stop.set()
            with pytest.raises(TTSAdapterError, match="cancelled"):
                future.result(timeout=1)
    primary.synthesize.assert_not_called()
    fallback.synthesize.assert_not_called()


def test_cached_play_does_not_hide_local_model_cleanup():
    primary, fallback = Mock(), Mock()
    primary.synthesize.side_effect = [TTSAdapterError("offline"), Mock(backend="self-host")]
    fallback.synthesize.return_value = Mock(backend="local")
    adapter = FallbackNathanTTSAdapter(primary, fallback, retry_cooldown_seconds=0)
    adapter.synthesize("first")
    adapter._audio_cache["hello"] = Mock(backend="self-host-cache")
    adapter.synthesize("hello")
    adapter.synthesize("second")
    fallback.shutdown.assert_called_once()


def test_cancelled_cached_turn_does_not_return_audio():
    adapter = FallbackNathanTTSAdapter(Mock(), Mock())
    adapter._audio_cache["hello"] = Mock(backend="self-host-cache")
    stop = threading.Event()
    stop.set()
    with pytest.raises(TTSAdapterError, match="cancelled"):
        adapter.synthesize_cancellable("hello", cancel_event=stop)
    adapter.primary.synthesize.assert_not_called()
    adapter.fallback.synthesize.assert_not_called()


def test_live_turn_still_uses_local_fallback_on_remote_failure():
    primary, fallback = Mock(), Mock()
    primary.synthesize.side_effect = TTSAdapterError("remote timeout")
    fallback.synthesize.return_value = Mock(backend="local")
    adapter = FallbackNathanTTSAdapter(primary, fallback)
    result = adapter.synthesize_cancellable("current reply", cancel_event=threading.Event())
    assert result.backend == "local"
    fallback.synthesize.assert_called_once()


def test_pre_cancelled_turn_never_starts_remote_inference():
    primary, fallback = Mock(), Mock()
    adapter = FallbackNathanTTSAdapter(primary, fallback)
    stop = threading.Event()
    stop.set()
    with pytest.raises(TTSAdapterError, match="cancelled"):
        adapter.synthesize_cancellable("old reply", cancel_event=stop)
    primary.synthesize.assert_not_called()
    fallback.synthesize.assert_not_called()


@pytest.mark.parametrize("operation", ["lookup", "count", "play"])
def test_cached_operations_do_not_wait_for_inference_slot(operation):
    primary, fallback = Mock(), Mock()
    adapter = FallbackNathanTTSAdapter(primary, fallback)
    cached = TTSResult(b"audio", 1, 0, unavailable_gpu_measurement(), backend="self-host-cache")
    adapter._audio_cache["hello"] = cached
    calls = {"lookup": lambda: adapter.is_cached("hello"),
             "count": lambda: adapter.cache_entries,
             "play": lambda: adapter.synthesize("hello")}
    with ThreadPoolExecutor(max_workers=1) as executor:
        with adapter._lock:
            future = executor.submit(calls[operation])
            result = future.result(timeout=0.5)
    assert result == {"lookup": True, "count": 1, "play": cached}[operation]
    primary.synthesize.assert_not_called()
