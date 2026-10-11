"""Authenticated Windows loopback gateway for the public teacher tunnel."""

from __future__ import annotations

import asyncio
import html
import os
import time
from contextlib import asynccontextmanager, suppress
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from starlette.background import BackgroundTask
from websockets.asyncio.client import connect as websocket_connect

from app import public_auth as studio_auth
from app.config import require_primary_deployment


UPSTREAM = os.environ.get("TEACHER_UPSTREAM", "http://127.0.0.1:8760").rstrip("/")
UPSTREAM_WS = UPSTREAM.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
PUBLIC_HOST = os.environ.get("TEACHER_PUBLIC_HOST", "teacher.example.com").lower()
ALLOWED_PROFILES = {
    item.strip()
    for item in os.environ.get("TEACHER_ALLOWED_PROFILES", "nathan").split(",")
    if item.strip()
}
SAFE_HOSTS = {PUBLIC_HOST, "127.0.0.1", "localhost"}
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "cookie",
    "forwarded", "x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto",
}


def _profile(token: str | None) -> str | None:
    profile_id = studio_auth.session_profile(token)
    return profile_id if profile_id in ALLOWED_PROFILES else None


def _login_page(error: str = "") -> str:
    profiles = [p for p in studio_auth.public_accounts() if p["id"] in ALLOWED_PROFILES]
    options = "".join(
        f'<option value="{html.escape(p["id"])}">{html.escape(p["name"])}</option>'
        for p in profiles
    )
    error_html = f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ""
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>爸爸老师登录</title><style>
*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:grid;place-items:center;
background:radial-gradient(circle at 50% -25%,#fff 0,#f6f3ed 62%);
font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#20342f;padding:24px}}
main{{width:min(450px,100%);background:#fffdf9;border:1px solid #e5e0d7;border-radius:30px;
padding:clamp(26px,5vw,42px);box-shadow:0 22px 68px #2f473017}}
.mark{{display:grid;place-items:center;width:60px;height:60px;border-radius:20px;
background:#e7f1eb;color:#225b49;font-size:30px;margin-bottom:24px}}
.eyebrow{{color:#537d61;font-size:12px;font-weight:750;letter-spacing:.12em}}
h1{{margin:9px 0 10px;font-size:clamp(30px,7vw,39px);letter-spacing:-.06em;line-height:1.15}}
p{{line-height:1.65;color:#64736d;margin:0 0 24px}}label{{display:block;font-size:14px;font-weight:700;margin:18px 0 8px}}
select,input,button{{width:100%;min-height:54px;border-radius:15px;font:inherit}}
select,input{{border:1.5px solid #d6ded6;background:white;color:#20342f;padding:0 14px}}
select:focus-visible,input:focus-visible,button:focus-visible{{outline:3px solid #9bc9a5;outline-offset:2px}}
button{{margin-top:25px;border:0;background:#225b49;color:white;font-weight:750;font-size:17px;cursor:pointer}}
button:hover{{background:#174637}}.error{{color:#9c2c2c;background:#fff0ef;padding:11px 13px;border-radius:12px}}
.foot{{margin-top:20px;color:#718078;font-size:12px;text-align:center}}
</style></head><body><main><div class="mark" aria-hidden="true">⌂</div><span class="eyebrow">一个熟悉的声音，从这里开始</span>
<h1>欢迎回到爸爸老师</h1><p>请用家庭管理员账号登录。成功后，这台设备会保持登录两周。</p>
{error_html}<form method="post" action="/login"><label for="profile_id">家庭账号</label>
<select id="profile_id" name="profile_id">{options}</select><label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">进入爸爸老师 →</button></form><div class="foot">只供你和家人使用</div></main></body></html>"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    require_primary_deployment()
    studio_auth.ensure_seeded()
    app.state.client = httpx.AsyncClient(base_url=UPSTREAM, timeout=None, trust_env=False)
    yield
    await app.state.client.aclose()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def _is_https(request: Request) -> bool:
    # Only the loopback tunnel proxy may supply the original protocol.
    peer = request.client.host if request.client else ""
    forwarded = request.headers.get("x-forwarded-proto", "").strip().lower()
    return request.url.scheme in {"https", "wss"} or (peer in {"127.0.0.1", "::1"} and forwarded == "https")


@app.middleware("http")
async def secure_gateway(request: Request, call_next):
    host = request.headers.get("host", "").split(":", 1)[0].lower()
    if host not in SAFE_HOSTS:
        return JSONResponse({"detail": "访问地址无效"}, status_code=400)
    started = time.perf_counter()
    if host == PUBLIC_HOST and not _is_https(request):
        # Fixed authority prevents Host/path-based open redirects.
        target = f"https://{PUBLIC_HOST}{request.url.path}"
        if request.url.query:
            target += "?" + request.url.query
        return RedirectResponse(target, status_code=308)
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "请从爸爸老师页面提交"}, status_code=403)
    path = request.url.path
    public = path in {"/login", "/gateway-health"}
    if not public and not _profile(request.cookies.get(studio_auth.COOKIE)):
        if path.startswith("/api/"):
            return JSONResponse({"detail": "请先登录"}, status_code=401)
        return RedirectResponse("/login", status_code=302)
    response = await call_next(request)
    response.headers["Server-Timing"] = f"gateway;dur={(time.perf_counter() - started) * 1000:.1f}"
    if host == PUBLIC_HOST:
        response.headers["Strict-Transport-Security"] = "max-age=86400"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(self)"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' blob: data: https://upload.wikimedia.org https://i.ytimg.com; media-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; "
        "frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'"
    )
    return response


@app.get("/gateway-health")
async def gateway_health(request: Request):
    try:
        response = await request.app.state.client.get("/health", timeout=3.0)
        upstream_ready = response.status_code == 200
    except httpx.HTTPError:
        upstream_ready = False
    return {"ok": True, "upstream_ready": upstream_ready}


@app.get("/login", response_class=HTMLResponse)
async def login_page():
    return HTMLResponse(_login_page())


@app.post("/login")
async def login(request: Request):
    fields = parse_qs((await request.body()).decode("utf-8", errors="replace"))
    profile_id = (fields.get("profile_id") or [""])[0].strip()
    password = (fields.get("password") or [""])[0]
    if profile_id not in ALLOWED_PROFILES:
        return HTMLResponse(_login_page("账号或密码不正确"), status_code=401)
    try:
        token = studio_auth.login(profile_id, password)
    except ValueError:
        return HTMLResponse(_login_page("账号或密码不正确"), status_code=401)
    try:
        state = await request.app.state.client.get("/api/parent/enrollment", timeout=2.0)
        enrolled = state.status_code == 200 and state.json().get("active") is True
    except (httpx.HTTPError, ValueError, TypeError):
        enrolled = False
    response = RedirectResponse("/" if enrolled else "/setup", status_code=303)
    secure = request.headers.get("host", "").split(":", 1)[0].lower() == PUBLIC_HOST or _is_https(request)
    response.set_cookie(
        studio_auth.COOKIE, token, httponly=True, samesite="lax", secure=secure,
        max_age=studio_auth.SESSION_DAYS * 86400, path="/",
    )
    return response


@app.post("/logout")
async def logout(request: Request):
    studio_auth.logout(request.cookies.get(studio_auth.COOKIE))
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(studio_auth.COOKIE, path="/")
    return response


@app.websocket("/ws/{path:path}")
async def websocket_proxy(websocket: WebSocket, path: str):
    host_header = websocket.headers.get("host", "")
    host = host_header.split(":", 1)[0].lower()
    origin = websocket.headers.get("origin")
    if (host not in SAFE_HOSTS or (host == PUBLIC_HOST and not _is_https(websocket))
            or (origin and urlsplit(origin).netloc != host_header)):
        await websocket.close(code=4403)
        return
    if not _profile(websocket.cookies.get(studio_auth.COOKIE)):
        await websocket.close(code=4401)
        return
    query = f"?{websocket.url.query}" if websocket.url.query else ""
    upstream_url = f"{UPSTREAM_WS}/ws/{path}{query}"
    try:
        async with websocket_connect(upstream_url, max_size=None) as upstream:
            await websocket.accept()

            async def client_to_upstream():
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        return
                    if message.get("bytes") is not None:
                        await upstream.send(message["bytes"])
                    elif message.get("text") is not None:
                        await upstream.send(message["text"])

            async def upstream_to_client():
                async for message in upstream:
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)

            tasks = {asyncio.create_task(client_to_upstream()), asyncio.create_task(upstream_to_client())}
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in pending:
                with suppress(asyncio.CancelledError):
                    await task
    except Exception:
        with suppress(Exception):
            await websocket.close(code=1013)


@app.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(request: Request, path: str):
    query = f"?{request.url.query}" if request.url.query else ""
    headers = {key: value for key, value in request.headers.items() if key.lower() not in HOP_HEADERS}
    headers["x-forwarded-host"] = request.headers.get("host", PUBLIC_HOST)
    headers["x-forwarded-proto"] = "https" if _is_https(request) else "http"
    upstream_request = request.app.state.client.build_request(
        request.method, f"/{path}{query}", headers=headers, content=await request.body(),
    )
    try:
        upstream = await request.app.state.client.send(upstream_request, stream=True)
    except httpx.HTTPError:
        return JSONResponse({"detail": "爸爸老师暂时离线，请稍后重试"}, status_code=503)
    response_headers = {
        key: value for key, value in upstream.headers.items()
        if key.lower() not in HOP_HEADERS and key.lower() not in {"content-length", "content-encoding"}
    }
    return StreamingResponse(
        upstream.aiter_raw(), status_code=upstream.status_code,
        headers=response_headers, background=BackgroundTask(upstream.aclose),
    )
