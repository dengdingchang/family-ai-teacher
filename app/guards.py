"""Same-origin guards for parent-only actions.

Phones on the home network, the LAN address and the preview proxy all rewrite
``Host``, so the browser's own ``Sec-Fetch-Site`` verdict is the reliable
signal; an Origin/Host comparison remains for older browsers and loopback
tools such as curl.
"""

from __future__ import annotations

from fastapi import HTTPException, Request


def _same_origin_request(request: Request) -> bool:
    """True when a parent action comes from a page of this same app.

    Phones, the LAN address and the preview proxy all rewrite ``Host``, so the
    browser's own ``Sec-Fetch-Site: same-origin`` verdict is the reliable
    signal there; the Origin/Host comparison remains for older browsers and
    loopback tools such as curl.
    """

    from urllib.parse import urlsplit

    if request.headers.get("sec-fetch-site") == "cross-site":
        return False
    origin = (request.headers.get("origin") or "").rstrip("/")
    if not origin:
        if request.client and request.client.host in {"127.0.0.1", "::1"}:
            return True
        return request.url.hostname in {"127.0.0.1", "localhost", "::1"}
    parsed = urlsplit(origin)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    hosts = {request.headers.get("host", "").strip().lower()}
    forwarded = request.headers.get("x-forwarded-host", "").split(",")[0].strip().lower()
    if forwarded:
        hosts.add(forwarded)
    if parsed.netloc.lower() in hosts:
        return True
    return request.headers.get("sec-fetch-site") == "same-origin"


def _require_local_settings_request(request: Request) -> None:
    if not _same_origin_request(request):
        raise HTTPException(status_code=403, detail="设置只接受家长空间的同源页面操作")


def _require_enrollment_request(request: Request) -> None:
    # A custom header blocks ordinary cross-site forms; Origin rejects hostile JS.
    if request.headers.get("x-family-enroll") != "1":
        raise HTTPException(status_code=403, detail="请从家长录制引导页面操作")
    if not _same_origin_request(request):
        raise HTTPException(status_code=403, detail="录制只接受同源页面操作")
