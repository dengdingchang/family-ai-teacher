"""Model settings tests use a synthetic Settings object and temporary .env only."""
from dataclasses import MISSING, fields, replace
import json
import os

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.model_settings import ConfigurationConflict, candidate_settings, public_settings, revision, save_settings
from llm.client import OpenAICompatibleClient, LLMError, LLMResult


@pytest.fixture
def model_settings(tmp_path):
    values = {}
    for field in fields(Settings):
        if field.default is not MISSING:
            values[field.name] = field.default
        elif "Path" in str(field.type):
            values[field.name] = tmp_path / "unused"
        elif field.type == "bool": values[field.name] = False
        elif field.type == "int": values[field.name] = 1
        elif field.type == "float": values[field.name] = 5.0
        else: values[field.name] = ""
    values.update(project_root=tmp_path, llm_provider="compatible", llm_base_url="http://127.0.0.1:9000/v1",
                  llm_api_key="fixture-old-secret", llm_model="fixture-model", llm_timeout_seconds=8.0,
                  imagegen_model="fixture-codex-agent", search_provider="codex",
                  imagegen_output_dir=tmp_path / "runtime" / "generated",
                  imagegen_jobs_dir=tmp_path / "runtime" / "jobs")
    return Settings(**values)


def test_public_config_never_contains_key(model_settings, tmp_path):
    payload = public_settings(model_settings, tmp_path / ".env")
    assert payload["api_key_configured"] is True
    assert "fixture-old-secret" not in json.dumps(payload)
    assert "api_key" not in payload


def test_blank_key_reuses_only_the_same_endpoint(model_settings):
    assert candidate_settings(model_settings, {"api_key": "", "model": "next-model"}).llm_api_key == "fixture-old-secret"
    with pytest.raises(ValueError, match="密钥"):
        candidate_settings(model_settings, {"base_url": "https://another.example/v1"})
    with pytest.raises(ValueError, match="密钥"):
        candidate_settings(model_settings, {"provider": "openai"})
    switched = candidate_settings(model_settings, {"provider": "openai", "api_key": "fixture-new-key", "search_provider": "openai"})
    assert switched.llm_base_url == "https://api.openai.com/v1"
    assert switched.llm_api_key == "fixture-new-key"


@pytest.mark.parametrize("change", [
    {"provider": "unknown"}, {"base_url": "https://user:secret@example.com/v1"},
    {"base_url": "https://example.com/v1?api_key=secret"}, {"base_url": "file:///C:/private"},
    {"model": "next\nINJECT=value"}, {"api_key": "secret\nINJECT=value"},
    {"timeout_seconds": float("nan")}, {"timeout_seconds": float("inf")},
    {"timeout_seconds": 0}, {"timeout_seconds": 31}, {"search_provider": "openai"},
])
def test_invalid_settings_fail_without_mutating_current_configuration(model_settings, change):
    with pytest.raises(ValueError): candidate_settings(model_settings, change)
    assert model_settings.llm_api_key == "fixture-old-secret"


def test_revision_atomic_save_preserves_unrelated_lines_and_updates_only_after_success(model_settings, tmp_path, monkeypatch):
    path = tmp_path / ".env"
    path.write_text('# existing\nSTT_MODEL_PATH="fixture/stt"\nLLM_MODEL="old"\nLLM_MODEL="duplicate"\n', encoding="utf8")
    for name in ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_TIMEOUT_SECONDS", "SEARCH_PROVIDER", "IMAGEGEN_PROVIDER"]:
        monkeypatch.setenv(name, "fixture-before-save")
    old_revision = revision(path)
    saved = save_settings(model_settings, {"revision": old_revision, "model": "next-model"}, path)
    assert saved.llm_model == "next-model"
    assert '# existing\nSTT_MODEL_PATH="fixture/stt"\n' in path.read_text(encoding="utf8")
    assert path.read_text().count("LLM_MODEL=") == 1
    assert revision(path) != old_revision
    assert os.environ["LLM_MODEL"] == "next-model"
    with pytest.raises(ConfigurationConflict): save_settings(saved, {"revision": old_revision, "model": "stale-model"}, path)
    assert os.environ["LLM_MODEL"] == "next-model"
    before_failure = path.read_bytes()
    def fail_replace(*args): raise OSError("fixture disk busy")
    monkeypatch.setattr("app.model_settings.os.replace", fail_replace)
    with pytest.raises(OSError): save_settings(saved, {"revision": revision(path), "model": "failed-model"}, path)
    assert path.read_bytes() == before_failure
    assert os.environ["LLM_MODEL"] == "next-model"
    assert not list(tmp_path.glob(".model-settings-*"))


@pytest.fixture
def model_client(model_settings, monkeypatch):
    import app.main as main
    monkeypatch.setattr(main, "settings", model_settings)
    monkeypatch.setattr(main, "llm", OpenAICompatibleClient(model_settings))
    client = TestClient(main.app, base_url="http://127.0.0.1:8760")
    yield client
    client.close()


@pytest.mark.parametrize("route,method", [("/api/parent/models", "get"), ("/api/parent/models", "post"), ("/api/parent/models/test", "post")])
@pytest.mark.parametrize("headers", [{"Origin": "https://evil.example"}, {"Origin": "http://127.0.0.1:9999"}, {"Sec-Fetch-Site": "cross-site"}, {"Host": "evil.example"}])
def test_cross_origin_model_operations_are_rejected_before_any_work(model_client, monkeypatch, route, method, headers):
    def no_work(*args): raise AssertionError("forbidden cross-origin work")
    monkeypatch.setattr("app.main.candidate_settings", no_work)
    monkeypatch.setattr("app.main.save_settings", no_work)
    response = getattr(model_client, method)(route, headers=headers)
    assert response.status_code == 403


def test_parent_test_uses_only_connection_probe_and_does_not_save_or_echo_secrets(model_client, model_settings, monkeypatch):
    calls = []
    def chat(self, messages, max_tokens):
        calls.append((self.settings.llm_api_key, messages, max_tokens))
        return LLMResult("连接成功", 0.01)
    monkeypatch.setattr(OpenAICompatibleClient, "chat", chat)
    response = model_client.post("/api/parent/models/test", json={"api_key": "fixture-test-secret"})
    assert response.status_code == 200
    assert calls == [("fixture-test-secret", [{"role": "user", "content": "只回复：连接成功"}], 40)]
    assert "fixture-test-secret" not in response.text
    assert not (model_settings.project_root / ".env").exists()


def test_parent_test_error_is_generic_and_never_echoes_server_secrets(model_client, monkeypatch):
    def chat(*args): raise LLMError("fixture-secret-in-provider-error")
    monkeypatch.setattr(OpenAICompatibleClient, "chat", chat)
    result = model_client.post("/api/parent/models/test", json={})
    assert result.status_code == 502
    assert "fixture-secret" not in result.text


def test_parent_save_switches_future_client_and_stale_revision_cannot_override_it(model_client, model_settings, monkeypatch):
    import app.main as main
    original_client = main.llm
    for name in ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_TIMEOUT_SECONDS", "SEARCH_PROVIDER", "IMAGEGEN_PROVIDER"]:
        monkeypatch.setenv(name, "fixture-before-save")
    old_revision = model_client.get("/api/parent/models").json()["revision"]
    saved = model_client.post("/api/parent/models", json={
        "revision": old_revision, "model": "new-fixture-model", "api_key": "fixture-new-key",
    })
    assert saved.status_code == 200
    assert saved.json()["model"] == "new-fixture-model"
    assert "fixture-new-key" not in saved.text
    assert main.llm.settings is main.settings
    assert main.llm.settings.llm_model == "new-fixture-model"
    assert original_client.settings.llm_model == "fixture-model"
    before = (model_settings.project_root / ".env").read_bytes()
    rejected = model_client.post("/api/parent/models", json={"revision": old_revision, "model": "stale-fixture-model"})
    assert rejected.status_code == 409
    assert (model_settings.project_root / ".env").read_bytes() == before
    assert main.llm.settings.llm_model == "new-fixture-model"


def test_openai_response_payload_preserves_history_and_explicit_in_memory_vision(model_settings):
    settings = replace(model_settings, llm_provider="openai", llm_base_url="https://api.openai.com/v1", llm_model="gpt-5-test")
    messages = [{"role": "system", "content": "fixture instruction"},
                {"role": "assistant", "content": "earlier fixture answer"},
                {"role": "user", "content": [{"type": "text", "text": "describe fixture"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,ZmFrZQ=="}}]}]
    endpoint, payload = OpenAICompatibleClient(settings)._request_payload(messages, 120, True)
    assert endpoint == "/responses"
    assert payload["store"] is False and payload["stream"] is True
    assert payload["input"][1] == messages[1]
    assert payload["input"][2]["content"] == [{"type": "input_text", "text": "describe fixture"}, {"type": "input_image", "image_url": "data:image/png;base64,ZmFrZQ=="}]
    assert "messages" not in payload and "temperature" not in payload
    assert OpenAICompatibleClient._extract_text({"output": [{"type": "reasoning", "summary": []}, {"type": "message", "content": [{"type": "output_text", "text": "连接成功"}]}]}) == "连接成功"


@pytest.mark.parametrize("event", ["response.failed", "response.incomplete"])
def test_openai_failed_or_truncated_stream_does_not_count_as_completed(model_settings, monkeypatch, event):
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def raise_for_status(self): pass
        def iter_lines(self):
            yield 'data: {"type":"response.output_text.delta","delta":"还没讲完"}'
            yield 'data: ' + json.dumps({"type": event, "response": {"status": event.split(".")[1]}})
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def stream(self, *args, **kwargs): return Response()
    monkeypatch.setattr("llm.client.httpx.Client", Client)
    settings = replace(model_settings, llm_provider="openai")
    stream = OpenAICompatibleClient(settings).stream_chat([{"role": "user", "content": "fixture"}])
    assert next(stream) == "还没讲完"
    with pytest.raises(LLMError): list(stream)


@pytest.mark.parametrize("payload", [[], {"output": [None]}, {"output": [{"type": "message", "content": None}]}])
def test_malformed_openai_model_response_becomes_safe_llm_error(model_settings, monkeypatch, payload):
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, **kwargs): return httpx.Response(200, json=payload, request=httpx.Request("POST", url))
    monkeypatch.setattr("llm.client.httpx.Client", Client)
    with pytest.raises(LLMError):
        OpenAICompatibleClient(replace(model_settings, llm_provider="openai")).chat([{"role": "user", "content": "fixture"}])


def test_image_provider_hot_swap_and_key_rotation_replace_manager_and_shutdown_only_old_one(model_client, monkeypatch):
    import app.main as main
    from types import SimpleNamespace
    for name in ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_TIMEOUT_SECONDS", "SEARCH_PROVIDER", "IMAGEGEN_PROVIDER"]:
        monkeypatch.setenv(name, "fixture-before-save")
    stopped, built = [], []
    old = SimpleNamespace(shutdown=lambda: stopped.append("initial"))
    monkeypatch.setattr(main, "image_generator", old)
    def build(config):
        identity = len(built)
        value = SimpleNamespace(shutdown=lambda: stopped.append(identity), config=config)
        built.append(value)
        return value
    monkeypatch.setattr(main, "_build_image_generator", build)
    def save(**values):
        values["revision"] = model_client.get("/api/parent/models").json()["revision"]
        result = model_client.post("/api/parent/models", json=values)
        assert result.status_code == 200, result.text
        assert "fixture-openai-key" not in result.text and "fixture-rotated-key" not in result.text
        return result
    save(provider="openai", api_key="fixture-openai-key", image_provider="openai")
    assert len(built) == 1 and stopped == ["initial"]
    assert main.image_generator is built[0]
    assert built[0].config.llm_api_key == "fixture-openai-key"
    save(model="different-fixture-model")
    assert len(built) == 1 and stopped == ["initial"]
    save(api_key="fixture-rotated-key")
    assert len(built) == 2 and stopped == ["initial", 0]
    assert main.image_generator is built[1]
    assert built[1].config.llm_api_key == "fixture-rotated-key"
    save(image_provider="codex")
    assert len(built) == 3 and stopped == ["initial", 0, 1]
    assert main.image_generator is built[2]


def test_image_api_startup_factory_never_uses_compatible_service_key(model_settings):
    import app.main as main
    invalid_combo = replace(model_settings, imagegen_provider="openai", llm_provider="compatible")
    manager = main._build_image_generator(invalid_combo)
    assert manager.configured is False
    assert manager.request("小熊")["status"] == "not_configured"


@pytest.mark.parametrize("frame", ["[]", "null", '{"choices":[null]}'])
def test_malformed_stream_event_is_a_safe_llm_error(model_settings, monkeypatch, frame):
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def raise_for_status(self): pass
        def iter_lines(self): yield "data: " + frame
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def stream(self, *args, **kwargs): return Response()
    monkeypatch.setattr("llm.client.httpx.Client", Client)
    with pytest.raises(LLMError):
        list(OpenAICompatibleClient(replace(model_settings, llm_provider="openai")).stream_chat([{"role": "user", "content": "fixture"}]))


def test_same_host_night_route_keeps_text_chat_when_day_port_is_down(model_settings, monkeypatch):
    settings = replace(model_settings, llm_fallback_base_url="http://127.0.0.1:9001/v1",
                       llm_fallback_model="fixture-lite")
    seen = []
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, **kwargs):
            seen.append((url, kwargs["json"]["model"]))
            if ":9000/" in url:
                raise httpx.ConnectError("offline", request=httpx.Request("POST", url))
            return httpx.Response(200, json={"choices": [{"message": {"content": "夜间还能聊"}}]},
                                  request=httpx.Request("POST", url))
    monkeypatch.setattr("llm.client.httpx.Client", Client)
    client = OpenAICompatibleClient(settings)
    assert client.chat([{"role": "user", "content": "你好"}]).text == "夜间还能聊"
    assert seen == [("http://127.0.0.1:9000/v1/chat/completions", "fixture-model"),
                    ("http://127.0.0.1:9001/v1/chat/completions", "fixture-lite")]
    assert len(client._routes([{"role": "user", "content": "你好"}])) == 2
    assert client._routes([{"role": "user", "content": [{"type": "image_url"}]}]) == [(settings.llm_base_url, settings.llm_model)]
    assert OpenAICompatibleClient(replace(settings, llm_base_url="http://other.example:9000/v1"))._routes([]) == [
        ("http://other.example:9000/v1", settings.llm_model)]


def test_night_route_streams_only_after_a_preoutput_failover(model_settings, monkeypatch):
    settings = replace(model_settings, llm_fallback_base_url="http://127.0.0.1:9001/v1",
                       llm_fallback_model="fixture-lite")
    seen = []
    class Response:
        def __init__(self, url): self.url = url
        def __enter__(self):
            if ":9000/" in self.url:
                raise httpx.ConnectError("offline", request=httpx.Request("POST", self.url))
            return self
        def __exit__(self, *args): pass
        def raise_for_status(self): pass
        def iter_lines(self): yield 'data: {"choices":[{"delta":{"content":"夜间回答"}}]}'
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def stream(self, _, url, **kwargs):
            seen.append((url, kwargs["json"]["model"]))
            return Response(url)
    monkeypatch.setattr("llm.client.httpx.Client", Client)
    assert list(OpenAICompatibleClient(settings).stream_chat([{"role": "user", "content": "你好"}])) == ["夜间回答"]
    assert [model for _, model in seen] == ["fixture-model", "fixture-lite"]
