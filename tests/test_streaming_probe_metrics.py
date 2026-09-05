import pytest

from scripts.benchmark_streaming_tts import summarize_chunks


def test_fast_first_chunk_does_not_hide_later_starvation():
    result = summarize_chunks([(0.2, 0.5), (2.0, 0.5), (3.0, 0.5)], 3.1)
    assert result["first_chunk_s"] == 0.2
    assert result["minimum_extra_start_buffer_s"] == 1.8
    assert result["physical_playback_tested"] is False


def test_continuous_supply_needs_no_extra_buffer():
    result = summarize_chunks([(0.3, 0.7), (0.8, 0.7), (1.2, 0.4)], 1.3)
    assert result["minimum_extra_start_buffer_s"] == 0
    assert result["audio_s"] == 1.8


@pytest.mark.parametrize("chunks", [[], [(0.1, 0)], [(float('nan'), 1)], [(0.5, 1), (0.1, 1)]])
def test_invalid_measurements_fail(chunks):
    with pytest.raises(ValueError):
        summarize_chunks(chunks, 1.0)
