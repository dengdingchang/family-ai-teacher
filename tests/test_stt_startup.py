"""Shared GPU startup ordering without loading any model or family records."""

import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import app.main as main


def test_cuda_recognition_waits_for_voice_warmup(monkeypatch):
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        recognition = Mock()

        async def voice():
            entered.set()
            await release.wait()

        monkeypatch.setattr(main, "settings", SimpleNamespace(stt_device="cuda"))
        monkeypatch.setattr(main, "stt", SimpleNamespace(warmup=recognition))
        monkeypatch.setattr(main, "_warm_up_tts_with_recovery", voice)
        await main.startup_tts_warmup()
        await entered.wait()
        await asyncio.sleep(0)
        recognition.assert_not_called()
        release.set()
        await asyncio.wait_for(main.app.state.stt_warmup_task, 1)
        recognition.assert_called_once_with()

    asyncio.run(scenario())


def test_default_cpu_recognition_can_prepare_while_voice_is_waiting(monkeypatch):
    async def scenario():
        release = asyncio.Event()
        recognition = Mock()

        async def voice():
            await release.wait()

        monkeypatch.setattr(main, "settings", SimpleNamespace())
        monkeypatch.setattr(main, "stt", SimpleNamespace(warmup=recognition))
        monkeypatch.setattr(main, "_warm_up_tts_with_recovery", voice)
        await main.startup_tts_warmup()
        await asyncio.wait_for(main.app.state.stt_warmup_task, 1)
        recognition.assert_called_once_with()
        assert not main.app.state.tts_warmup_task.done()
        release.set()
        await main.app.state.tts_warmup_task

    asyncio.run(scenario())


def test_cancelling_waiting_recognition_does_not_cancel_voice(monkeypatch):
    async def scenario():
        release, entered = asyncio.Event(), asyncio.Event()
        recognition = Mock()

        async def voice():
            entered.set()
            await release.wait()

        monkeypatch.setattr(main, "settings", SimpleNamespace(stt_device="cuda"))
        monkeypatch.setattr(main, "stt", SimpleNamespace(warmup=recognition))
        monkeypatch.setattr(main, "_warm_up_tts_with_recovery", voice)
        await main.startup_tts_warmup()
        await entered.wait()
        await asyncio.sleep(0)
        main.app.state.stt_warmup_task.cancel()
        await asyncio.gather(main.app.state.stt_warmup_task, return_exceptions=True)
        assert not main.app.state.tts_warmup_task.done()
        recognition.assert_not_called()
        release.set()
        await main.app.state.tts_warmup_task

    asyncio.run(scenario())


def test_health_reports_actual_cpu_fallback_separately_from_paths(monkeypatch):
    status = {"backend": "faster-whisper", "device": "cpu", "compute_type": "int8_float32",
              "fallback_reason": "cuda_start_failed"}
    monkeypatch.setattr(main, "stt", SimpleNamespace(ready=True, runtime_status=status))
    value = asyncio.run(main.health())
    assert value["stt_ready"] is True
    assert value["stt_runtime"] == status


def test_cuda_kernels_prime_from_existing_cached_ack_without_conversation(monkeypatch):
    async def scenario():
        order = []
        recognition = SimpleNamespace(
            warmup=Mock(side_effect=lambda: order.append("stt_ready")),
            runtime_status={"device": "cuda"}, transcribe_bytes=Mock(),
        )
        voice = SimpleNamespace(
            is_cached=Mock(return_value=True),
            synthesize=Mock(return_value=SimpleNamespace(audio_bytes=b"cached-synthetic-wave")),
        )

        async def prepare_voice():
            order.append("tts_ready")

        monkeypatch.setattr(main, "settings", SimpleNamespace(stt_device="cuda", tts_mode="streaming"))
        monkeypatch.setattr(main, "stt", recognition)
        monkeypatch.setattr(main, "tts", voice)
        monkeypatch.setattr(main, "_warm_up_tts_with_recovery", prepare_voice)
        await main.startup_tts_warmup()
        await main.app.state.stt_warmup_task
        assert order == ["tts_ready", "stt_ready"]
        voice.is_cached.assert_called_once_with(main.ACKNOWLEDGEMENT_TEXT)
        voice.synthesize.assert_called_once_with(main.ACKNOWLEDGEMENT_TEXT, defer_avatar=True)
        recognition.transcribe_bytes.assert_called_once_with(b"cached-synthetic-wave")

    asyncio.run(scenario())


def test_historical_voice_warmup_does_not_admit_cuda_after_worker_exit(monkeypatch):
    monkeypatch.setattr(main.app.state, "tts_warmup", "ready")
    monkeypatch.setattr(main, "settings", SimpleNamespace(tts_mode="streaming"))
    monkeypatch.setattr(main, "tts", SimpleNamespace(worker_ready=True))
    assert main._cuda_stt_start_allowed() is True
    main.tts.worker_ready = False
    assert main._cuda_stt_start_allowed() is False
