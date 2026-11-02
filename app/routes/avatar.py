"""Avatar portrait, idle clip and the same-origin avatar WebSocket proxy."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from avatar.control import StreamingAvatarControl

from .. import deps
from ..avatar_assets import _avatar_idle_path, _avatar_path, _parent_avatar_configured

router = APIRouter()

_avatar_control = StreamingAvatarControl()


@router.get("/api/avatar")
async def avatar() -> FileResponse:
    path, media_type = _avatar_path()
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-store"})


@router.get("/api/avatar/idle")
async def avatar_idle() -> FileResponse:
    path = _avatar_idle_path()
    if path is None:
        raise HTTPException(status_code=404, detail="Avatar idle clip is not configured")
    return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "no-store"})


@router.websocket("/ws/avatar")
async def avatar_websocket(websocket: WebSocket) -> None:
    """Same-origin proxy to the loopback-only SoulX WebSocket tunnel."""

    await websocket.accept()
    if deps.parent_enrollment.active() and not _parent_avatar_configured():
        await websocket.send_json({"type": "error", "message": "personal avatar motion is not ready"})
        await websocket.close(code=1013)
        return
    upstream_connected = False
    # Only browser-fed PCM has the same control and viewing connection. Legacy
    # remote TTS cues use a separate connection and retain the original proxy.
    streaming_control = deps.settings.tts_mode == "streaming"
    if not deps.settings.avatar_ws_url:
        await websocket.send_json({"type": "error", "message": "avatar is not configured"})
        await websocket.close(code=1013)
        return
    try:
        from websockets.asyncio.client import connect

        async with connect(
            deps.settings.avatar_ws_url,
            max_size=16 * 1024 * 1024,
            open_timeout=3,
            close_timeout=2,
        ) as upstream:
            upstream_connected = True
            websocket.app.state.avatar_connected_clients += 1

            async def browser_to_avatar() -> None:
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        return
                    if message.get("text") is not None:
                        payload = str(message["text"])
                    elif message.get("bytes") is not None:
                        payload = bytes(message["bytes"])
                    else:
                        continue
                    if streaming_control:
                        await _avatar_control.forward(websocket, upstream.send, payload)
                    else:
                        await upstream.send(payload)

            async def avatar_to_browser() -> None:
                async for message in upstream:
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(str(message))

            tasks = {
                asyncio.create_task(browser_to_avatar()),
                asyncio.create_task(avatar_to_browser()),
            }
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            for task in done:
                task.result()
    except WebSocketDisconnect:
        return
    except Exception as exc:
        try:
            await websocket.send_json(
                {"type": "error", "message": f"avatar unavailable: {type(exc).__name__}"}
            )
        except Exception:
            pass
    finally:
        if streaming_control:
            await _avatar_control.release(websocket)
        if upstream_connected:
            websocket.app.state.avatar_connected_clients = max(
                0,
                websocket.app.state.avatar_connected_clients - 1,
            )
        try:
            await websocket.close()
        except Exception:
            pass
