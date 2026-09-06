"""Exercise the installed wrapper functions without loading a renderer/model."""

import ast
import asyncio
import base64
import json
import queue
import threading
from pathlib import Path
from types import SimpleNamespace

import numpy as np

import avatar.remote_soulx_runner as runner


def wrapper_function(name, **bindings):
    tree = ast.parse(Path(runner.__file__).read_text(encoding="utf-8"))
    outer = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_run_soulx_server")
    function = next(node for node in outer.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name)
    namespace = {**vars(runner), **bindings}
    exec(compile(ast.Module(body=[function], type_ignores=[]), runner.__file__, "exec"), namespace)
    return namespace[name]


class TimedQueue:
    def __init__(self, items):
        self.items = list(items)
        self.now = 0.0

    def get(self, timeout):
        if self.items and self.items[0][0] <= self.now + timeout:
            at, value = self.items.pop(0)
            self.now = max(self.now, at)
            return value
        self.now += timeout
        assert self.now < 5, "unexpected unbounded wait in the test"
        raise queue.Empty

    def empty(self):
        return not self.items or self.items[0][0] > self.now

    def put_nowait(self, value):
        self.items.append((self.now, value))
        self.items.sort(key=lambda item: item[0])


def engine(items, *, streaming=True):
    return SimpleNamespace(
        chunk_samples=15360, audio_q=TimedQueue(items),
        _flushed=threading.Event(), _stop=threading.Event(),
        _family_tail_emit_lock=threading.Lock(),
        _family_streaming=streaming, _family_stream_ended=False,
    )


def test_normal_stream_gaps_do_not_insert_silence_into_lip_sync_pcm():
    chunks = [np.full(10240, value, dtype=np.float32) for value in (1, 2, 3)]
    state = engine(zip((0, 0.26, 0.52), chunks))
    next_chunk = wrapper_function("speech_only_next_chunk")
    pending = np.zeros(0, dtype=np.float32)
    pending, first = next_chunk(state, pending)
    pending, second = next_chunk(state, pending)
    assert np.array_equal(np.concatenate([first, second]), np.concatenate(chunks))
    assert not len(pending)


def test_short_stream_waits_for_end_and_only_pads_its_tail():
    speech = np.ones(5120, dtype=np.float32)
    state = engine([(0, speech), (0.46, runner._AUDIO_STREAM_END)])
    pending, chunk = wrapper_function("speech_only_next_chunk")(state, np.zeros(0, dtype=np.float32))
    assert state.audio_q.now == 0.46
    assert np.array_equal(chunk[:5120], speech)
    assert np.count_nonzero(chunk[5120:]) == 0
    assert len(chunk) == state.chunk_samples
    assert not len(pending)
    assert not state._family_streaming


def test_empty_or_exact_end_does_not_generate_an_extra_silent_chunk():
    for pending in (np.zeros(0, dtype=np.float32), np.ones(15360, dtype=np.float32)):
        state = engine([(0, runner._AUDIO_STREAM_END)])
        next_chunk = wrapper_function("speech_only_next_chunk")
        remaining, chunk = next_chunk(state, pending)
        if len(pending):
            assert np.array_equal(chunk, pending)
            remaining, chunk = next_chunk(state, remaining)
        assert chunk is None
        assert not len(remaining)
        assert not state._family_streaming


def test_end_wakes_waiter_without_discarding_pcm_when_queue_is_full():
    end_stream = wrapper_function("end_audio_stream")
    state = engine([])
    state.audio_q = queue.Queue(maxsize=1)
    speech = np.ones(5120, dtype=np.float32)
    state.audio_q.put_nowait(speech)
    end_stream(state)
    assert state.audio_q.qsize() == 1
    _, chunk = wrapper_function("speech_only_next_chunk")(state, np.zeros(0, dtype=np.float32))
    assert np.array_equal(chunk[:5120], speech)
    assert not np.count_nonzero(chunk[5120:])
    state._family_streaming = True
    end_stream(state)
    assert state.audio_q.get_nowait() is runner._AUDIO_STREAM_END
    end_stream(state)
    assert state.audio_q.empty()


def test_cancel_and_stop_leave_no_padded_streaming_chunk():
    next_chunk = wrapper_function("speech_only_next_chunk")
    pending = np.ones(5120, dtype=np.float32)
    state = engine([])
    state._flushed.set()
    remaining, chunk = next_chunk(state, pending)
    assert chunk is None and not len(remaining)
    state = engine([])
    state._stop = SimpleNamespace(is_set=lambda: state.audio_q.now >= 0.4)
    _, chunk = next_chunk(state, pending)
    assert chunk is None
    assert state.audio_q.now == 0.4


def test_flush_during_wait_preserves_new_turn_pcm_but_discards_old_pending():
    state = engine([])
    new_speech = np.full(10240, 2, dtype=np.float32)
    state._family_h264_encoder = SimpleNamespace(reset=lambda: None)
    flush = wrapper_function("interruptible_flush", original_flush=lambda value: value._flushed.set())
    begin = wrapper_function("begin_audio_stream")
    def interrupted_get(timeout):
        flush(state)
        begin(state)
        return new_speech
    state.audio_q.get = interrupted_get
    pending, chunk = wrapper_function("speech_only_next_chunk")(state, np.ones(5120, dtype=np.float32))
    assert chunk is None and not len(pending)
    assert state._family_streaming and not state._family_stream_ended
    assert len(state.audio_q.items) == 1
    assert np.array_equal(state.audio_q.items[0][1], new_speech)


def test_flush_resets_stream_state_and_new_begin_does_not_reuse_the_end():
    state = engine([])
    state._family_stream_ended = True
    calls = []
    state._family_h264_encoder = SimpleNamespace(reset=lambda: calls.append("codec_reset"))
    flush = wrapper_function("interruptible_flush", original_flush=lambda value: value._flushed.set())
    flush(state)
    assert not state._family_streaming and not state._family_stream_ended
    assert state._flushed.is_set()
    assert calls == ["codec_reset"]
    wrapper_function("begin_audio_stream")(state)
    assert state._family_streaming and not state._family_stream_ended


def test_legacy_full_utterance_and_warmup_remain_compatible():
    next_chunk = wrapper_function("speech_only_next_chunk")
    speech = np.ones(10240, dtype=np.float32)
    legacy = engine([(0, speech)], streaming=False)
    _, chunk = next_chunk(legacy, np.zeros(0, dtype=np.float32))
    assert np.array_equal(chunk[:10240], speech)
    assert not np.count_nonzero(chunk[10240:])
    warmup = engine([(0, np.zeros(15360, dtype=np.float32))], streaming=False)
    _, chunk = next_chunk(warmup, np.zeros(0, dtype=np.float32))
    assert len(chunk) == 15360 and not np.count_nonzero(chunk)
    assert warmup.audio_q.now == 0


def test_websocket_protocol_keeps_pcm_and_control_event_order():
    calls = []
    class Socket:
        def __init__(self):
            self.sent = []
        async def send(self, message):
            self.sent.append(json.loads(message))
        def __aiter__(self):
            async def messages():
                yield '{invalid json'
                yield b'ignored binary control'
                for message in [
                    {"type": "flush"}, {"type": "audio_begin"},
                    {"type": "audio", "pcm": base64.b64encode(b"synthetic").decode()},
                    {"type": "audio_end"}, {"type": "ping"},
                ]:
                    yield json.dumps(message)
            return messages()
    state = SimpleNamespace(
        fps=25, chunk_seconds=0.96,
        flush=lambda: calls.append("flush"),
        begin_audio_stream=lambda: calls.append("begin"),
        feed=lambda pcm: calls.append(pcm),
        end_audio_stream=lambda: calls.append("end"),
    )
    server = SimpleNamespace(engine=state, clients=set())
    socket = Socket()
    asyncio.run(wrapper_function("streaming_handler")(server, socket))
    assert calls == ["flush", "begin", b"synthetic", "end"]
    assert socket.sent == [
        {"type": "ready", "fps": 25, "chunk_seconds": 0.96, "audio_stream_protocol": True},
        {"type": "flushed"}, {"type": "pong"},
    ]
    assert not server.clients
