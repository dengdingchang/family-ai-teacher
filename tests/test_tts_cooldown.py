import threading
from unittest.mock import Mock, patch

import pytest

from tts.adapter import TTSAdapterError
from tts.remote import FallbackNathanTTSAdapter


def setup():
    primary, local = Mock(), Mock()
    primary.synthesize.side_effect = TTSAdapterError("remote failed")
    local.synthesize.return_value = Mock(backend="local")
    return primary, local, FallbackNathanTTSAdapter(primary, local)


def test_successful_fallback_skips_remote_until_cooldown_expires_then_recovers():
    primary, local, adapter = setup()
    with patch('tts.remote.time.monotonic', return_value=100):
        adapter.synthesize('first')
        adapter.synthesize('second')
        adapter._audio_cache['cached'] = Mock(backend='self-host-cache')
        adapter.synthesize('cached')
    assert primary.synthesize.call_count == 1
    assert local.synthesize.call_count == 2
    primary.synthesize.side_effect = None
    primary.synthesize.return_value = Mock(backend='self-host')
    with patch('tts.remote.time.monotonic', return_value=131):
        assert adapter.synthesize('third').backend == 'self-host'
    local.shutdown.assert_called_once()
    assert adapter._remote_retry_after == 0
    assert adapter.last_remote_error == ''


def test_failed_fallback_does_not_suppress_remote_retry():
    primary, local, adapter = setup()
    local.synthesize.side_effect = TTSAdapterError('local failed')
    for _ in range(2):
        with pytest.raises(TTSAdapterError):
            adapter.synthesize('test')
    assert primary.synthesize.call_count == 2


def test_cooldown_fallback_failure_reopens_remote_and_cancellation_starts_nothing():
    primary, local, adapter = setup()
    adapter.synthesize('first')
    stop = threading.Event()
    stop.set()
    with pytest.raises(TTSAdapterError, match='cancelled'):
        adapter.synthesize('cancelled', cancel_event=stop)
    assert local.synthesize.call_count == 1
    local.synthesize.side_effect = TTSAdapterError('local failed')
    with pytest.raises(TTSAdapterError):
        adapter.synthesize('next')
    assert adapter._remote_retry_after == 0


@pytest.mark.parametrize('value', [-1, 301, float('nan'), float('inf')])
def test_invalid_cooldown_is_rejected(value):
    with pytest.raises(ValueError):
        FallbackNathanTTSAdapter(Mock(), Mock(), retry_cooldown_seconds=value)
