"""Shared vocabulary for the three-state browser mouth animation."""

MOUTH_STATES = ("closed", "half", "open")


def state_for_energy(energy: float) -> str:
    if energy >= 0.14:
        return "open"
    if energy >= 0.045:
        return "half"
    return "closed"
