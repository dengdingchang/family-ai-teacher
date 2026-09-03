# Family AI Teacher project rules

- Keep this project a single local Windows application.
- Read and reuse the existing Nathan TTS runtime; do not install another voice model without explicit approval.
- Keep LLM, Vision, and future Memory services behind interfaces. Do not move models to this laptop.
- Do not persist raw microphone audio, raw camera video, or automatically upload camera frames.
- Keep the HTTP server bound to `127.0.0.1` unless the owner explicitly changes the safety policy.
- Any change to model paths, child data, or network endpoints must be visible in `.env` or `README.md`.
- Verify every change with a small smoke test and report PASS, PARTIAL, FAIL, or NOT RUN honestly.
