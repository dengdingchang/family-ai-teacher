"""Isolated faster-whisper worker run by the existing embedded Python 3.10."""

from __future__ import annotations

import argparse
import json
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    load_started = time.perf_counter()
    model = WhisperModel(args.model, device="cpu", compute_type=args.compute_type)
    load_s = time.perf_counter() - load_started
    transcribe_started = time.perf_counter()
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        beam_size=3,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = "".join(segment.text for segment in segments).strip()
    transcribe_s = time.perf_counter() - transcribe_started
    print(
        json.dumps(
            {
                "text": text,
                "language": info.language,
                "duration_s": round(float(info.duration), 3),
                "load_s": round(load_s, 3),
                "transcribe_s": round(transcribe_s, 3),
            },
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
