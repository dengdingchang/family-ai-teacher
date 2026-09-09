"""Small, source-visible media search for child-facing learning cards.

Only a normalized allowlisted topic leaves the laptop. Raw child speech, family
profile data, camera frames, and generated prompts never enter this service.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import re
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
    candidates = [(len(alias), topic) for topic, aliases in TOPIC_ALIASES.items()
                  for alias in aliases if alias.casefold() in normalized]
    candidates += [(len(topic), topic) for topic in EDUCATION_TOPICS if topic.casefold() in normalized]
    return max(candidates, default=(0, ""))[1]


@dataclass(frozen=True)
class MediaRequest:
    topic: str
    kind: str = "image"
    replay: bool = False
    generate_image: bool = False


def canonical_media_topic(subject: str) -> str:
    """Only a whole known subject may use the curated encyclopedia search."""
    value = str(subject or "").strip()
    aliases = [(alias, topic) for topic, names in TOPIC_ALIASES.items() for alias in names]
    aliases += [(topic, topic) for topic in EDUCATION_TOPICS]
    for alias, topic in sorted(aliases, key=lambda pair: (-len(pair[0]), pair[1])):
        if value in {alias, f"大{alias}", f"小{alias}"}:
            return topic
    return ""


def normalize_image_subject(subject: str) -> str:
    """Accept a bounded explicit subject, never a transcript or physical observation.

    Unknown subjects stay intact: a panda riding a bike is not a bike picture.
    This validates subject data, not permission to generate; callers must first
    establish an explicit display/drawing request.
    """
    value = " ".join(str(subject or "").split())
    if not value or len(value) > 80:
        return ""
    if re.search(r"^(?:再)?(?:看看|看一下|看一看|给我|帮我|打开|放大|展示)|家庭信息|家庭历史|聊天记录|对话历史|原话", value):
        return ""
    if re.search(r"(?:我|你|他|她|妈妈|爸爸)(?:说|讲|想|要|的)|为什么|怎么|是不是|有没有|看不到|看得见|手里|眼前|摄像头|镜头|家里的秘密", value):
        return ""
    if not re.fullmatch(r"[\w\u3400-\u9fff ·()（）'’-]+", value):
        return ""
    value = re.sub(r"^(?:一张|一个|一幅|一只)", "", value)
    value = re.sub(r"(?:的)?(?:图片|图画|插图|照片|视频|短片|影片|网页|链接|网站|图)$", "", value).strip()
    if not value or value in {"这个", "那个", "一下", "一眼", "什么", "东西", "衣服玩具", "我", "你", "他", "她"}:
        return ""
    if re.search(r"刚才|刚刚|之前|上一张|那张|这张", value):
        return ""
    canonical = canonical_media_topic(value)
    if "照片" in subject and not canonical:
        return ""  # No claimed private-person photo retrieval from a name.
    return canonical or value


def explicit_media_request(text: str) -> MediaRequest | None:
    """Recognize the child's current request, never rewrite their transcript.

    Search receives only exact canonical subjects; generation receives only the
    explicitly requested subject. A replay carries no
    claimed topic: only the browser knows which card is currently available.
    """
    if len(str(text or "")) > 400:
        return None
    normalized = re.sub(r"(?<=[\u3400-\u9fff])\s+|\s+(?=[\u3400-\u9fff])", "", str(text or "").strip()).translate(str.maketrans({
        "圖": "图", "給": "给", "師": "师", "張": "张", "個": "个", "開": "开",
        "剛": "刚", "來": "来", "幫": "帮", "視": "视", "頻": "频", "現": "现",
        "說": "说", "講": "讲", "還": "还", "這": "这", "換": "换", "聽": "听",
        "畫": "画", "為": "为", "讓": "让",
    }))
    normalized = re.sub(r"“[^”]*”|‘[^’]*’|\"[^\"]*\"", "", normalized)
    request = None
    reported = False
    for clause in re.split(r"[，,。！？!?；;]", normalized):
        if re.search(r"(?:说|讲|问)(?:过|了)?[：:]?$", clause):
            reported = True
            continue
        if clause.startswith(("但是", "不过", "现在")):
            reported = False
        if reported:
            continue
        clause = re.sub(r"^(?:爸爸老师|爸爸|老师|请|现在|但是|不过|然后|那|能不能|可以|能)+", "", clause)
        if re.search(r"不想|不要|不看|别看|别画|不用|不需要|算了|取消|关闭", clause):
            request = None
            continue
        if re.search(r"昨天|以前|上次|如果|假如|等会|明天|之后|以后", clause):
            continue
        match = re.fullmatch(
            r"(?:我(?:想要|想|要)(?:再)?(?:看(?:看|一看|一下)?|看一眼)|"
            r"(?:再)?(?:给我|帮我)(?:再)?(?:看(?:看|一看|一下)?|打开|找(?:一张|个)?|展示)|"
            r"(?:再)?(?:打开|放大|展示|看看|看一下|看一看))(.{1,90}?)(?:好不好|好吗|可以吗|吧|呀|啊|呢|吗)?", clause,
        )
        draw = re.fullmatch(r"(?:(?:给我|请你|你|帮我)|(?:我想请你|我想让你))?(?:画一张|画一个|画一幅|画幅|画出|生成一张|做一张)(.{1,90}?)(?:吧|呀|啊|好吗|可以吗)?", clause)
        draw = draw or re.fullmatch(r"(?:给我|帮我)(?:画|生成|做)(.{1,90}?)(?:吧|呀|啊|好吗|可以吗)?", clause)
        draw = draw or re.fullmatch(r"(?:我想要|我要)(?:一张|一个|一幅)?(.{1,90}(?:图片|图画|插图|照片))(?:吧|呀|啊)?", clause)
        if not (match or draw):
            if re.match(r"(?:我想|我要|我们|一起|给我|教我|带我)(?:要)?(?:听|学|画|玩|唱|下)", clause):
                request = None
            continue
        subject = (match or draw).group(1)
        if re.search(r"(?:我|你|他|她|妈妈|爸爸)(?:说|讲|想|要|的)|为什么|怎么|是不是|有没有|看不到|看得见|手里", subject):
            continue
        kind = "video" if re.search(r"视频|短片|影片", subject) else "link" if re.search(r"网页|链接|网站", subject) else "image"
        if re.fullmatch(r"(?:(?:刚才|刚刚|之前)(?:的)?(?:那|这)?|那|这|上一)(?:一)?(?:张|个)?(?:图片|图画|图|照片|视频|短片|影片)", subject):
            request = MediaRequest("", kind, replay=True)
            continue
        topic = normalize_image_subject(subject)
        request = MediaRequest(topic, kind, generate_image=kind == "image") if topic else None
    return request


class TrustedMediaSearch:
    def __init__(self, fetch_json: Callable[[str], dict[str, Any]] | None = None) -> None:
        self._fetch_json = fetch_json or self._fetch

    @staticmethod
    def _fetch(url: str) -> dict[str, Any]:
        # This Windows device reaches public learning sources through its existing
        # HTTPS proxy. The URL is still a fixed Wikipedia endpoint built only from
        # canonical topics; raw child speech and family data stay local.
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

    def _display_thumbnail(self, page: str, summary: dict[str, Any]) -> str:
        thumbnail = summary.get("thumbnail") or {}
        fallback = trusted_https_url(thumbnail.get("source"))
        width, height = thumbnail.get("width"), thumbnail.get("height")
        if not fallback or type(width) is not int or type(height) is not int or max(width, height) >= 960:
            return fallback
        # PageImages supports a maximum thumbnail dimension. Do not rewrite a
        # Wikimedia URL or pull an unbounded original merely to fill the screen.
        endpoint = "https://zh.wikipedia.org/w/api.php?" + urlencode({
            "action": "query", "format": "json", "prop": "pageimages", "titles": page,
            "piprop": "thumbnail", "pithumbsize": 1280, "formatversion": 2,
        })
        try:
            pages = (self._fetch_json(endpoint).get("query") or {}).get("pages") or []
            for item in pages[:1]:
                candidate = item.get("thumbnail") or {}
                w, h = candidate.get("width"), candidate.get("height")
                url = trusted_https_url(candidate.get("source"))
                if (url and type(w) is int and type(h) is int and min(w, h) > 0
                        and max(w, h) <= 1280 and max(w, h) > max(width, height)):
                    return url
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            pass
        return fallback

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
            thumbnail = self._display_thumbnail(page, payload)
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
