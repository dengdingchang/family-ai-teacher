"""Optional Images API protocol tests; all responses are synthetic local PNGs."""
import base64
import json
import threading

import httpx
import pytest

from app.image_generation import CodexImageGenerationManager, OPENAI_IMAGE_MODEL
from test_image_generation import make_manager, wait_for, write_png


def api_manager(tmp_path, **overrides):
    values = dict(enabled=True, provider="openai", api_key="fixture-api-secret",
                  codex_path="missing-codex-fixture", model="", skill_path=tmp_path / "missing-skill",
                  runtime_root=tmp_path, output_dir=tmp_path / "generated", jobs_dir=tmp_path / "jobs",
                  timeout_seconds=12)
    values.update(overrides)
    return CodexImageGenerationManager(**values)


def stub_http(monkeypatch, handler):
    original = httpx.Client
    clients = []
    def factory(**kwargs):
        clients.append(kwargs)
        return original(transport=httpx.MockTransport(handler), **kwargs)
    monkeypatch.setattr("app.image_generation.httpx.Client", factory)
    return clients


def image_payload(tmp_path, width=70):
    data = write_png(tmp_path / "fixture-input.png", width=width).read_bytes()
    return {"data": [{"b64_json": base64.b64encode(data).decode("ascii")} ]}


def test_api_provider_requires_only_explicit_key_and_not_codex_runtime(tmp_path, monkeypatch):
    assert api_manager(tmp_path).configured is True
    assert api_manager(tmp_path).transport == "openai-images-api"
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-ambient-key-must-not-be-used")
    for overrides in [{"api_key": ""}, {"enabled": False}, {"provider": "unknown"}, {"api_key": "secret\ninjection"}]:
        manager = api_manager(tmp_path, **overrides)
        assert manager.configured is False
        assert manager.request("小狐狸")["status"] == "not_configured"


def test_images_api_sends_only_explicit_subject_and_fixed_supported_schema(tmp_path, monkeypatch):
    requests = []
    payload = image_payload(tmp_path)
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=payload)
    clients = stub_http(monkeypatch, handler)
    manager = api_manager(tmp_path)
    try:
        result = wait_for(manager, manager.request("小狐狸骑单车")["job_id"], "completed")
        assert len(requests) == 1
        request = requests[0]
        body = json.loads(request.content)
        assert str(request.url) == "https://api.openai.com/v1/images/generations"
        assert request.headers["authorization"] == "Bearer fixture-api-secret"
        assert {name: body[name] for name in ["model", "n", "quality", "size", "output_format"]} == {
            "model": OPENAI_IMAGE_MODEL, "n": 1, "quality": "low", "size": "1024x1024", "output_format": "png"}
        assert json.loads(body["prompt"].splitlines()[-1]) == {"subject": "小狐狸骑单车"}
        assert set(body) == {"model", "prompt", "n", "quality", "size", "output_format"}
        assert clients == [{"timeout": 12, "trust_env": False, "follow_redirects": False}]
        assert "fixture-api-secret" not in json.dumps(result)
        assert result["card"]["topic"] == "小狐狸骑单车"
        filename = result["card"]["url"].rsplit("/", 1)[1]
        assert manager.safe_file(filename)
        manifest = json.loads((manager.output_dir / f"{filename}.json").read_text(encoding="utf8"))
        assert manifest["provider"] == "openai" and manifest["model"] == OPENAI_IMAGE_MODEL
        assert manifest["transport"] == "openai-images-api"
        assert manifest["input_scope"] == "explicit_image_subject"
        assert "fixture-api-secret" not in json.dumps(manifest)
    finally:
        manager.shutdown()


def test_same_subject_api_and_codex_never_share_cache_and_old_verified_cards_remain_readable(tmp_path, monkeypatch):
    codex = make_manager(tmp_path, lambda subject, job_dir: write_png(job_dir / "result.png", width=65))
    old = wait_for(codex, codex.request("熊猫")["job_id"], "completed")
    codex.shutdown()
    calls = []
    payload = image_payload(tmp_path, width=80)
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=payload)
    stub_http(monkeypatch, handler)
    manager = api_manager(tmp_path)
    try:
        new = wait_for(manager, manager.request("熊猫")["job_id"], "completed")
        assert new["card"]["url"] != old["card"]["url"]
        assert len(calls) == 1
        assert manager.request("熊猫")["card"] == new["card"]
        assert len(calls) == 1
        assert manager.safe_file(old["card"]["url"].rsplit("/", 1)[1])
        assert codex.safe_file(new["card"]["url"].rsplit("/", 1)[1])
    finally:
        manager.shutdown()


@pytest.mark.parametrize("payload", [[], {"data": None}, {"data": [None]}, {"data": [{"url": "https://example.com/not-fetched.png"}]},
                                    {"data": [{"b64_json": "not!base64"}]}, {"data": [{"b64_json": base64.b64encode(b"not a PNG" * 20).decode()}]}])
def test_malformed_image_result_is_not_published_and_never_falls_back_to_codex(tmp_path, monkeypatch, payload):
    stub_http(monkeypatch, lambda request: httpx.Response(200, json=payload))
    def no_codex(*args): raise AssertionError("API must not silently switch providers")
    monkeypatch.setattr(CodexImageGenerationManager, "_run_codex", no_codex)
    manager = api_manager(tmp_path)
    try:
        job = wait_for(manager, manager.request("小狐狸")["job_id"], "failed")
        assert "card" not in job
        assert not list(manager.output_dir.glob("*.png"))
        assert "fixture-api-secret" not in json.dumps(job)
    finally:
        manager.shutdown()


@pytest.mark.parametrize("status", [401, 403, 429, 500, 302])
def test_http_failure_and_redirect_do_not_publish_or_expose_error_body(tmp_path, monkeypatch, status):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, headers={"Location": "https://untrusted.example/redirect"}, text="fixture-api-secret")
    stub_http(monkeypatch, handler)
    manager = api_manager(tmp_path)
    try:
        failed = wait_for(manager, manager.request("火箭城堡")["job_id"], "failed")
        assert len(calls) == 1
        assert "fixture-api-secret" not in json.dumps(failed)
        assert "card" not in failed
    finally:
        manager.shutdown()


def test_cancelled_api_response_cannot_publish_when_it_finishes_later(tmp_path, monkeypatch):
    started, release = threading.Event(), threading.Event()
    payload = image_payload(tmp_path)
    def handler(request):
        started.set()
        assert release.wait(2)
        return httpx.Response(200, json=payload)
    stub_http(monkeypatch, handler)
    manager = api_manager(tmp_path)
    try:
        job = manager.request("太空里的狐狸")
        assert started.wait(2)
        assert manager.cancel(job["job_id"])["status"] == "cancelled"
        release.set()
    finally:
        release.set()
        manager.shutdown()
    assert manager.status(job["job_id"])["status"] == "cancelled"
    assert not (manager.output_dir / manager._filename(job["topic"])).exists()


def test_api_timeout_fails_without_publishing_or_provider_fallback(tmp_path, monkeypatch):
    def handler(request): raise httpx.ReadTimeout("fixture timeout")
    stub_http(monkeypatch, handler)
    manager = api_manager(tmp_path)
    try:
        failed = wait_for(manager, manager.request("发光城堡")["job_id"], "failed")
        assert "card" not in failed
        assert not list(manager.output_dir.glob("*.png"))
    finally:
        manager.shutdown()


def test_provider_retirement_cancels_running_and_queued_jobs_and_cannot_publish_late_result(tmp_path):
    started, release = threading.Event(), threading.Event()
    def runner(subject, directory):
        started.set()
        assert release.wait(2)
        return write_png(directory / "result.png")
    manager = make_manager(tmp_path, runner)
    first = manager.request("熊猫")
    assert started.wait(2)
    queued = manager.request("小狐狸")
    retiring = threading.Thread(target=manager.shutdown)
    try:
        retiring.start()
        assert manager._stop.wait(1)
        release.set()
        retiring.join(timeout=2)
        assert not retiring.is_alive()
        assert manager.status(first["job_id"])["status"] == "cancelled"
        assert manager.status(queued["job_id"])["status"] == "cancelled"
        assert not list(manager.output_dir.glob("*.png"))
        assert manager.request("发光城堡")["status"] not in {"queued", "running", "completed"}
    finally:
        release.set()
        manager.shutdown()
