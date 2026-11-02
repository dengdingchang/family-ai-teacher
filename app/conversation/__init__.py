"""Streaming conversation pipeline.

One child turn flows through these modules:

- :mod:`.pipeline` -- the SSE entry point; builds the turn, starts the worker
  threads, relays their events and cleans up when the browser leaves early.
- :mod:`.state` -- :class:`StreamTurn`, the only state the two workers share.
- :mod:`.local_reply` -- deterministic replies (safety, media, drawing, vision,
  parent invitations, activities, chess) that answer without the model.
- :mod:`.model_reply` -- the producer thread: local reply or streamed model
  text, early first sentence, child-safe fallback on failure.
- :mod:`.speech` -- the speaker thread: TTS jobs to audio events,
  acknowledgement filler, avatar mouth cues and the closing ``done`` event.
- :mod:`.prompts` -- the system prompt and model message list.

Process services (``llm``, ``tts``, ``memory``, ``settings``) and the reply
hooks tests replace are read through :mod:`app.deps`, never imported from
:mod:`app.main`.
"""
