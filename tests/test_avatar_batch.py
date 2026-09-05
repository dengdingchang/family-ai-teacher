import struct
import threading
from types import SimpleNamespace

from avatar.remote_soulx_runner import _H264BatchEncoder


class Packet:
    def __init__(self, frame):
        self.pts = frame.pts
        self.is_keyframe = frame.pts == 0

    def __bytes__(self):
        return b"encoded"


def encoder():
    value = _H264BatchEncoder.__new__(_H264BatchEncoder)
    value._av = SimpleNamespace(VideoFrame=SimpleNamespace(from_ndarray=lambda *a, **k: SimpleNamespace()))
    value._batch_size = 5
    value._frame_index = 0
    value._pending = []
    value._lock = threading.Lock()
    value._create_codec = lambda: SimpleNamespace(encode=lambda frame: [Packet(frame)])
    value._codec = value._create_codec()
    return value


def test_first_keyframe_is_immediate_after_each_reset():
    value = encoder()
    for _ in range(3):
        packet = value.push(None)
        assert packet.startswith(b"FATV1\x01")
        assert struct.unpack('>BQI', packet[6:19]) == (1, 0, 7)
        value.reset()


def test_delta_frames_keep_batching_without_loss():
    value = encoder()
    value.push(None)
    for _ in range(4):
        assert value.push(None) == b""
    packet = value.push(None)
    assert packet.startswith(b"FATV1\x05")
    assert len(packet) == 6 + 5 * (13 + 7)
    assert not value._pending
