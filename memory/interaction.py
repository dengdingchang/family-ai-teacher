"""Bounded receipts and elapsed interval totals; never derive time from turns."""

from __future__ import annotations

import json
import uuid
from collections import OrderedDict
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any


class InteractionConflictError(ValueError):
    pass


def utc_time(value: Any) -> datetime:
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError("interaction timestamps must be UTC ISO strings")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("invalid interaction timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ValueError("interaction timestamps must explicitly use UTC")
    return parsed.astimezone(timezone.utc)


def normalize_interval(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        session_id = str(uuid.UUID(str(payload["session_id"])))
        sequence = payload["sequence"]
        start, end = utc_time(payload["start_at"]), utc_time(payload["end_at"])
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise ValueError("invalid interaction interval") from exc
    if (not isinstance(sequence, int) or isinstance(sequence, bool)
            or not 0 < sequence <= 9007199254740991):
        raise ValueError("interaction sequence must be a positive safe integer")
    if not 0 < (end - start).total_seconds() <= 15:
        raise ValueError("interaction interval must be greater than zero and at most 15 seconds")
    return {"session_id": session_id, "sequence": sequence,
            "start_at": start.isoformat(), "end_at": end.isoformat()}


def validate_arrival(payload: dict[str, Any], now: datetime) -> None:
    start, end = utc_time(payload["start_at"]), utc_time(payload["end_at"])
    # A small fast client clock is tolerated, but no wholly future interval is.
    if start >= now or end > now + timedelta(seconds=2):
        raise ValueError("interaction interval is in the future")
    if now - end > timedelta(minutes=5):
        raise ValueError("interaction interval arrived more than five minutes late")


def local_day_bounds(now: datetime) -> tuple[datetime, datetime]:
    local_date = now.astimezone().date()
    # Convert each naive local midnight separately, preserving Windows DST rules.
    start = datetime.combine(local_date, time.min).astimezone(timezone.utc)
    end = datetime.combine(local_date + timedelta(days=1), time.min).astimezone(timezone.utc)
    return start, end


def today_interaction(events: list[dict[str, Any]], now: datetime) -> dict[str, Any]:
    day_start, day_end = local_day_bounds(now)
    intervals: list[tuple[datetime, datetime]] = []
    for event in events:
        if event.get("event_type") != "interaction_interval":
            continue
        try:
            payload = normalize_interval(event.get("payload"))
            received = utc_time(event.get("created_at"))
            validate_arrival(payload, received)
            start = max(utc_time(payload["start_at"]), day_start)
            # Never later count the clock-skew tail that was future on arrival.
            end = min(utc_time(payload["end_at"]), received, now, day_end)
        except (TypeError, ValueError):
            continue
        if end > start:
            intervals.append((start, end))
    total = 0.0
    merged_end: datetime | None = None
    for start, end in sorted(intervals):
        uncovered_start = max(start, merged_end) if merged_end is not None else start
        if end > uncovered_start:
            total += (end - uncovered_start).total_seconds()
        merged_end = max(merged_end, end) if merged_end is not None else end
    return {"interaction_seconds": round(total, 3),
            "interaction_timing_available": bool(intervals)}


class InteractionReceiptIndex:
    """Incrementally read an append-only event log; keep bounded recent indexes.

    Calls are serialized by MemoryStore's existing lock. A cold load scans once;
    advancing sequences in a known session only inspect newly appended bytes.
    An evicted session/old receipt is resolved from the full durable log, so the
    cache bound never changes idempotency or discards family history.
    """

    def __init__(self, path: Path, session_limit: int = 128, receipt_limit: int = 2048) -> None:
        self.path = path
        self.session_limit = session_limit
        self.receipt_limit = receipt_limit
        self.reset()

    def reset(self) -> None:
        self.sessions: OrderedDict[str, int] = OrderedDict()
        self.receipts: OrderedDict[tuple[str, int], dict[str, Any]] = OrderedDict()
        self.offset = 0
        self.signature: tuple[int, int] | None = None
        self.modified_ns: int | None = None
        self.complete_session_index = True

    @staticmethod
    def _parse_line(line: bytes) -> dict[str, Any] | None:
        try:
            event = json.loads(line)
            if isinstance(event, dict) and event.get("event_type") == "interaction_interval":
                return normalize_interval(event.get("payload"))
        except (UnicodeError, ValueError, TypeError):
            pass
        return None

    def remember(self, payload: dict[str, Any]) -> None:
        sid, sequence = payload["session_id"], payload["sequence"]
        self.sessions[sid] = max(sequence, self.sessions.get(sid, 0))
        self.sessions.move_to_end(sid)
        if len(self.sessions) > self.session_limit:
            self.sessions.popitem(last=False)
            self.complete_session_index = False
        self.receipts[(sid, sequence)] = payload
        self.receipts.move_to_end((sid, sequence))
        if len(self.receipts) > self.receipt_limit:
            self.receipts.popitem(last=False)

    def sync(self) -> None:
        try:
            stat = self.path.stat()
        except FileNotFoundError:
            self.reset()
            return
        signature = (stat.st_dev, stat.st_ino)
        if (self.signature != signature or stat.st_size < self.offset
                or (stat.st_size == self.offset and self.modified_ns not in {None, stat.st_mtime_ns})):
            self.reset()
        self.signature = signature
        if stat.st_size > self.offset:
            with self.path.open("rb") as handle:
                handle.seek(self.offset)
                while line := handle.readline():
                    self.offset = handle.tell()
                    payload = self._parse_line(line)
                    if payload:
                        self.remember(payload)
        self.modified_ns = stat.st_mtime_ns

    def lookup(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        self.sync()
        sid, sequence = payload["session_id"], payload["sequence"]
        key = (sid, sequence)
        if key in self.receipts:
            self.receipts.move_to_end(key)
            return self.receipts[key]
        maximum = self.sessions.get(sid)
        if maximum is not None and sequence > maximum:
            return None
        if maximum is None and self.complete_session_index:
            return None
        # Rare old/evicted receipt, not the normal 15-second advancing write.
        maximum = maximum or 0
        found = None
        if self.path.is_file():
            with self.path.open("rb") as handle:
                for line in handle:
                    record = self._parse_line(line)
                    if record and record["session_id"] == sid:
                        maximum = max(maximum, record["sequence"])
                        if record["sequence"] == sequence:
                            found = record
        self.sessions[sid] = maximum
        self.sessions.move_to_end(sid)
        if len(self.sessions) > self.session_limit:
            self.sessions.popitem(last=False)
            self.complete_session_index = False
        if found:
            self.remember(found)
        return found
