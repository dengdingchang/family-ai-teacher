"""Persistent CPU speech recognition with in-memory request/result transport."""

from __future__ import annotations

import argparse
import base64
import contextlib
import io
import json
import queue
import sys
import threading
import time


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        from faster_whisper import WhisperModel
        model = WhisperModel(args.model, device="cpu", compute_type=args.compute_type,
                             cpu_threads=4, local_files_only=True)

    requests: queue.Queue = queue.Queue()
    cancellation: dict[str, threading.Event] = {}
    control_lock = threading.Lock()

    def read_commands() -> None:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                request_id = str(request.get("id", ""))
                with control_lock:
                    if request.get("command") == "cancel":
                        event = cancellation.get(request_id)
                        if event is not None:
                            event.set()
                        continue
                    cancellation[request_id] = threading.Event()
                requests.put(request)
                line = ""
            except (ValueError, TypeError):
                requests.put({"id": "", "invalid": True})
        with control_lock:
            for event in cancellation.values():
                event.set()
        requests.put(None)

    threading.Thread(target=read_commands, name="stt-controls", daemon=True).start()
    emit({"event": "ready", "load_s": round(time.perf_counter() - started, 3)})
    while True:
        request = requests.get()
        if request is None or request.get("command") == "shutdown":
            emit({"event": "shutdown", "id": request.get("id", "") if request else ""})
            return 0
        request_id = str(request.get("id", ""))
        stop = cancellation.get(request_id, threading.Event())
        segments = None
        source = None
        audio = b""
        encoded = ""
        text_parts = []
        try:
            encoded = request.get("audio_base64", "")
            if not isinstance(encoded, str) or len(encoded) > 23 * 1024 * 1024:
                raise ValueError("Invalid audio payload")
            audio = base64.b64decode(encoded, validate=True)
            if not audio or len(audio) > 16 * 1024 * 1024:
                raise ValueError("Invalid audio payload")
            if stop.is_set():
                emit({"event": "cancelled", "id": request_id})
                continue
            source = io.BytesIO(audio)
            started = time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr):
                segments, info = model.transcribe(
                    source, language=args.language, beam_size=3, vad_filter=True,
                    condition_on_previous_text=False,
                )
                text_parts = []
                for segment in segments:
                    if stop.is_set():
                        break
                    text_parts.append(segment.text)
            if stop.is_set():
                emit({"event": "cancelled", "id": request_id})
            else:
                emit({"event": "transcript", "id": request_id,
                      "text": "".join(text_parts).strip(), "language": info.language,
                      "duration_s": round(float(info.duration), 3),
                      "transcribe_s": round(time.perf_counter() - started, 3)})
        except Exception as exc:
            # Decoder exception messages can contain media paths or transcript
            # fragments. Only an exception class crosses the protocol boundary.
            emit({"event": "error", "id": request_id, "error": type(exc).__name__})
        finally:
            if segments is not None:
                close = getattr(segments, "close", None)
                if close is not None:
                    close()
            if source is not None:
                source.close()
            audio = b""
            encoded = ""
            text_parts.clear()
            request.clear()
            with control_lock:
                cancellation.pop(request_id, None)


if __name__ == "__main__":
    raise SystemExit(main())
