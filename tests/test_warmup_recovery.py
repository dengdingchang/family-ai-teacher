"""Background startup recovery is bounded and never becomes a model load loop."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

import app.main as main
from tts.adapter import TTSAdapterError


@pytest.mark.parametrize("failures,expected_calls,expected_delays,final", [
    (0, 1, [], "ready"),
    (1, 2, [30], "ready"),
    (3, 3, [30, 60], "failed"),
])
def test_bounded_remote_recovery(monkeypatch, failures, expected_calls, expected_delays, final):
    adapter = Mock(ready=True)
    adapter.prewarm.side_effect = [TTSAdapterError("private text")]*failures + [None]
    monkeypatch.setattr(main, "tts", adapter)
    monkeypatch.setattr(main, "settings", SimpleNamespace(tts_mode="remote_preferred"))
    monkeypatch.setattr(main, "memory", Mock(get_child_profile=lambda: {"name": "测试"}))
    sleep = AsyncMock()
    monkeypatch.setattr(main.asyncio, "sleep", sleep)
    asyncio.run(main._warm_up_tts_with_recovery())
    assert adapter.prewarm.call_count == expected_calls
    assert [call.args[0] for call in sleep.call_args_list] == expected_delays
    assert main.app.state.tts_warmup == final
    adapter.synthesize.assert_not_called()


def test_cancel_during_backoff_starts_no_retry(monkeypatch):
    adapter = Mock(ready=True)
    adapter.prewarm.side_effect = TTSAdapterError("offline")
    monkeypatch.setattr(main, "tts", adapter)
    monkeypatch.setattr(main, "settings", SimpleNamespace(tts_mode="remote_preferred"))
    monkeypatch.setattr(main, "memory", Mock(get_child_profile=lambda: {}))
    monkeypatch.setattr(main.asyncio, "sleep", AsyncMock(side_effect=asyncio.CancelledError))
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._warm_up_tts_with_recovery())
    assert adapter.prewarm.call_count == 1


def test_non_remote_warmup_not_retried_and_logs_no_private_text(monkeypatch, caplog):
    adapter = Mock(ready=True)
    adapter.prewarm.side_effect = TTSAdapterError("private text or endpoint")
    monkeypatch.setattr(main, "tts", adapter)
    monkeypatch.setattr(main, "settings", SimpleNamespace(tts_mode="subprocess"))
    sleep = AsyncMock()
    monkeypatch.setattr(main.asyncio, "sleep", sleep)
    asyncio.run(main._warm_up_tts_with_recovery())
    sleep.assert_not_called()
    assert adapter.prewarm.call_count == 1
    assert "private text" not in caplog.text
    assert "kind=TTSAdapterError" in caplog.text
