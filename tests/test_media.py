from __future__ import annotations

from app.media import TrustedMediaSearch, match_topic, trusted_https_url


def test_only_allowlisted_topic_is_sent_to_real_source() -> None:
    requested = []

    def fetch(url: str):
        requested.append(url)
        return {
            "title": "恐龍",
            "description": "一类已经灭绝的爬行动物",
            "thumbnail": {"source": "https://upload.wikimedia.org/fixture.jpg"},
            "content_urls": {"desktop": {"page": "https://zh.wikipedia.org/wiki/%E6%81%90%E9%BE%8D"}},
        }

    result = TrustedMediaSearch(fetch).search("小宝刚才说：我想看霸王龙的图片")
    assert result["topic"] == "恐龙"
    assert requested and "%E6%81%90%E9%BE%8D" in requested[0]
    assert "小宝" not in requested[0]
    assert result["online_search"] is True
    assert result["cards"][0]["kind"] == "image"
    assert result["cards"][0]["source"] == "Wikipedia / Wikimedia Commons"


def test_unknown_or_unsafe_results_do_not_become_cards() -> None:
    assert match_topic("家里的秘密") == ""
    assert trusted_https_url("http://zh.wikipedia.org/wiki/test") == ""
    assert trusted_https_url("https://wikipedia.org.evil.example/test") == ""
    assert trusted_https_url("https://user:password@zh.wikipedia.org/test") == ""
    result = TrustedMediaSearch(lambda _: {
        "title": "月球",
        "thumbnail": {"source": "https://evil.example/image.jpg"},
        "content_urls": {"desktop": {"page": "https://evil.example/page"}},
    }).search("月亮")
    assert result["online_search"] is True
    assert result["cards"] == []


def test_curated_brushing_cards_are_exact_results_not_search_pages() -> None:
    result = TrustedMediaSearch(lambda _: {}).search("今天练刷牙")
    kinds = {card["kind"] for card in result["cards"]}
    assert {"link", "video"}.issubset(kinds)
    assert all("results?search_query=" not in card["url"] for card in result["cards"])
    assert any(card["source"] == "CDC" for card in result["cards"])
    assert any(card["source"] == "Sesame Street in Communities" for card in result["cards"])
    assert result["image_generation"] == "not_configured"
