"""Bound repeated remote questions without guessing a child's transcription."""
import re


class RepeatedQuestionGuard:
    def __init__(self, messages: list[dict]):
        recent = [str(item.get("content", "")) for item in messages if item.get("role") == "assistant"][-2:]
        user = next((str(item.get("content", "")) for item in reversed(messages) if item.get("role") == "user"), "")
        requested_repeat = re.search(r"再问(?:我)?一次|(?:重复|再说|再讲)(?:一遍|一次)|没听清(?:题|问题)", user)
        rejected_repeat = re.search(r"不要|别|不用|不想", user)
        questions = [self.question(item) for item in recent]
        self.repeated = (questions[0] if len(questions) == 2 and questions[0] and questions[0] == questions[1]
                         and not (requested_repeat and not rejected_repeat) else "")

    @staticmethod
    def question(text: str) -> str:
        questions = re.findall(r"[^。！？!?；;]+[？?]", text)
        if not questions:
            return ""
        question = re.sub(r"[\s，,、：:？?]", "", questions[-1]).casefold()
        question = re.sub(r"^(?:那么|那|所以|现在|请问)", "", question)
        return question if len(question) >= 5 else ""

    def replacement(self, reply: str) -> str:
        if self.repeated and self.question(reply) == self.repeated:
            return "刚才的问题我们先放一放。你可以换个说法，也可以告诉我想玩什么。"
        return ""
