"""Public search adapters are isolated from credentials, history, and real network."""
from dataclasses import replace
import json
import queue
from pathlib import Path

import httpx
import pytest

import app.web_search as search_module
from app.web_search import PublicLearningSearch, cards_from_results, public_url
from test_model_settings import model_settings


@pytest.mark.parametrize("url", ["http://pbskids.org/a", "https://pbskids.org.evil.example/a", "https://user:secret@pbskids.org/a", "https://pbskids.org:9999/a", "https://pbskids.org:bad/a", "https://127.0.0.1/a", "javascript:alert(1)"])
def test_public_links_reject_untrusted_or_credentialed_urls(url):
    assert public_url(url) == ""


def test_cards_preserve_subject_and_limit_deduplicate_real_video_identifiers():
    rows = [{"url": "https://www.youtube.com/watch?v=AcYCMJvdupI", "title": "fixture brushing"},
            {"url": "https://www.youtube.com/watch?v=AcYCMJvdupI"},
            {"url": "https://pbskids.org/games/music", "title": "Music"},
            {"url": "https://evil.example/path"}, None]
    cards = cards_from_results("钢琴", rows)
    assert len(cards) == 2
    assert all(card["topic"] == "钢琴" for card in cards)
    assert cards[0]["kind"] == "video" and cards[0]["thumbnail_url"].endswith("AcYCMJvdupI/hqdefault.jpg")
    assert cards[1]["kind"] == "link" and not cards[1]["thumbnail_url"]


def fake_http(monkeypatch, payload, calls):
    class Client:
        def __init__(self, **kwargs): calls.append({"client": kwargs})
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, **kwargs):
            calls.append({"url": url, **kwargs})
            return httpx.Response(200, json=payload, request=httpx.Request("POST", url))
    monkeypatch.setattr(search_module.httpx, "Client", Client)


def test_openai_search_uses_real_tool_sources_not_prose_and_sends_only_explicit_subject(model_settings, monkeypatch):
    settings = replace(model_settings, llm_provider="openai", search_provider="openai", llm_api_key="fixture-search-key")
    payload = {"output": [{"type": "message", "content": [{"type": "output_text", "text": "https://pbskids.org/invented-path"}]},
                          {"type": "web_search_call", "status": "completed", "action": {"sources": [{"url": "https://pbskids.org/games/music", "title": "Music"}]}}]}
    calls = []
    fake_http(monkeypatch, payload, calls)
    result = PublicLearningSearch().search("滑翔机", "link", settings)
    assert result["online_search"] is True
    assert [card["url"] for card in result["cards"]] == ["https://pbskids.org/games/music"]
    request = calls[1]
    assert request["url"] == "https://api.openai.com/v1/responses"
    assert request["headers"]["Authorization"] == "Bearer fixture-search-key"
    assert request["json"]["store"] is False
    assert request["json"]["tool_choice"] == "required"
    assert request["json"]["tools"][0]["type"] == "web_search"
    assert request["json"]["input"].endswith(json.dumps("滑翔机", ensure_ascii=False))
    assert "fixture-search-key" not in json.dumps(request["json"])
    assert not any(key in request["json"] for key in ["history", "images", "audio", "conversation"])


def test_prose_without_a_search_call_cannot_be_reported_as_online_search(model_settings, monkeypatch):
    calls = []
    fake_http(monkeypatch, {"output": [{"type": "message", "content": [{"type": "output_text", "text": "https://pbskids.org/music"}]}]}, calls)
    settings = replace(model_settings, llm_provider="openai", search_provider="openai")
    result = PublicLearningSearch().search("钢琴", "link", settings)
    assert result["online_search"] is False and result["cards"] == []


def test_failed_search_tool_is_not_evidence_of_successful_online_search(model_settings, monkeypatch):
    payload = {"output": [{"type": "web_search_call", "status": "failed", "action": {"sources": [{"url": "https://pbskids.org/games/music"}]}}]}
    fake_http(monkeypatch, payload, [])
    result = PublicLearningSearch().search("钢琴", "link", replace(model_settings, llm_provider="openai", search_provider="openai"))
    assert result["online_search"] is False and result["cards"] == []


@pytest.mark.parametrize("payload", [None, [], {"output": None}, {"output": [None]}, {"output": [{"type": "web_search_call", "action": None}]}])
def test_malformed_public_search_response_fails_locally_without_crashing_request(model_settings, monkeypatch, payload):
    fake_http(monkeypatch, payload, [])
    settings = replace(model_settings, llm_provider="openai", search_provider="openai")
    result = PublicLearningSearch().search("钢琴", "link", settings)
    assert result["online_search"] is False
    assert result["cards"] == []


def test_cache_is_scoped_to_topic_kind_provider_and_model_and_off_is_immediate(model_settings, monkeypatch):
    calls = []
    def codex(settings, prompt):
        calls.append((settings.imagegen_model, prompt))
        return [{"url": "https://pbskids.org/games/music", "title": "Music"}]
    monkeypatch.setattr(search_module, "_codex_search", codex)
    adapter = PublicLearningSearch()
    first = adapter.search("钢琴", "link", model_settings)
    assert adapter.search("钢琴", "link", model_settings)["cached"] is True
    adapter.search("城堡", "link", model_settings)
    adapter.search("钢琴", "video", model_settings)
    adapter.search("钢琴", "link", replace(model_settings, imagegen_model="different-fixture-model"))
    assert len(calls) == 4
    off = adapter.search("钢琴", "link", replace(model_settings, search_provider="off"))
    assert off["reason"] == "search_disabled" and not off["cards"]
    assert first["cards"][0]["topic"] == "钢琴"


@pytest.mark.parametrize("searched", [True, False])
def test_codex_search_requires_tool_evidence_and_disables_local_tools(model_settings, monkeypatch, searched):
    messages, launches = [], []
    class Process:
        def __init__(self, command, **kwargs):
            launches.append((command, kwargs)); self.pid = 100; self.closed = False
            self.output = queue.Queue(); self.stdin = self.stdout = self
        def write(self, text):
            message = json.loads(text); messages.append(message)
            result = {"config": {"mcp_servers": {"private_connector": {}}, "plugins": {"private_plugin": {}}}} if message["method"] == "config/read" else {"thread": {"id": "fixture-thread"}} if message["method"] == "thread/start" else {}
            self.output.put(json.dumps({"id": message["id"], "result": result}) + "\n")
            if message["method"] == "turn/start":
                events = []
                if searched: events.append({"method": "item/completed", "params": {"item": {"type": "webSearch"}}})
                events.extend([{"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": json.dumps({"results": [{"url": "https://pbskids.org/games/music", "title": "Music"}]})}}},
                               {"method": "turn/completed", "params": {"turn": {"status": "completed"}}}])
                for event in events: self.output.put(json.dumps(event) + "\n")
        def __iter__(self):
            while True:
                value = self.output.get(timeout=2)
                if not value: return
                yield value
        def flush(self): pass
        def close(self): self.closed = True; self.output.put("")
        def poll(self): return 0 if self.closed else None
        def terminate(self): self.close()
        def wait(self, timeout): return 0
    class Owner:
        def __init__(self, process): pass
        def close_and_wait(self): return True
    monkeypatch.setattr(search_module.subprocess, "Popen", Process)
    monkeypatch.setattr(search_module, "_WindowsProcessJob", Owner)
    result = PublicLearningSearch().search("滑翔机", "link", model_settings)
    assert result["online_search"] is searched
    thread = next(item["params"] for item in messages if item["method"] == "thread/start")
    assert thread["ephemeral"] is True and thread["sandbox"] == "read-only"
    assert thread["config"]["web_search"] == "live"
    assert thread["config"]["features.shell_tool"] is False
    assert thread["config"]["mcp_servers.private_connector.enabled"] is False
    assert thread["config"]["plugins.private_plugin.enabled"] is False
    assert "fixture-old-secret" not in json.dumps(launches, default=str)
    assert "fixture-old-secret" not in json.dumps(messages)
    assert not list((model_settings.project_root / "runtime" / "public-search").glob("search-*"))
