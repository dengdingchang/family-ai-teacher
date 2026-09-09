"""Small, source-visible media search for child-facing learning cards.

Only a normalized allowlisted topic leaves the laptop. Raw child speech, family
profile data, camera frames, and generated prompts never enter this service.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Callable
from urllib.parse import quote, urlencode, urlparse

import httpx


TRUSTED_HOSTS = (
    "wikipedia.org",
    "wikimedia.org",
    "youtube.com",
    "youtu.be",
    "ytimg.com",
    "cdc.gov",
    "mouthhealthy.org",
)

TOPIC_PAGES = {
    "刷牙": "刷牙",
    "牙齿": "牙齒",
    "恐龙": "恐龍",
    "月亮": "月球",
    "太空": "外太空",
    "鱼": "魚",
    "钢琴": "鋼琴",
    "红绿灯": "交通號誌",
}

TOPIC_ALIASES = {
    "刷牙": ("刷牙", "牙刷", "牙齿", "牙齒"),
    "恐龙": ("恐龙", "恐龍", "霸王龙", "暴龍"),
    "月亮": ("月亮", "月球"),
    "太空": ("太空", "宇宙", "星球"),
    "鱼": ("鱼", "魚"),
    "钢琴": ("钢琴", "鋼琴", "琴键", "琴鍵"),
    "红绿灯": ("红绿灯", "紅綠燈", "交通灯", "交通燈"),
}

# A local, child-safe vocabulary prevents names, addresses, and arbitrary raw
# speech from becoming search terms. These are ordinary early-learning topics,
# not a claim that every Wikipedia result is suitable for unsupervised reading.
EDUCATION_TOPICS = (
    "蝴蝶", "蜜蜂", "熊猫", "长颈鹿", "大象", "海豚", "鲸鱼", "鲨鱼", "企鹅", "乌龟",
    "青蛙", "狮子", "老虎", "斑马", "袋鼠", "猫头鹰", "孔雀", "蜗牛", "蚂蚁", "瓢虫",
    "彩虹", "火山", "地震", "云朵", "闪电", "雪花", "太阳", "地球", "星星", "海洋",
    "森林", "沙漠", "河流", "瀑布", "山峰", "春天", "夏天", "秋天", "冬天", "太阳系",
    "木星", "火星", "土星", "火车", "飞机", "轮船", "汽车", "自行车", "直升机", "火箭",
    "小提琴", "吉他", "架子鼓", "长笛", "向日葵", "蒲公英", "苹果树", "水循环", "磁铁",
)

CURATED_CARDS = {
    "刷牙": (
        {
            "kind": "link",
            "title": "和大人一起学刷牙",
            "description": "每天两次，含氟牙膏只用豌豆大小。",
            "url": "https://www.cdc.gov/oral-health/prevention/oral-health-tips-for-children.html",
            "thumbnail_url": "",
            "source": "CDC",
        },
        {
            "kind": "video",
            "title": "跟芝麻街一起刷牙",
            "description": "点开看一段儿童刷牙歌。",
            "url": "https://www.youtube.com/watch?v=AcYCMJvdupI",
            "thumbnail_url": "https://i.ytimg.com/vi/AcYCMJvdupI/hqdefault.jpg",
            "source": "Sesame Street in Communities",
        },
    ),
}


@dataclass(frozen=True)
class MediaCard:
    kind: str
    title: str
    description: str
    url: str
    thumbnail_url: str
    source: str
    topic: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


def trusted_https_url(value: Any) -> str:
    candidate = str(value or "").strip()
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return ""
    host = (parsed.hostname or "").lower().rstrip(".")
    trusted = any(host == allowed or host.endswith(f".{allowed}") for allowed in TRUSTED_HOSTS)
    if parsed.scheme != "https" or not trusted or parsed.username or parsed.password:
        return ""
    if parsed.port not in {None, 443}:
        return ""
    return candidate


def match_topic(query: str) -> str:
    normalized = "".join(str(query or "").casefold().split())[:160]
    for topic, aliases in TOPIC_ALIASES.items():
        if any(alias.casefold() in normalized for alias in aliases):
            return topic
    for topic in EDUCATION_TOPICS:
        if topic.casefold() in normalized:
            return topic
    return ""


class TrustedMediaSearch:
    def __init__(self, fetch_json: Callable[[str], dict[str, Any]] | None = None) -> None:
        self._fetch_json = fetch_json or self._fetch

    @staticmethod
    def _fetch(url: str) -> dict[str, Any]:
        # This Windows device reaches public learning sources through its existing
        # HTTPS proxy. The URL is still a fixed Wikipedia endpoint built only from
        # the seven canonical topics; raw child speech and family data stay local.
        with httpx.Client(timeout=4.0, follow_redirects=False, trust_env=True) as client:
            response = client.get(url, headers={"User-Agent": "FamilyAITeacher/1.0 educational-media"})
            response.raise_for_status()
            value = response.json()
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _curated(topic: str) -> list[MediaCard]:
        cards: list[MediaCard] = []
        for item in CURATED_CARDS.get(topic, ()):
            url = trusted_https_url(item.get("url"))
            thumbnail = trusted_https_url(item.get("thumbnail_url"))
            if not url:
                continue
            cards.append(MediaCard(
                kind=str(item.get("kind", "link")),
                title=str(item.get("title", ""))[:60],
                description=str(item.get("description", ""))[:100],
                url=url,
                thumbnail_url=thumbnail,
                source=str(item.get("source", ""))[:40],
                topic=topic,
            ))
        return cards

    def _find_exact_page(self, topic: str) -> tuple[str, bool]:
        page = TOPIC_PAGES.get(topic)
        if page:
            return page, False
        endpoint = "https://zh.wikipedia.org/w/api.php?" + urlencode({
            "action": "query", "format": "json", "list": "search",
            "srsearch": topic, "srnamespace": 0, "srlimit": 3, "srwhat": "text", "utf8": 1,
        })
        payload = self._fetch_json(endpoint)
        results = ((payload.get("query") or {}).get("search") or [])
        for result in results[:3]:
            title = str((result or {}).get("title") or "").strip()
            if title.casefold() == topic.casefold():
                return title, True
        return "", True

    def search(self, query: str, limit: int = 3) -> dict[str, Any]:
        topic = match_topic(query)
        if not topic:
            return {"topic": "", "cards": [], "online_search": False,
                    "image_generation": "not_configured", "reason": "unsupported_topic"}
        cards = self._curated(topic)
        online_search = False
        reason = ""
        try:
            page, searched = self._find_exact_page(topic)
            online_search = searched
            if not page:
                return {"topic": topic, "cards": [card.to_dict() for card in cards],
                        "online_search": online_search, "image_generation": "not_configured",
                        "reason": "" if cards else "no_suitable_result"}
            endpoint = f"https://zh.wikipedia.org/api/rest_v1/page/summary/{quote(page, safe='')}"
            payload = self._fetch_json(endpoint)
            online_search = True
            page_url = trusted_https_url(((payload.get("content_urls") or {}).get("desktop") or {}).get("page"))
            thumbnail = trusted_https_url((payload.get("thumbnail") or {}).get("source"))
            title = str(payload.get("title") or topic).strip()[:60]
            description = str(payload.get("description") or payload.get("extract") or "").strip()[:100]
            if page_url and thumbnail:
                cards.insert(0, MediaCard(
                    kind="image", title=title, description=description,
                    url=page_url, thumbnail_url=thumbnail, source="Wikipedia / Wikimedia Commons", topic=topic,
                ))
        except (httpx.HTTPError, ValueError, TypeError):
            reason = "" if cards else "source_unavailable"
        if not cards and not reason:
            reason = "no_suitable_result"
        return {
            "topic": topic,
            "cards": [card.to_dict() for card in cards[:max(0, min(4, int(limit)))]],
            "online_search": online_search,
            "image_generation": "not_configured",
            "reason": reason,
        }
