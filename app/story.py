"""Small story plans and bounded narration; no new persisted schema or model."""

import re

# Titles live in the existing activity topic. History chooses the least recently
# heard plan; merely requesting/cancelling a story does not consume a plan.
STORIES = {
    "企鹅的冰桥": (
        "小企鹅要送一篮鱼，可是冰桥裂开了。你觉得该找海豹帮忙，还是一起造小船？",
        "小企鹅请海豹扶住木板，慢慢搭好小船。出发前要先检查船底还是急着跳上去？",
        "检查好船底，小企鹅安全送到了鱼。它也给海豹留了一条，分享让午餐更快乐。你想给小船起什么名字？",
    ),
    "火车的神秘包裹": (
        "小火车收到一个会沙沙响的包裹，收件地址被雨打湿了。它先去邮局还是问列车员？",
        "列车员找到包裹上的花朵标记，原来要送到花园站。路上遇到岔道，先看路牌还是猜方向？",
        "小火车照着路牌到了花园，包裹里是向日葵种子！大家种下一片小太阳。你想种什么花？",
    ),
    "海豚的音乐会": (
        "小海豚想办海底音乐会，可是章鱼的鼓不见了。先找贝壳做鼓，还是请朋友一起找？",
        "朋友们找到空贝壳，轻轻敲出咚咚声。小海豚想加一种声音，你选水泡声还是拍尾巴声？",
        "水泡和尾巴一起打着节拍，安静的小海马也加入了！每个朋友都有自己的声音。你想唱哪一句？",
    ),
    "机器人的雨天花园": (
        "小机器人第一次看见下雨，赶紧给每朵花撑伞。花需要雨水吗？我们去问园丁还是看看泥土？",
        "园丁说花也要喝水，小机器人收起小伞，把水洼旁的小蜗牛移到安全处。你想帮谁撑伞？",
        "雨停后，花朵抬起头，蜗牛留下亮亮的路。小机器人懂得先观察再帮忙。你给这座花园起什么名字？",
    ),
    "恐龙的风筝": (
        "小恐龙做了大风筝，跑了半天却飞不起来。它先检查尾巴，还是找朋友看看？",
        "朋友发现风筝少了一条尾巴，补好以后稳稳飞起来。你想给尾巴画圆点还是条纹？",
        "带花纹的风筝飞上蓝天，小恐龙把线轴交给朋友，两个人轮流玩。你想让风筝像什么？",
    ),
    "松鼠的树屋邮局": (
        "小松鼠在树屋开了邮局，第一封信没有写名字。它先看信封标记，还是问送信的喜鹊？",
        "喜鹊说信要送给爱种橡果的朋友。小松鼠看到刺猬的橡果篮，先敲门还是直接进去？",
        "小松鼠轻轻敲门，刺猬收到邀请信，约大家一起种树。小树也是送给明天的礼物。你想种在哪里？",
    ),
}


def choose_topic(recent, previous=""):
    history = " ".join(str(item.get("assistant_text", "")) for item in recent)
    def last_heard(title):
        # Match distinctive protagonists even when the remote narrator omits title.
        hero = STORIES[title][0].split("，")[0][:3]
        return max(history.rfind(hero), history.rfind(title)) if title != previous else len(history)
    return min(STORIES, key=last_heard)


def planned_reply(topic, step):
    lines = STORIES.get(topic)
    return lines[min(max(step - 1, 0), 2)] if lines else ""


def narration_messages(messages, fallback, transition):
    result = [dict(message) for message in messages]
    result[0]["content"] += (
        "\n本轮是共同讲故事。覆盖一般教学的52字限制：用两三句、最多110字讲一个具体小情节。"
        "直接回应孩子的想法，再推进情节；允许孩子改角色或结局，不把孩子当成答题机器。"
        "接着最近已讲的故事，保持角色、物品和因果一致。不是每次都小兔子、森林、迷路或星星。"
        "孩子说不清时给两个相关选项，绝不能把疑似识别碎片拼成角色名、地名或方向。"
        "孩子让你继续就自己往下讲。若孩子想学新内容，立即回应新内容。"
        "本轮参考计划（可结合孩子回答创作，不能机械照抄不相关选项）：" + fallback
        + (" 本轮收尾，可邀请孩子命名或分享，不再凭空开始下一段。" if transition.get("action") == "clear" else " 最后留一个容易选择的问题。")
    )
    return result


def clean_narration(text, fallback):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    text = re.sub(r"[\r\n#*`]+", "", text).strip()
    if not text or "<think>" in text:
        return fallback
    if len(text) > 130:
        sentences = re.findall(r".*?[。！？!?]", text[:130])
        text = "".join(sentences) or fallback
    return text
