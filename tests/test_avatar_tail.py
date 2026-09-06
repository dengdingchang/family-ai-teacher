"""Drain only encoded tails; exercise the real emit loop with a numeric clock."""

import ast
from pathlib import Path
import queue
import struct
import threading
from types import SimpleNamespace

import pytest

import avatar.remote_soulx_runner as runner
from test_avatar_batch import encoder


def wrapper_function(name, **bindings):
    tree = ast.parse(Path(runner.__file__).read_text(encoding="utf-8"))
    outer = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_run_soulx_server")
    function = next(node for node in outer.body if isinstance(node, ast.FunctionDef) and node.name == name)
    namespace = {**vars(runner), **bindings}
    exec(compile(ast.Module(body=[function], type_ignores=[]), runner.__file__, "exec"), namespace)
    return namespace[name]


def packet_frames(packets):
    frames = []
    for payload in packets:
        assert payload.startswith(b"FATV1")
        offset = 6
        for _ in range(payload[5]):
            key, timestamp, length = struct.unpack_from(">BQI", payload, offset)
            offset += 13
            frames.append((bool(key), timestamp, payload[offset:offset + length]))
            offset += length
        assert offset == len(payload)
    return frames


def emit_harness(groups, after_frame=None):
    value = encoder()
    packets = []
    clock = SimpleNamespace(now=0.0)
    stop = SimpleNamespace(stopped=False)
    stop.is_set = lambda: stop.stopped
    def wait(delay):
        clock.now += delay
        return stop.stopped
    stop.wait = wait
    state = SimpleNamespace(
        fps=25, _stop=stop, _flushed=threading.Event(), _flush_seq=0,
        _family_h264_encoder=value, _family_tail_emit_lock=threading.Lock(),
    )
    remaining = list(groups)
    def get(timeout):
        if remaining:
            return remaining.pop(0)
        stop.stopped = True
        raise queue.Empty
    state.emit_q = SimpleNamespace(get=get)
    def encode(frame):
        assert not state._family_tail_emit_lock.locked(), "CPU encoding must stay outside the tail lock"
        return value.push(frame)
    state._to_jpeg = encode
    def send(payload):
        if payload:
            packets.append(payload)
        if after_frame and not state._family_tail_emit_lock.locked():
            after_frame(state, value._frame_index)
    state.on_frames = send
    run = wrapper_function("interruptible_emit_loop", time=SimpleNamespace(perf_counter=lambda: clock.now))
    return state, value, packets, lambda: run(state)


def test_each_completed_render_group_sends_its_tail_with_continuous_pts():
    _, value, packets, run = emit_harness([[None] * 24, [None] * 24])
    run()
    frames = packet_frames(packets)
    assert len(frames) == 48
    assert [frame[1] for frame in frames] == list(range(0, 48 * 40000, 40000))
    assert packets[0][5] == 1 and frames[0][0]
    assert not value._pending


def test_draining_is_idempotent_and_does_not_encode_reset_or_advance_pts():
    value = encoder()
    codec = value._codec
    calls = []
    original_encode = codec.encode
    codec.encode = lambda frame: calls.append(frame.pts) or original_encode(frame)
    packets = [value.push(None)]
    assert value.push(None) == b""
    packets.append(value.drain_pending())
    assert calls == [0, 1]
    assert value._frame_index == 2 and value._codec is codec
    assert value.drain_pending() == b""
    assert value.push(None) == b""
    packets.append(value.drain_pending())
    assert calls == [0, 1, 2]
    assert [frame[1] for frame in packet_frames(packets)] == [0, 40000, 80000]


@pytest.mark.parametrize("frame_count,action", [(2, "flush"), (4, "flush"), (4, "stop")])
def test_cancelled_or_stopped_groups_do_not_send_a_tail(frame_count, action):
    state, value, packets, run = emit_harness([[None] * 4])
    original_send = state.on_frames
    def original_flush(target):
        assert target._family_tail_emit_lock.locked()
        target._flush_seq += 1
        target._flushed.set()
    flush = wrapper_function("interruptible_flush", original_flush=original_flush)
    original_reset = value.reset
    def reset():
        assert not state._family_tail_emit_lock.locked()
        original_reset()
    value.reset = reset
    def send(payload):
        original_send(payload)
        if value._frame_index == frame_count:
            if action == "flush":
                flush(state)
            else:
                state._stop.stopped = True
    state.on_frames = send
    run()
    assert [frame[1] for frame in packet_frames(packets)] == [0]


def test_flush_cannot_change_generation_between_tail_check_and_send():
    state, value, _, run = emit_harness([[None] * 4])
    drain_entered = threading.Event()
    allow_drain = threading.Event()
    flush_requested = threading.Event()
    flushed = threading.Event()
    events = []
    errors = []
    original_drain = value.drain_pending
    def drain():
        drain_entered.set()
        assert allow_drain.wait(1)
        return original_drain()
    value.drain_pending = drain
    original_send = state.on_frames
    def send(payload):
        if payload and state._family_tail_emit_lock.locked():
            events.append("tail")
        original_send(payload)
    state.on_frames = send
    def original_flush(target):
        events.append("flush")
        target._flush_seq += 1
        target._flushed.set()
        flushed.set()
    flush = wrapper_function("interruptible_flush", original_flush=original_flush)
    def cancel():
        flush_requested.set()
        flush(state)
    def checked(action):
        try:
            action()
        except BaseException as exc:
            errors.append(exc)
    emitter = threading.Thread(target=lambda: checked(run))
    canceller = threading.Thread(target=lambda: checked(cancel))
    emitter.start()
    try:
        assert drain_entered.wait(1)
        canceller.start()
        assert flush_requested.wait(1)
        assert not flushed.wait(0.03)
    finally:
        allow_drain.set()
        emitter.join(1)
        if canceller.ident is not None:
            canceller.join(1)
    assert not emitter.is_alive() and not canceller.is_alive()
    assert not errors
    assert events == ["tail", "flush"]


def test_real_cpu_h264_tail_decodes_and_the_same_codec_accepts_the_next_frame():
    av = pytest.importorskip("av")
    np = pytest.importorskip("numpy")
    value = runner._H264BatchEncoder()
    image = np.full((512, 512, 3), 128, dtype=np.uint8)
    packets = []
    for _ in range(2):
        for _ in range(24):
            packet = value.push(image)
            if packet:
                packets.append(packet)
        packets.append(value.drain_pending())
    frames = packet_frames(packets)
    assert [frame[1] for frame in frames] == list(range(0, 48 * 40000, 40000))
    decoder = av.CodecContext.create("h264", "r")
    assert sum(len(decoder.decode(av.Packet(data))) for _, _, data in frames) == 48
    packets = [packet for packet in (value.push(image), value.drain_pending()) if packet]
    following = packet_frames(packets)
    assert [frame[1] for frame in following] == [1920000]
    assert sum(len(decoder.decode(av.Packet(data))) for _, _, data in following) == 1
