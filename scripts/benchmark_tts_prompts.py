"""Compare prompt strategies for the existing Nathan Qwen3-TTS model.

This is a local, opt-in benchmark. It writes only generated test WAV files to
the explicitly supplied output directory and never changes the model or voice
reference assets.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as functional
from qwen_tts import Qwen3TTSModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark Nathan TTS prompt latency")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--matrix", type=Path, required=True)
    parser.add_argument("--audio-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--text", default="Hello 是你好，你会说吗？")
    parser.add_argument("--reference-name", default="emotion_calm")
    parser.add_argument(
        "--attention-implementation",
        choices=("sdpa", "flash_attention_2"),
        default="sdpa",
    )
    parser.add_argument("--gpu-memory-fraction", type=float, default=0.0)
    return parser.parse_args()


def load_reference(matrix_path: Path, audio_dir: Path, name: str) -> tuple[Path, str]:
    payload = json.loads(matrix_path.read_text(encoding="utf-8"))
    for item in payload:
        if isinstance(item, dict) and item.get("name") == name:
            audio_path = audio_dir / str(item["ref_audio"])
            if not audio_path.is_file():
                raise FileNotFoundError(audio_path)
            return audio_path, str(item["ref_text"])
    raise ValueError(f"reference not found: {name}")


def speaker_embedding(model: Qwen3TTSModel, audio_path: Path) -> torch.Tensor:
    prompt = model.create_voice_clone_prompt(
        ref_audio=str(audio_path),
        ref_text=None,
        x_vector_only_mode=True,
    )[0]
    return prompt.ref_spk_embedding.detach().float().cpu().flatten()


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    ref_audio, ref_text = load_reference(args.matrix, args.audio_dir, args.reference_name)

    if args.gpu_memory_fraction:
        if not 0.01 <= args.gpu_memory_fraction <= 0.25:
            raise ValueError("gpu memory fraction must be between 0.01 and 0.25")
        torch.cuda.set_per_process_memory_fraction(args.gpu_memory_fraction, 0)

    model = Qwen3TTSModel.from_pretrained(
        str(args.model.resolve()),
        device_map="cuda:0",
        dtype=torch.float16,
        attn_implementation=args.attention_implementation,
    )
    prompts = {
        "short_icl": model.create_voice_clone_prompt(
            ref_audio=str(ref_audio),
            ref_text=ref_text,
            x_vector_only_mode=False,
        ),
        "speaker_vector": model.create_voice_clone_prompt(
            ref_audio=str(ref_audio),
            ref_text=None,
            x_vector_only_mode=True,
        ),
    }

    # One tiny warm-up keeps one-time CUDA initialization out of both samples.
    with torch.inference_mode():
        model.generate_voice_clone(
            text="你好。",
            language="Chinese",
            voice_clone_prompt=prompts["speaker_vector"],
            non_streaming_mode=True,
        )
    torch.cuda.synchronize()

    reference_embedding = speaker_embedding(model, ref_audio)
    results: list[dict[str, object]] = []
    for name, prompt in prompts.items():
        torch.cuda.synchronize()
        started = time.perf_counter()
        with torch.inference_mode():
            wavs, sample_rate = model.generate_voice_clone(
                text=args.text,
                language="Chinese",
                voice_clone_prompt=prompt,
                non_streaming_mode=True,
            )
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        output_path = args.output_dir / f"nathan-{name}.wav"
        sf.write(output_path, wavs[0], int(sample_rate), format="WAV")
        duration = len(wavs[0]) / int(sample_rate)
        output_embedding = speaker_embedding(model, output_path)
        similarity = functional.cosine_similarity(
            reference_embedding.unsqueeze(0), output_embedding.unsqueeze(0)
        ).item()
        results.append(
            {
                "name": name,
                "elapsed_s": round(elapsed, 3),
                "duration_s": round(duration, 3),
                "realtime_factor": round(elapsed / max(duration, 0.001), 3),
                "speaker_cosine": round(float(similarity), 4),
                "peak_allocated_mib": round(torch.cuda.max_memory_allocated() / 2**20, 1),
                "output": str(output_path),
            }
        )
        torch.cuda.reset_peak_memory_stats()

    print(json.dumps({"reference": str(ref_audio), "text": args.text, "results": results}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
