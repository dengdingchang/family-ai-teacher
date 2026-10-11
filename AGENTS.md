# Family AI Teacher project rules

- Start each continuation from `docs/current-stage.md` and `docs/2026-09-06_handoff.md`; keep the former as the current execution matrix and the latter as the cross-device handoff.

- Deployment authority (2026-10-11): the owner authorizes AI Station as the independent application and family-data host; Windows remains a retained rollback deployment. Keep a single writable primary. Do not resume the Windows application before syncing new primary data back.
- Read and reuse the existing Nathan TTS runtime; do not install another voice model without explicit approval.
- Keep LLM, Vision, and future Memory services behind interfaces. Do not move models to this laptop.
- Do not persist raw microphone audio, raw camera video, or automatically upload camera frames.
- Keep the HTTP server bound to `127.0.0.1` unless the owner explicitly changes the safety policy.
- Any change to model paths, child data, or network endpoints must be visible in `.env` or `README.md`.
- Verify every change with a small smoke test and report PASS, PARTIAL, FAIL, or NOT RUN honestly.
