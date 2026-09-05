import json
import threading
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from tts.remote_server import NathanEngine


def test_server_stage_timing_excludes_text_and_media(capsys):
    engine = NathanEngine.__new__(NathanEngine)
    engine._lock = threading.RLock()
    engine._torch = SimpleNamespace(inference_mode=nullcontext)
    engine.model = Mock()
    engine.model.generate_voice_clone.return_value = ([np.zeros(16000)], 16000)
    engine.language = "Chinese"
    engine.voice_prompt = "private-voice"
    engine._pcm16_16k = Mock(return_value=b"private-pcm")
    engine._store_avatar = Mock(return_value="private-cue")
    engine._encode_opus = Mock(return_value=b"private-opus")
    with patch('tts.remote_server.time.perf_counter', side_effect=[10, 11, 13, 13.5, 14]):
        result = engine.synthesize("private-child-text", defer_avatar=True)
    output = capsys.readouterr().out
    timing = json.loads(output)
    assert timing == dict(event="tts_timing", queue_s=1, generation_s=2,
                          avatar_prepare_s=.5, encode_s=.5, total_s=4, audio_duration_s=1)
    assert "private" not in output
    assert result == (b"private-opus", 1, 4, False, "private-cue")
