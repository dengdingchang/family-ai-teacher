"""Long-lived worker for the already audited Nathan Qwen3-TTS runtime.

The parent process talks JSONL over stdin/stdout. Audio is returned as base64
WAV bytes and is never written to the project or a persistent media folder.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import io
import json
import sys
import traceback
from pathlib import Path


def _emit(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Family AI Teacher Nathan TTS daemon")
    parser.add_argument("--model", required=True)
    parser.add_argument("--ref-audio", required=True)
    parser.add_argument("--ref-text", required=True)
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--dtype", choices=("float16", "bfloat16"), default="float16")
    parser.add_argument("--cpu", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    model_path = Path(args.model).resolve()
    ref_audio = Path(args.ref_audio).resolve()
    if not (model_path / "config.json").is_file():
        raise FileNotFoundError(f"TTS model config not found: {model_path}")
    if not ref_audio.is_file():
        raise FileNotFoundError(f"TTS reference audio not found: {ref_audio}")
    if not args.ref_text.strip():
        raise ValueError("TTS reference text is empty")

    # Keep third-party progress output off the JSONL protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel

        use_cuda = torch.cuda.is_available() and not args.cpu
        device_map = "cuda:0" if use_cuda else "cpu"
        dtype = torch.float16 if use_cuda and args.dtype == "float16" else (
            torch.bfloat16 if use_cuda else torch.float32
        )
        model = Qwen3TTSModel.from_pretrained(
            str(model_path),
            device_map=device_map,
            dtype=dtype,
            attn_implementation="sdpa",
        )

    _emit({"event": "ready", "device": device_map, "dtype": str(dtype)})
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = ""
        try:
            request = json.loads(line)
            request_id = str(request.get("id", ""))
            if request.get("command") == "shutdown":
                _emit({"event": "shutdown", "id": request_id})
                return 0
            text = " ".join(str(request.get("text", "")).strip().split())
            if not text:
                raise ValueError("TTS text is empty")
            with contextlib.redirect_stdout(sys.stderr):
                with torch.inference_mode():
                    wavs, sample_rate = model.generate_voice_clone(
                        text=text,
                        language=args.language,
                        ref_audio=str(ref_audio),
                        ref_text=args.ref_text,
                        x_vector_only_mode=False,
                    )
                output = io.BytesIO()
                sf.write(output, wavs[0], int(sample_rate), format="WAV")
            audio_bytes = output.getvalue()
            duration_s = round(len(wavs[0]) / int(sample_rate), 3)
            _emit(
                {
                    "event": "audio",
                    "id": request_id,
                    "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
                    "sample_rate": int(sample_rate),
                    "duration_s": duration_s,
                }
            )
        except Exception as exc:  # Keep the daemon alive for the next short request.
            traceback.print_exc(file=sys.stderr)
            _emit(
                {
                    "event": "error",
                    "id": request_id,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
