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
    def raw_frame(*args, **kwargs):
        frame = SimpleNamespace()
        frame.reformat = lambda **options: frame
        return frame
    value._av = SimpleNamespace(VideoFrame=SimpleNamespace(from_ndarray=raw_frame))
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


def test_h264_declares_its_actual_rgb_to_yuv_conversion():
    import pytest

    av = pytest.importorskip("av")
    np = pytest.importorskip("numpy")
    colors = np.array([
        [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255],
        [0, 0, 0], [128, 128, 128], [212, 163, 132], [81, 51, 31],
    ], dtype=np.uint8)
    image = np.zeros((512, 512, 3), dtype=np.uint8)
    for index, color in enumerate(colors):
        row, column = divmod(index, 4)
        image[row * 256:(row + 1) * 256, column * 128:(column + 1) * 128] = color
    payload = _H264BatchEncoder().push(image)
    key, timestamp, length = struct.unpack(">BQI", payload[6:19])
    assert (key, timestamp) == (1, 0)
    frame = av.CodecContext.create("h264", "r").decode(av.Packet(payload[19:19 + length]))[0]
    # Limited-range BT.709 matrix/primaries, with the source RGB's sRGB transfer.
    assert (frame.color_range, frame.colorspace, frame.color_primaries, frame.color_trc) == (1, 1, 1, 13)
    luma = np.frombuffer(frame.planes[0], dtype=np.uint8).reshape(frame.planes[0].height, frame.planes[0].line_size)
    assert luma[100, 434] == 235  # white: actual limited-range pixels
    assert luma[356, 50] == 16  # black
    decoded = frame.to_ndarray(format="rgb24")
    for index, color in enumerate(colors):
        row, column = divmod(index, 4)
        actual = decoded[row * 256 + 100, column * 128 + 50].astype(int)
        assert np.max(np.abs(actual - color.astype(int))) <= 5
