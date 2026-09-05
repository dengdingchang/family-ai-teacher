"""Small NVIDIA VRAM sampler used around local model subprocesses."""

from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable, Generic, TypeVar


T = TypeVar("T")


def _subprocess_kwargs() -> dict:
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


def read_vram_used_mib() -> int | None:
    """Return the first GPU's used MiB, or None when nvidia-smi is unavailable."""

    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3,
            check=True,
            **_subprocess_kwargs(),
        )
        first_line = next(
            (line.strip() for line in completed.stdout.splitlines() if line.strip()),
            "",
        )
        return int(first_line.split()[0]) if first_line else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


@dataclass(frozen=True)
class GpuMeasurement:
    available: bool
    start_mib: int | None
    peak_mib: int | None
    end_mib: int | None
    sample_count: int


def unavailable_gpu_measurement() -> GpuMeasurement:
    """Represent work performed outside the local NVIDIA GPU."""

    return GpuMeasurement(
        available=False,
        start_mib=None,
        peak_mib=None,
        end_mib=None,
        sample_count=0,
    )


class GpuMeter(Generic[T]):
    """Sample VRAM while a synchronous operation is running."""

    def __init__(self, interval_seconds: float = 0.2) -> None:
        self.interval_seconds = interval_seconds

    def run(self, operation: Callable[[], T]) -> tuple[T, GpuMeasurement]:
        values: list[int] = []
        stop = threading.Event()
        start = read_vram_used_mib()

        def sample() -> None:
            while not stop.is_set():
                value = read_vram_used_mib()
                if value is not None:
                    values.append(value)
                stop.wait(self.interval_seconds)

        thread = threading.Thread(target=sample, name="gpu-vram-meter", daemon=True)
        thread.start()
        try:
            result = operation()
        finally:
            stop.set()
            thread.join(timeout=max(1.0, self.interval_seconds * 4))
        end = read_vram_used_mib()
        all_values = [value for value in (start, *values, end) if value is not None]
        measurement = GpuMeasurement(
            available=bool(all_values),
            start_mib=start,
            peak_mib=max(all_values) if all_values else None,
            end_mib=end,
            sample_count=len(all_values),
        )
        return result, measurement


def elapsed_seconds(start: float) -> float:
    return round(time.perf_counter() - start, 3)
