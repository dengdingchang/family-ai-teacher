"""Isolated CUDA worker for the existing Nathan checkpoint; audio stays in RAM."""

from __future__ import annotations

import argparse
import base64
import contextlib
import dataclasses
import io
import json
import os
import queue
import sys
import threading
import time
from pathlib import Path


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def gpu_memory_fraction(free: int, total: int) -> float:
    budget_mib = int(os.getenv("TTS_STREAMING_GPU_BUDGET_MIB", "0"))
    if budget_mib and not 6600 <= budget_mib <= 12288:
        raise RuntimeError("Streaming GPU budget must be between 6600 and 12288 MiB")
    if (not budget_mib and total > 12 * 2**30) or free < max(6600, budget_mib) * 2**20:
        raise RuntimeError("Insufficient idle local GPU capacity for streaming voice")
    if budget_mib * 2**20 > total:
        raise RuntimeError("Streaming GPU budget exceeds device capacity")
    return budget_mib * 2**20 / total if budget_mib else 0.70


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--ref-audio", required=True)
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--parent-embedding", default="")
    args = parser.parse_args()
    if not (Path(args.model) / "config.json").is_file() or not Path(args.ref_audio).is_file():
        raise ValueError("Existing Nathan model and reference are required")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import soundfile as sf
        import torch
        from faster_qwen3_tts import FasterQwen3TTS

        if not torch.cuda.is_available():
            raise RuntimeError("Streaming voice requires the existing local CUDA GPU")
        free, total = torch.cuda.mem_get_info(0)
        # Leave capacity for the browser. This is an allocator guard, not a
        # device-wide memory quota; never evict another model to make room.
        torch.cuda.set_per_process_memory_fraction(gpu_memory_fraction(free, total), 0)
        torch.set_num_threads(4)
        model = FasterQwen3TTS.from_pretrained(
            str(Path(args.model).resolve()), device="cuda:0", dtype=torch.float16,
            attn_implementation="sdpa", max_seq_len=512, local_files_only=True,
        )
        nathan_prompt = model.model.create_voice_clone_prompt(
            ref_audio=str(Path(args.ref_audio).resolve()), ref_text=None, x_vector_only_mode=True,
        )
        prompt = nathan_prompt
        def prompt_from_embedding(raw: bytes):
            if len(raw) != nathan_prompt[0].ref_spk_embedding.numel() * 4:
                raise ValueError("Parent voice embedding has wrong size")
            vector = np.frombuffer(raw, dtype="<f4")
            if not np.isfinite(vector).all() or np.max(np.abs(vector)) > 100:
                raise ValueError("Parent voice embedding is invalid")
            reference = nathan_prompt[0].ref_spk_embedding
            tensor = torch.as_tensor(vector.copy(), device=reference.device, dtype=reference.dtype)
            return [dataclasses.replace(nathan_prompt[0], ref_spk_embedding=tensor)]
        if args.parent_embedding:
            try:
                prompt = prompt_from_embedding(Path(args.parent_embedding).read_bytes())
            except (OSError, ValueError):
                prompt = nathan_prompt
        model.warmup(prefill_len=100)

    requests: queue.Queue = queue.Queue()
    cancellations: dict[str, threading.Event] = {}
    control_lock = threading.Lock()

    def read_commands() -> None:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                request_id = str(request.get("id", ""))
                with control_lock:
                    if request.get("command") == "cancel":
                        event = cancellations.get(request_id)
                        if event is not None:
                            event.set()
                        continue
                    cancellations[request_id] = threading.Event()
                requests.put(request)
            except (ValueError, TypeError):
                requests.put({"id": "", "invalid": True})
        with control_lock:
            for event in cancellations.values():
                event.set()
        requests.put(None)

    threading.Thread(target=read_commands, name="voice-controls", daemon=True).start()
    emit({"event": "ready", "backend": "local-streaming", "prompt_mode": "speaker_vector"})
    while True:
        request = requests.get()
        if request is None or request.get("command") == "shutdown":
            emit({"event": "shutdown", "id": request.get("id", "") if request else ""})
            return 0
        request_id = str(request.get("id", ""))
        stop = cancellations.get(request_id, threading.Event())
        stream = None
        try:
            command = request.get("command")
            if command == "prepare_voice":
                raw = base64.b64decode(request.get("audio_base64", ""), validate=True)
                if len(raw) > 2_200_000:
                    raise ValueError("Reference recording is too large")
                with contextlib.redirect_stdout(sys.stderr):
                    reference_audio, reference_rate = sf.read(io.BytesIO(raw), dtype="float32")
                    candidate = model.model.create_voice_clone_prompt(
                        ref_audio=(reference_audio, reference_rate), ref_text=None,
                        x_vector_only_mode=True,
                    )
                embedding = candidate[0].ref_spk_embedding.detach().cpu().float().numpy().astype("<f4").tobytes()
                preview_parts = []
                with contextlib.redirect_stdout(sys.stderr):
                    preview_stream = model.generate_voice_clone_streaming(
                        text="你好，我们一起发现今天的新东西吧。", language=args.language,
                        voice_clone_prompt=candidate, non_streaming_mode=True,
                        chunk_size=8, max_new_tokens=200,
                    )
                try:
                    for waveform, sample_rate, _ in preview_stream:
                        if waveform.size:
                            preview_parts.append(waveform)
                finally:
                    preview_stream.close()
                if not preview_parts:
                    raise RuntimeError("Voice preview was empty")
                preview_audio = np.concatenate(preview_parts)
                output = io.BytesIO()
                sf.write(output, preview_audio, int(sample_rate), format="WAV", subtype="PCM_16")
                emit({"event": "voice_preview", "id": request_id,
                      "embedding_base64": base64.b64encode(embedding).decode("ascii"),
                      "audio_base64": base64.b64encode(output.getvalue()).decode("ascii"),
                      "duration_s": round(preview_audio.size / int(sample_rate), 4)})
                continue
            if command == "activate_voice":
                raw = base64.b64decode(request.get("embedding_base64", ""), validate=True)
                prompt = prompt_from_embedding(raw)
                emit({"event": "voice_active", "id": request_id})
                continue
            if command == "restore_voice":
                prompt = nathan_prompt
                emit({"event": "voice_active", "id": request_id})
                continue
            text = " ".join(str(request.get("text", "")).strip().split())
            if not text or len(text) > 200:
                raise ValueError("Streaming voice expects a short sentence of 1 to 200 characters")
            started = time.perf_counter()
            chunks, steps = 0, 0
            # 256 codec steps allow about 20 seconds. Reaching the limit is an
            # error, never a successful partial utterance.
            with contextlib.redirect_stdout(sys.stderr):
                stream = model.generate_voice_clone_streaming(
                    text=text, language=args.language, voice_clone_prompt=prompt,
                    non_streaming_mode=True, chunk_size=8, max_new_tokens=256,
                )
            while not stop.is_set():
                try:
                    with contextlib.redirect_stdout(sys.stderr):
                        waveform, sample_rate, timing = next(stream)
                except StopIteration:
                    break
                if stop.is_set():
                    break
                if not np.isfinite(waveform).all() or sample_rate <= 0:
                    raise ValueError("Invalid generated waveform")
                steps = int(timing.get("total_steps_so_far", steps))
                if not waveform.size:
                    continue
                output = io.BytesIO()
                sf.write(output, waveform, int(sample_rate), format="WAV", subtype="PCM_16")
                chunks += 1
                emit({"event": "chunk", "id": request_id, "sequence": chunks,
                      "audio_base64": base64.b64encode(output.getvalue()).decode("ascii"),
                      "duration_s": waveform.size / int(sample_rate),
                      "elapsed_s": round(time.perf_counter() - started, 4)})
            cache_at_limit = int(model.talker_graph.cache_position.item()) >= model.talker_graph.max_seq_len - 2
            if not stop.is_set() and (not chunks or steps >= 256 or cache_at_limit):
                raise RuntimeError("Voice generation was empty or reached its token limit")
            emit({"event": "cancelled" if stop.is_set() else "done", "id": request_id,
                  "chunks": chunks, "codec_steps": steps})
        except Exception as exc:
            # Exception text from model code may contain the child's sentence.
            emit({"event": "error", "id": request_id, "error": type(exc).__name__})
        finally:
            if stream is not None:
                with contextlib.redirect_stdout(sys.stderr):
                    stream.close()
            with control_lock:
                cancellations.pop(request_id, None)


if __name__ == "__main__":
    raise SystemExit(main())
