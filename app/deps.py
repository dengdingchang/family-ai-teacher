"""Late-bound access to the services owned by :mod:`app.main`.

``app.main`` is the composition root: it builds the settings, the family memory
store, the language-model client, the voice adapters and the avatar bridge once
at import time. Modules below it (route packages, reply builders) must not
import ``app.main`` directly -- that would close an import cycle -- and must not
copy those objects either, because tests and the owner replace them on
``app.main``. They read them through this proxy instead, which resolves the
current attribute on every access.
"""

from __future__ import annotations

from typing import Any


def replace(name: str, value: Any) -> None:
    """Swap a service on the composition root.

    The parent settings page rebuilds the language model client and the image
    generator at runtime, so the new objects have to land where every reader
    looks them up -- ``app.main``.
    """

    from . import main

    setattr(main, name, value)


def __getattr__(name: str) -> Any:
    from . import main

    try:
        return getattr(main, name)
    except AttributeError:  # pragma: no cover - developer error
        raise AttributeError(f"app.deps has no attribute {name!r}") from None
