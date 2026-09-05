# AI Station deployment and OOM guardrail

These units describe the optional loopback-only inference services. As of 2026-09-05, X17 uses remote-preferred Nathan TTS with the existing local model as fallback. Both services are enabled; TTS is ordered after SoulX and vLLM. Startup ordering is not a health/readiness guarantee; each model still runs its own health and free-VRAM checks.

## Fixed limits

- vLLM: `GPU_MEMORY_UTILIZATION=0.72` (configured by its existing systemd drop-in).
- Nathan TTS: `TTS_GPU_MEMORY_FRACTION=0.06`, `TTS_MIN_FREE_MIB=17000`.
- SoulX: `SOULX_GPU_MEMORY_FRACTION=0.07`, `SOULX_MIN_FREE_MIB=17000`, `SOULX_IDLE_MODE=speech_only`, `SOULX_H264_BATCH_FRAMES=3`.
- Operational stop line: do not continue if final free VRAM is below 12GiB or vLLM health is not HTTP 200.

## Safe update order

1. Confirm exact units and GPU state with `systemctl --user status` and `nvidia-smi`.
2. Stop `family-ai-tts.service` and `family-ai-soulx.service` before a SoulX update.
3. Confirm free VRAM is at least 17,000MiB and `http://127.0.0.1:8002/health` is healthy.
4. Update SoulX while both optional services are stopped.
5. Start SoulX; its listener appears only after cold compilation and a decodable H.264 warm-up packet complete. Verify `127.0.0.1:8791` is listening.
6. Recheck vLLM health and free VRAM >=17,000MiB, then start TTS. Verify TTS health and final free VRAM >=12,288MiB. Stop TTS if that final threshold is not met.

Never restart vLLM, TTS, and SoulX together. Never increase any GPU fraction merely to hide a latency problem.

## Current rollback

The pre-deferred-cue TTS server is preserved at:

`/home/selfhost/family-ai-teacher/backups/remote_tts_server.py.pre-deferred-cue-20260904T0645`

Rollback only with SoulX and TTS stopped, restore that exact file, compile it with the TTS virtualenv, start TTS, verify health, then restore SoulX. The current service file is `/home/selfhost/family-ai-teacher/services/remote_tts_server.py`.

SoulX wrapper rollback points created during the 2026-09-04 alignment repair:

- `/home/selfhost/family-ai-teacher/backups/remote_soulx_runner.py.pre-frame-gate-20260904T0935`
- `/home/selfhost/family-ai-teacher/backups/remote_soulx_runner.py.pre-paced-input-20260904T1005`
- `/home/selfhost/family-ai-teacher/backups/remote_soulx_runner.py.pre-keyframe-20260904T110127`
- `/home/selfhost/family-ai-teacher/backups/remote_soulx_runner.py.pre-warm-gate-20260904T111220`

The current wrapper releases 0.96-second chunks on the playback clock, stops the active frame group on `flush`, resets H.264 so every turn starts with a keyframe, and withholds the listener until cold compilation has emitted one decodable packet. This prevents full-utterance queue overflow, stale delta frames, and false readiness.

## Expected steady state

The 2026-09-05 measured free VRAM is 12,936MiB with all three services active and zero restarts. The margin above the 12GiB operational line is only 648MiB. This snapshot and the per-process limits do not isolate unrelated GPU allocations. System RAM is not equivalent to GPU memory for this realtime path. The prior TTS unit is backed up at `/home/selfhost/.config/systemd/user/family-ai-tts.service.pre-codex`.
