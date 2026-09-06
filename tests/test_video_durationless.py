"""Exercise unknown-duration browser-style WebM without raw camera media."""
from pathlib import Path
import subprocess

import pytest

from camera.adapter import BrowserCameraAdapter, CameraAdapterError


def run_harness(monkeypatch, metadata="N/A\n", packets="0.000,0.066\n0.533,0.067\n1.067,0.067\n"):
    calls, temporary_paths = [], []
    monkeypatch.setattr('camera.adapter.shutil.which', lambda name: name)

    def run(command, **kwargs):
        calls.append((command, kwargs))
        if command[0] == 'ffprobe':
            temporary_paths.append(Path(command[-1]))
            assert temporary_paths[-1].is_file()
            output = packets if any('packet=' in str(arg) for arg in command) else metadata
            return subprocess.CompletedProcess(command, 0, stdout=output, stderr='')
        timestamp = command[command.index('-ss') + 1]
        return subprocess.CompletedProcess(command, 0, stdout=b'\xff\xd8\xff' + timestamp.encode(), stderr=b'')

    monkeypatch.setattr('camera.adapter.subprocess.run', run)
    frames = BrowserCameraAdapter().extract_video_keyframes(b'synthetic test bytes', 'synthetic.webm')
    return frames, calls, temporary_paths


def test_missing_duration_uses_packet_timestamps_to_sample_start_middle_and_end(monkeypatch):
    frames, calls, temporary_paths = run_harness(monkeypatch)
    assert len(frames) == 3
    assert len(set(frames)) == 3
    times = [float(command[command.index('-ss') + 1]) for command, _ in calls if command[0] == 'ffmpeg']
    assert times == pytest.approx([0, .567, .934], abs=.001)
    assert all(options['timeout'] <= 12 for _, options in calls)
    assert all(not path.exists() for path in temporary_paths)


def test_known_duration_still_uses_the_existing_three_positions(monkeypatch):
    frames, calls, paths = run_harness(monkeypatch, metadata='6.0\n')
    assert len(frames) == 3
    assert [float(command[command.index('-ss') + 1]) for command, _ in calls if command[0] == 'ffmpeg'] == [0, 3, 5.8]
    assert sum(command[0] == 'ffprobe' for command, _ in calls) == 1
    assert all(not path.exists() for path in paths)


def test_invalid_packet_timestamps_keep_the_safe_first_frame_fallback(monkeypatch):
    frames, _, paths = run_harness(monkeypatch, packets='N/A,N/A\nnan,inf\nbad\n')
    assert len(frames) == 1
    assert all(not path.exists() for path in paths)


def test_invalid_video_is_reported_and_temporary_input_is_removed(monkeypatch):
    paths = []
    monkeypatch.setattr('camera.adapter.shutil.which', lambda name: name)
    def fail(command, **options):
        if command[0] == 'ffprobe': paths.append(Path(command[-1]))
        raise subprocess.CalledProcessError(1, command)
    monkeypatch.setattr('camera.adapter.subprocess.run', fail)
    with pytest.raises(CameraAdapterError, match='could not extract a frame'):
        BrowserCameraAdapter().extract_video_keyframes(b'invalid synthetic bytes', 'synthetic.webm')
    assert paths and all(not path.exists() for path in paths)
