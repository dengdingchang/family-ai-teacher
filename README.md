# Family AI Teacher （爸爸老师）

**A local-first AI teacher for young children — in a parent's own voice and likeness.**

Family AI Teacher lets a parent enroll their voice and portrait once, then
gives their child a patient, always-available "AI dad/mom teacher" that runs
on the family's own hardware. The child talks, draws, plays and learns in
short guided steps; everything personal stays in the home by design.

> Status: working system in daily use by the author's family since
> September 2026, under active development. Currently a single-family
> deployment; multi-family isolation is on the roadmap.

## Why this exists

Parents want AI help with early learning, but two things hold them back:

1. **Privacy** — mainstream "AI companion" apps upload a child's voice,
   images and conversations to someone else's cloud.
2. **Trust** — a child bonding with a stranger's synthetic voice is not
   what most parents want.

Family AI Teacher takes the opposite bet: a *familiar* parent's voice,
*self-hosted*, with raw audio and camera frames never persisted or uploaded.

## What it does

- **Voice-first conversation** — streaming STT → LLM → TTS pipeline with
  barge-in: the child can interrupt at any time, and every reply ends with
  one small question a 4-year-old can actually answer.
- **Parent enrollment** — a ~10-second in-browser recording creates a
  local voice profile and portrait; parents can preview, enable, delete
  and restore it at any time. Raw recordings are processed in memory and
  never written to disk.
- **Guided activities, not open chat** — drawing board (with opt-in
  observation of the current drawing), stories, beginner chess, music
  practice, and step-by-step number / color / English courses that adapt
  to parent-confirmed ability levels.
- **Visuals on request** — image generation and web search restricted to
  trusted learning sources (YouTube, Wikimedia, NASA, PBS Kids, Khan
  Academy Kids, …), shown full-screen with clear sourcing.
- **Parent space** — child profile and nicknames, growth archive and
  weekly reviews, a skill graph based on parent assessment (never
  auto-inferred "mastery"), voice messages from parent to child with
  real playback receipts, and full data export / scoped deletion.
- **Graceful degradation** — if the LLM, vision or avatar service is
  unavailable, core voice interaction falls back to built-in local
  lessons instead of showing the child an error.

## Privacy by design

- Raw microphone audio and camera video are **never persisted**; camera
  frames are sent only on an explicit action ("Dad, look at my drawing",
  a photo button, a short clip) and processed in memory.
- All family data lives in local structured files (`data/`): child
  profile, conversation history, learning events, memories, skill
  graph, parent messages. Export explicitly reports
  `raw_media_included=false`.
- The app binds to loopback by default. Any remote access (a parent's
  phone/tablet) is something you set up yourself, under your control.
- LLM access supports OpenAI or any OpenAI-compatible endpoint; keys
  live only in your local `.env`.

## Architecture

| Piece | Runs where | Notes |
| --- | --- | --- |
| Web app + local STT/TTS | Your Windows PC | Python; GPU STT optional with CPU fallback |
| LLM / Vision / avatar (SoulX) | Same PC, or a second machine on your LAN/tailnet | Behind interfaces in `.env`; nothing is hard-wired to the author's setup |
| Child UI | Browser / tablet | Voice-first, big touch targets, minimal text |

## Quick start

```powershell
git clone https://github.com/dengdingchang/family-ai-teacher.git
cd family-ai-teacher
copy .env.example .env   # fill in your LLM endpoint + key
.\scripts\start.ps1
```

Then open the local parent page to enroll a parent's voice and portrait,
and the child page to start a session.

Requirements: Windows + PowerShell 7, Python (see `requirements.txt`),
Node for the test suite. A GPU is recommended for streaming TTS/avatar;
CPU fallbacks are built in.

## Roadmap

- Face-centering / liveness checks during parent enrollment
- Multi-family accounts with per-family data isolation
- Packaged installer (no manual environment setup)
- More course packs and languages

## Development

```powershell
& $python -S -m pytest tests -q
node --test tests/*.test.cjs
```

Product principles live in `PRODUCT.md`; visual language in `DESIGN.md`.

## License

Apache License 2.0 — see `LICENSE`.

## Acknowledgements

Avatar lip-sync uses the SoulX stack; service decomposition was
informed by [VoxEMW](https://github.com/emwstudio/VoxEMW).
