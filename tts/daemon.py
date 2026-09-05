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


def _wav_payload(waveform, sample_rate: int, sf) -> dict[str, object]:
    output = io.BytesIO()
    sf.write(output, waveform, int(sample_rate), format="WAV")
    return {
        "audio_base64": base64.b64encode(output.getvalue()).decode("ascii"),
        "sample_rate": int(sample_rate),
        "duration_s": round(len(waveform) / int(sample_rate), 3),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Family AI Teacher Nathan TTS daemon")
    parser.add_argument("--model", required=True)
    parser.add_argument("--ref-audio", required=True)
    parser.add_argument("--ref-text", required=True)
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--dtype", choices=("float16", "bfloat16"), default="float16")
    parser.add_argument(
        "--prompt-mode",
        choices=("speaker_vector", "icl"),
        default="speaker_vector",
        help="Use the fast speaker embedding or the longer reference-code context.",
    )
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

        # Build the audited Nathan voice prompt once. Re-reading and encoding
        # the 37-second reference on every turn defeats the persistent worker.
        speaker_vector_mode = args.prompt_mode == "speaker_vector"
        voice_clone_prompt = model.create_voice_clone_prompt(
            ref_audio=str(ref_audio),
            ref_text=None if speaker_vector_mode else args.ref_text,
            x_vector_only_mode=speaker_vector_mode,
        )

    _emit(
        {
            "event": "ready",
            "device": device_map,
            "dtype": str(dtype),
            "prompt_mode": args.prompt_mode,
        }
    )
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
            batch_value = request.get("texts")
            if batch_value is not None:
                if not isinstance(batch_value, list) or not 1 <= len(batch_value) <= 2:
                    raise ValueError("TTS batch must contain one or two texts")
                texts = [" ".join(str(item).strip().split()) for item in batch_value]
                if any(not text or len(text) > 200 for text in texts):
                    raise ValueError("TTS batch contains invalid text")
                with contextlib.redirect_stdout(sys.stderr):
                    with torch.inference_mode():
                        wavs, sample_rate = model.generate_voice_clone(
                            text=texts,
                            language=[args.language] * len(texts),
                            voice_clone_prompt=voice_clone_prompt,
                            non_streaming_mode=True,
                        )
                if len(wavs) != len(texts):
                    raise RuntimeError("TTS batch output count did not match input")
                _emit(
                    {
                        "event": "audio_batch",
                        "id": request_id,
                        "items": [_wav_payload(wav, int(sample_rate), sf) for wav in wavs],
                    }
                )
                continue
            text = " ".join(str(request.get("text", "")).strip().split())
            if not text:
                raise ValueError("TTS text is empty")
            with contextlib.redirect_stdout(sys.stderr):
                with torch.inference_mode():
                    wavs, sample_rate = model.generate_voice_clone(
                        text=text,
                        language=args.language,
                        voice_clone_prompt=voice_clone_prompt,
                        # The worker receives a complete short sentence. The
                        # runtime documents this mode as avoiding its
                        # simulated incremental text path.
                        non_streaming_mode=True,
                    )
            audio = _wav_payload(wavs[0], int(sample_rate), sf)
            _emit(
                {
                    "event": "audio",
                    "id": request_id,
                    **audio,
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
