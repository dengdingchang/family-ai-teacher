"""Opt-in Windows-only streaming probe; generated audio stays in RAM."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path


def summarize_chunks(chunks: list[tuple[float, float]], elapsed: float) -> dict:
    """Arrival/duration pairs, not playback receipts or subjective quality."""
    if not chunks or not math.isfinite(elapsed) or elapsed <= 0:
        raise ValueError("No valid streaming measurement")
    duration = 0.0
    earliest_continuous_start = 0.0
    previous_arrival = 0.0
    for arrival, length in chunks:
        if not all(math.isfinite(x) for x in (arrival, length)) or length <= 0:
            raise ValueError("Invalid audio chunk")
        if arrival < previous_arrival or arrival > elapsed:
            raise ValueError("Invalid arrival order")
        earliest_continuous_start = max(earliest_continuous_start, arrival - duration)
        duration += length
        previous_arrival = arrival
    return {
        "chunks": len(chunks), "first_chunk_s": round(chunks[0][0], 3),
        "total_s": round(elapsed, 3), "audio_s": round(duration, 3),
        "generation_seconds_per_audio_second": round(elapsed / duration, 3),
        "minimum_extra_start_buffer_s": round(max(0, earliest_continuous_start - chunks[0][0]), 3),
        "physical_playback_tested": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--run", action="store_true", help="Explicitly load the existing model")
    parser.add_argument("--verify-voice", action="store_true",
                        help="Compare generated speaker vectors in RAM with the approved reference; not a listening test")
    args = parser.parse_args()
    if not (args.model / "config.json").is_file() or not args.reference.is_file():
        raise ValueError("Existing local model and approved reference are required")
    if not args.run:
        print(json.dumps({"paths_valid": True, "model_loaded": False}))
        return 0
    if sys.platform != "win32":
        raise RuntimeError("This probe is scoped to the Windows child device, not AI Station")
    # Set before imports; the candidate's Torch loader does not forward its
    # local_files_only option in the audited revision.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import numpy as np
    import torch

    free, total = torch.cuda.mem_get_info(0)
    # On the idle RTX 3070, CUDA initialization leaves 7128 MiB available
    # (nvidia-smi reports 8018 MiB before initialization). Keep headroom
    # without rejecting this measured idle baseline; allocator cap stays 70%.
    if total > 12 * 2**30 or free < 7000 * 2**20:
        raise RuntimeError("Refusing probe: unexpected GPU or insufficient free VRAM")
    # Allocator limit is a guard, not a hard cap on all driver allocations.
    torch.cuda.set_per_process_memory_fraction(0.70, 0)
    from faster_qwen3_tts import FasterQwen3TTS
    started = time.perf_counter()
    model = FasterQwen3TTS.from_pretrained(
        str(args.model.resolve()), device="cuda:0", dtype=torch.float16,
        attn_implementation="sdpa", max_seq_len=512, local_files_only=True,
    )
    prompt = model.model.create_voice_clone_prompt(
        ref_audio=str(args.reference.resolve()), ref_text=None, x_vector_only_mode=True,
    )
    model.warmup(prefill_len=100)
    torch.cuda.synchronize()
    print(json.dumps({"stage": "cold_load_and_capture", "elapsed_s": round(time.perf_counter()-started, 3),
                      "peak_reserved_mib": round(torch.cuda.max_memory_reserved()/2**20, 1)}), flush=True)
    samples = [("苹果是红色的。", "Chinese"), ("跟我慢慢说一次 Apple，好吗？", "Chinese"),
               ("Let us draw a little star.", "English")]
    for index, (text, language) in enumerate(samples, 1):
        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        chunks = []
        retained_audio = [] if args.verify_voice else None
        stream = model.generate_voice_clone_streaming(
            text=text, language=language, voice_clone_prompt=prompt,
            non_streaming_mode=True, chunk_size=8, max_new_tokens=128,
        )
        try:
            for audio, sample_rate, _timing in stream:
                if not np.isfinite(audio).all() or sample_rate <= 0:
                    raise ValueError("Invalid generated audio")
                if audio.size:
                    chunks.append((time.perf_counter()-started, audio.size/sample_rate))
                    if retained_audio is not None:
                        retained_audio.append(audio.copy())
                del audio  # Do not retain, write, play or upload generated media.
        finally:
            stream.close()
        torch.cuda.synchronize()
        result = summarize_chunks(chunks, time.perf_counter()-started)
        result.update(sample=index, peak_reserved_mib=round(torch.cuda.max_memory_reserved()/2**20, 1),
                      peak_allocated_mib=round(torch.cuda.max_memory_allocated()/2**20, 1),
                      max_new_tokens=128, content_completeness="not_verified")
        if retained_audio:
            waveform = np.concatenate(retained_audio)
            generated_prompt = model.model.create_voice_clone_prompt(
                ref_audio=(waveform, sample_rate), ref_text=None, x_vector_only_mode=True,
            )
            actual = generated_prompt[0].ref_spk_embedding.detach().float().flatten()
            expected = prompt[0].ref_spk_embedding.detach().float().flatten()
            result["reference_speaker_cosine"] = round(
                float(torch.nn.functional.cosine_similarity(actual, expected, dim=0)), 4,
            )
            result["subjective_voice_quality"] = "not_verified"
            del waveform, generated_prompt, retained_audio
        print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
