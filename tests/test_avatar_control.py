"""Exercise the actual local WebSocket proxy with synthetic PCM and no models."""

import ast
import asyncio
import base64
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest


PCM = base64.b64encode(b"\x01\x00" * 8).decode("ascii")
AUDIO = json.dumps({"type": "audio", "pcm": PCM})
FLUSH = json.dumps({"type": "flush"})


def proxy_function(mode):
    """Load just the production route, avoiding app startup and family storage."""
    path = Path(__file__).parents[1] / "app" / "main.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    route = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                 and node.name == "avatar_websocket")
    route.decorator_list = []
    namespace = {
        "asyncio": asyncio,
        "WebSocket": object,
        "WebSocketDisconnect": type("WebSocketDisconnect", (Exception,), {}),
        "settings": SimpleNamespace(tts_mode=mode, avatar_ws_url="ws://synthetic.invalid"),
        "app": SimpleNamespace(state=SimpleNamespace(avatar_connected_clients=0)),
    }
    # Also lets the same regression exercise the old route before the fix exists.
    try:
        from avatar.control import StreamingAvatarControl
    except ModuleNotFoundError as exc:
        if exc.name != "avatar.control":
            raise
    else:
        namespace["_avatar_control"] = StreamingAvatarControl()
    exec(compile(ast.Module(body=[route], type_ignores=[]), str(path), "exec"), namespace)
    return namespace["avatar_websocket"], namespace["app"]


class Browser:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.outgoing = []
        self.closed = False

    async def accept(self):
        pass

    async def receive(self):
        return await self.incoming.get()

    async def send_json(self, value):
        self.outgoing.append(value)

    async def send_text(self, value):
        self.outgoing.append(value)

    async def send_bytes(self, value):
        self.outgoing.append(value)

    async def close(self, **kwargs):
        self.closed = True


class Upstream:
    def __init__(self, name, writes):
        self.name, self.writes = name, writes
        self.sent = []
        self.received = asyncio.Queue()
        self.changed = asyncio.Condition()
        self.block_flush = False
        self.blocked = asyncio.Event()
        self.release = asyncio.Event()
        self.fail_audio = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.received.get()

    async def send(self, value):
        if self.block_flush and value == FLUSH:
            self.blocked.set()
            await self.release.wait()
        if self.fail_audio and value == AUDIO:
            raise ConnectionError("synthetic transport failure")
        await asyncio.sleep(0)  # Real upstream writes can suspend here.
        async with self.changed:
            self.sent.append(value)
            self.writes.append((self.name, value))
            self.changed.notify_all()

    async def wait_sent(self, value):
        async with self.changed:
            await asyncio.wait_for(self.changed.wait_for(lambda: value in self.sent), 1)


class Connection:
    def __init__(self, browser, upstream, task):
        self.browser, self.upstream, self.task = browser, upstream, task
        self.sequence = 0

    async def send(self, value):
        key = "bytes" if isinstance(value, bytes) else "text"
        await self.browser.incoming.put({"type": "websocket.receive", key: value})

    async def barrier(self):
        self.sequence += 1
        marker = json.dumps({"type": "ping", "test_sequence": self.sequence})
        await self.send(marker)
        await self.upstream.wait_sent(marker)

    async def disconnect(self):
        await self.browser.incoming.put({"type": "websocket.disconnect"})
        await asyncio.wait_for(self.task, 1)


@asynccontextmanager
async def connections(mode="streaming"):
    route, app = proxy_function(mode)
    writes, peers = [], []

    def connect(*args, **kwargs):
        return peers[-1].upstream

    with patch("websockets.asyncio.client.connect", connect):
        try:
            for name in ("old", "new"):
                browser, upstream = Browser(), Upstream(name, writes)
                peer = Connection(browser, upstream, asyncio.create_task(route(browser)))
                peers.append(peer)
                await peer.barrier()
            yield peers[0], peers[1], writes
        finally:
            for peer in peers:
                peer.upstream.release.set()
            for peer in peers:
                if not peer.task.done():
                    await peer.disconnect()
            assert all(peer.browser.closed for peer in peers)
            assert app.state.avatar_connected_clients == 0


def controls(writes):
    return [(name, json.loads(value)["type"]) for name, value in writes
            if isinstance(value, str) and json.loads(value).get("type") != "ping"]


def test_idle_or_old_page_flush_cannot_clear_the_latest_pcm_owner():
    async def run():
        async with connections() as (old, new, writes):
            await old.send(AUDIO)
            await old.barrier()
            await new.send(FLUSH)
            await new.barrier()
            assert ("new", "flush") not in controls(writes)
            await new.send(AUDIO)
            await new.barrier()
            writes.clear()
            await old.send(FLUSH)
            await old.barrier()
            assert controls(writes) == []
            await new.send(FLUSH)
            await new.barrier()
            assert controls(writes) == [("new", "flush")]
    asyncio.run(run())


def test_each_takeover_flushes_before_pcm_but_continuing_pcm_does_not_flush():
    async def run():
        async with connections() as (old, new, writes):
            for peer in (old, new, new):
                await peer.send(AUDIO)
                await peer.barrier()
            assert controls(writes) == [
                ("old", "flush"), ("old", "audio"),
                ("new", "flush"), ("new", "audio"), ("new", "audio"),
            ]
    asyncio.run(run())


def test_ownership_check_and_suspended_write_are_serialized_with_takeover():
    async def run():
        async with connections() as (old, new, writes):
            await old.send(AUDIO)
            await old.barrier()
            writes.clear()
            old.upstream.block_flush = True
            await old.send(FLUSH)
            await asyncio.wait_for(old.upstream.blocked.wait(), 1)
            await new.send(AUDIO)
            handoff = asyncio.create_task(new.barrier())
            try:
                done, _ = await asyncio.wait({handoff}, timeout=0.03)
                assert not done, "new PCM passed an older pending flush"
            finally:
                old.upstream.release.set()
                await handoff
            await old.barrier()
            assert controls(writes) == [("old", "flush"), ("new", "flush"), ("new", "audio")]
            await old.send(FLUSH)
            await old.barrier()
            assert controls(writes)[-1] == ("new", "audio")
    asyncio.run(run())


def test_old_disconnect_does_not_release_new_owner_and_owner_cancel_still_works():
    async def run():
        async with connections() as (old, new, writes):
            for peer in (old, new):
                await peer.send(AUDIO)
                await peer.barrier()
            writes.clear()
            await old.disconnect()
            await new.send(AUDIO)
            await new.send(FLUSH)
            await new.barrier()
            assert controls(writes) == [("new", "audio"), ("new", "flush")]
    asyncio.run(run())


@pytest.mark.parametrize("mode", ["remote_preferred", "persistent", "oneshot"])
def test_non_streaming_protocol_is_forwarded_without_parsing_or_ownership(mode):
    async def run():
        async with connections(mode) as (old, new, writes):
            writes.clear()
            messages = [FLUSH, AUDIO, '{"type":"audio_begin"}', '{"type":"audio_end"}',
                        b"binary-control", "old opaque protocol"]
            for peer in (old, new):
                for message in messages:
                    await peer.send(message)
                await peer.barrier()
                assert peer.upstream.sent[1:-1] == messages
    asyncio.run(run())


@pytest.mark.parametrize("pcm", ["", "%%%", "AA==", None, 123])
def test_invalid_pcm_cannot_take_ownership_or_reach_the_renderer(pcm):
    async def run():
        async with connections() as (old, new, writes):
            await old.send(AUDIO)
            await old.barrier()
            writes.clear()
            await new.send(json.dumps({"type": "audio", "pcm": pcm}))
            await new.send(FLUSH)
            await new.barrier()
            await old.send(FLUSH)
            await old.barrier()
            assert controls(writes) == [("old", "flush")]
    asyncio.run(run())


def test_transport_failure_is_reported_and_releases_control_for_next_connection():
    async def run():
        async with connections() as (old, new, writes):
            old.upstream.fail_audio = True
            await old.send(AUDIO)
            await asyncio.wait_for(old.task, 1)
            assert old.browser.outgoing[-1] == {
                "type": "error", "message": "avatar unavailable: ConnectionError",
            }
            writes.clear()
            await new.send(AUDIO)
            await new.barrier()
            assert controls(writes) == [("new", "flush"), ("new", "audio")]
    asyncio.run(run())


def test_cancelling_a_suspended_owner_stops_its_write_and_allows_pending_takeover():
    async def run():
        async with connections() as (old, new, writes):
            await old.send(AUDIO)
            await old.barrier()
            writes.clear()
            old.upstream.block_flush = True
            await old.send(FLUSH)
            await asyncio.wait_for(old.upstream.blocked.wait(), 1)
            await new.send(AUDIO)
            old.task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await old.task
            await new.barrier()
            old.upstream.release.set()
            await new.send(AUDIO)
            await new.barrier()
            assert controls(writes) == [("new", "flush"), ("new", "audio"), ("new", "audio")]
    asyncio.run(run())


def test_frame_broadcast_and_streaming_ping_binary_passthrough_remain_unchanged():
    async def run():
        async with connections() as (old, new, writes):
            for peer in (old, new):
                await peer.send(b"unchanged-binary-control")
                await peer.barrier()
                assert b"unchanged-binary-control" in peer.upstream.sent
                # This fix deliberately does not claim frame ownership isolation.
                await peer.upstream.received.put(b"FATV1-synthetic-frame")
            for _ in range(4):
                await asyncio.sleep(0)
            assert all(b"FATV1-synthetic-frame" in peer.browser.outgoing for peer in (old, new))
    asyncio.run(run())
