from __future__ import annotations

import asyncio
import io
import json
import tempfile
import time
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import app.main as main_module
from avatar.protocol import state_for_energy
from app.main import (
    _activity_turn_reply,
    _compact_assistant_text,
    _early_spoken_chunk,
    _ensure_guided_reply,
    _explicit_lesson_reply,
    _local_knowledge_reply,
    _offline_safe_reply,
    _parent_message_reply,
    _spoken_chunks,
    _system_prompt,
    _teaching_turn_complete,
)
from camera.adapter import BrowserCameraAdapter, CameraAdapterError
from llm.client import OpenAICompatibleClient
from llm.client import LLMError
from memory.store import MemoryStore
from audio.metrics import unavailable_gpu_measurement
from tts.adapter import TTSAdapterError, TTSResult
from tts.persistent import PersistentNathanTTSAdapter
from tts.remote import FallbackNathanTTSAdapter


class MvpUnitTests(unittest.TestCase):
    def test_counting_requires_order_and_exact_answer(self) -> None:
        state = {"status": "active", "activity": "numbers", "step": 1}
        with patch.object(main_module, "_current_activity_state", return_value=state):
            for text in ("三二一", "321", "我不会一二三"):
                reply, transition = _activity_turn_reply(text, {})
                self.assertEqual(transition["step"], 1)
                self.assertNotIn("数得真稳", reply)
            for text in ("一、二、三", "1，2，3"):
                _, transition = _activity_turn_reply(text, {})
                self.assertEqual(transition["step"], 2)
        with patch.object(main_module, "_current_activity_state", return_value={**state, "step": 2}):
            for text in ("十三", "13", "不是三", "三还是四"):
                reply, transition = _activity_turn_reply(text, {})
                self.assertEqual(transition["step"], 2)
                self.assertNotIn("答对", reply)
            reply, transition = _activity_turn_reply("一共三根", {})
            self.assertEqual(transition["action"], "clear")
            self.assertNotIn("学会", reply)

    def test_negative_interest_does_not_become_positive_memory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "template.json"
            template.write_text('{}', encoding="utf-8")
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            for _ in range(3):
                result = store.observe_turn("我不喜欢恐龙", "我们可以换一个话题。")
                self.assertEqual(result["memory_candidates"], [])
            result = store.observe_turn("我不喜欢恐龙，但是我喜欢太空", "我们聊太空。")
            interests = [item for item in result["memory_candidates"] if item["category"] == "interest"]
            self.assertTrue(interests)
            self.assertFalse(any("恐龙" in item.get("tags", []) for item in interests))

    def test_activity_control_respects_switch_refusal_and_break(self) -> None:
        profile = {"name": "小宝", "enabled_activities": ["story", "drawing", "game"]}
        state = {"status": "active", "activity": "numbers", "step": 1}
        with patch.object(main_module, "_current_activity_state", return_value=state):
            for text in ("我不想屬,我想換一個遊戲", "我想换个游戏", "我要選遊戲"):
                reply, transition = _activity_turn_reply(text, profile)
                self.assertEqual(transition["activity"], "game", text)
                self.assertIn("找颜色", reply)
            for text in ("不想听故事", "我不想學英語"):
                reply, transition = _activity_turn_reply(text, profile)
                self.assertEqual(transition["action"], "clear", text)
                self.assertNotIn("Apple", reply)
                self.assertNotIn("迷路", reply)
            reply, transition = _activity_turn_reply("我想休息一下", profile)
            self.assertEqual(transition["action"], "clear")
            self.assertIn("先休息", reply)
            self.assertNotIn("？", reply)
            reply, transition = _activity_turn_reply("不想听故事，我想画画", profile)
            self.assertEqual(transition["activity"], "drawing")

    def test_numbers_self_report_offers_challenge_without_claiming_mastery(self) -> None:
        state = {"status": "active", "activity": "numbers", "step": 1}
        with patch.object(main_module, "_current_activity_state", return_value=state):
            for text in ("这个太简单了我会", "這個太簡單了", "可以难一点吗"):
                reply, transition = _activity_turn_reply(text, {})
                self.assertEqual(transition["step"], 3)
                self.assertIn("三块", reply)
                self.assertNotIn("学会", reply)
        with patch.object(main_module, "_current_activity_state", return_value={**state, "step": 3}):
            reply, transition = _activity_turn_reply("四", {})
            self.assertEqual(transition["step"], 3)
            self.assertNotIn("答对", reply)
            reply, transition = _activity_turn_reply("五", {})
            self.assertEqual(transition["action"], "clear")
            self.assertIn("是五个", reply)

    def test_compact_reply_keeps_two_sentences(self) -> None:
        self.assertEqual(
            _compact_assistant_text("先认识 Hello。你愿意跟我说一次吗？第三句不该出现。"),
            "先认识 Hello。你愿意跟我说一次吗？",
        )

    def test_shallow_reply_becomes_an_active_english_turn(self) -> None:
        reply = _ensure_guided_reply("我想学英语", "好。")
        self.assertIn("Hello", reply)
        self.assertTrue(reply.endswith("？"))
        self.assertNotEqual(reply, "好。")
        self.assertIn("Hello", _ensure_guided_reply("我想学英语", "好呀。你想学什么？"))
        self.assertIn("一、二、三", _ensure_guided_reply("我想学数字", "你想学什么？"))

    def test_generic_praise_keeps_the_useful_question_but_becomes_specific(self) -> None:
        self.assertEqual(
            _ensure_guided_reply("爸爸老师，我今天搭了一个很高的积木塔。", "真厉害！塔有几层？"),
            "你把积木塔搭得好高！塔有几层？",
        )

    def test_teaching_turn_waits_for_action_and_question(self) -> None:
        self.assertFalse(_teaching_turn_complete("好。"))
        self.assertTrue(_teaching_turn_complete("我们先学 Hello。你愿意说一次吗？"))

    def test_spoken_chunks_are_complete_and_never_repeat_text(self) -> None:
        reply = "我们先学 Hello。你愿意跟我说一次吗？"
        chunks = _spoken_chunks(reply)
        self.assertEqual(chunks, ["我们先学 Hello。", "你愿意跟我说一次吗？"])
        self.assertEqual("".join(chunks), reply)
        self.assertEqual(_spoken_chunks("好。你想学什么？"), ["好。你想学什么？"])
        named = "小宝，Apple 是苹果。跟我说一次 Apple，好吗？"
        self.assertEqual(
            _spoken_chunks(named, "小宝"),
            ["小宝，", "Apple 是苹果。", "跟我说一次 Apple，好吗？"],
        )
        self.assertEqual("".join(_spoken_chunks(named, "小宝")), named)

    def test_early_chunk_requires_a_real_teaching_statement(self) -> None:
        self.assertEqual(_early_spoken_chunk("伸出三根手指，这是三。下一句"), "伸出三根手指，这是三。")
        self.assertEqual(_early_spoken_chunk("好。"), "")
        self.assertEqual(_early_spoken_chunk("你想学什么？"), "")

    def test_guided_question_matches_the_taught_word(self) -> None:
        self.assertEqual(
            _ensure_guided_reply("我想学英语", "我们先说 Apple。"),
            "我们先说 Apple。你愿意跟我说一次 Apple 吗？",
        )
        self.assertEqual(
            _ensure_guided_reply("我想学英语", "说 Apple。你愿意跟我说 Hello 吗？"),
            "说 Apple。你愿意跟我说一次 Apple 吗？",
        )
        self.assertEqual(
            _ensure_guided_reply("我想学英语", "说Apple。你愿意跟我说 Hello 吗？"),
            "说Apple。你愿意跟我说一次 Apple 吗？",
        )

    def test_explicit_lesson_starts_without_waiting_for_open_ended_llm(self) -> None:
        self.assertIn("Apple", _explicit_lesson_reply("我想学英语"))
        self.assertIn("一、二、三", _explicit_lesson_reply("我想学数字"))
        self.assertIn("小狗", _explicit_lesson_reply("我想认识一种动物"))
        self.assertEqual(_explicit_lesson_reply("我不想学英语"), "")

    def test_short_child_activity_requests_get_coherent_openings(self) -> None:
        profile = {"name": "小宝", "enabled_activities": ["drawing", "story", "music"]}
        for request, expected in (
            ("故事", "还是"),
            ("我想画画", "太阳还是气球"),
            ("我想听音乐", "啦、啦、啦"),
        ):
            reply, transition = _activity_turn_reply(request, profile)
            self.assertIn(expected, reply)
            self.assertEqual(transition["action"], "set")

    def test_parent_configured_nickname_reaches_prompt_and_local_voice(self) -> None:
        profile = {
            "name": "小宝",
            "age": 4,
            "teacher_style": "warm_guided",
            "learning_goals": [],
            "content_boundaries": [],
            "enabled_activities": ["drawing", "story"],
        }
        reply = _explicit_lesson_reply("爸爸老师，带我一起画画吧。", profile)
        self.assertTrue(reply.startswith("先画一个大圆形。"))
        self.assertIn("大圆形", reply)
        prompt = _system_prompt(profile, [], [], {"skills": []}, {}, None)
        self.assertIn("孩子常用昵称：小宝", prompt)
        self.assertIn("连续对话不要每轮叫昵称", prompt)
        self.assertIn("不要把它硬当成故事角色或答案", prompt)
        self.assertIn("不要制造情感依赖", prompt)
        self.assertIn("马上找身边可信任的大人", prompt)
        parent_reply = _parent_message_reply(
            {"text": "告诉宝宝爸爸很想他。"},
            profile,
        )
        self.assertEqual(parent_reply, "小宝，爸爸很想你。你想对爸爸说什么？")
        named_parent_reply = _parent_message_reply(
            {"text": "今天告诉小宝，爸爸很想他。"},
            profile,
        )
        self.assertEqual(named_parent_reply, parent_reply)
        self.assertEqual(
            _parent_message_reply({"text": "问一下他今天幼儿园开心吗"}, profile),
            "小宝，爸爸想知道你今天在幼儿园开心吗？愿意告诉爸爸一件最开心的事吗？",
        )
        self.assertEqual(
            _parent_message_reply({"text": "请提醒小宝喝水"}, profile),
            "小宝，爸爸提醒你喝几口水。做好了告诉我一声，好吗？",
        )
        self.assertEqual(
            _parent_message_reply({"text": "今天可以陪他画一架飞机"}, profile),
            "小宝，爸爸想让我们今天一起画一架飞机。先画机身还是翅膀？",
        )

    def test_mac_profile_change_is_immediate_and_queues_local_voice_warmup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(json.dumps({"name": "小宝", "age": 4}, ensure_ascii=False), encoding="utf-8")
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            background = main_module.BackgroundTasks()
            with patch.object(main_module, "memory", store), patch.object(main_module, "_prewarm_nickname") as warm:
                profile = asyncio.run(
                    main_module.update_child_profile(
                        main_module.ProfileUpdateRequest(name="小宝宝贝"),
                        background,
                    )
                )
                self.assertEqual(profile["name"], "小宝宝贝")
                self.assertIn("孩子常用昵称：小宝宝贝", _system_prompt(profile, [], [], {"skills": []}, {}, None))
                asyncio.run(background())
                warm.assert_called_once_with("小宝宝贝")

    def test_story_start_phrase_is_not_mistaken_for_a_character(self) -> None:
        with patch.object(
            main_module,
            "_current_activity_state",
            return_value={"status": "active", "activity": "story", "step": 1},
        ):
            reply, transition = _activity_turn_reply("开始吧", {"name": "小宝"})
        self.assertIn("小狗还是小恐龙", reply)
        self.assertNotIn("遇见了开始", reply)
        self.assertEqual(transition["step"], 1)

    def test_model_independent_activity_continues_and_switches_topics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(
                json.dumps({"name": "小宝", "age": 4}, ensure_ascii=False),
                encoding="utf-8",
            )
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            with patch.object(main_module, "memory", store):
                profile = store.get_child_profile()
                reply, transition = _activity_turn_reply("我想学英语", profile)
                self.assertTrue(reply.startswith("Apple 是苹果。"))
                self.assertEqual(store.get_activity_state()["status"], "idle")
                main_module._record_turn("我想学英语", reply, activity_transition=transition)
                self.assertEqual(store.get_activity_state()["activity"], "english")
                self.assertEqual(store.get_activity_state()["step"], 1)

                reply, transition = _activity_turn_reply("Apple", profile)
                self.assertIn("Red", reply)
                self.assertNotIn("小宝", reply)
                main_module._record_turn("Apple", reply, activity_transition=transition)
                self.assertEqual(store.get_activity_state()["step"], 2)

                reply, transition = _activity_turn_reply("我不想学这个了，我想听故事", profile)
                self.assertIn("小企鹅", reply)
                main_module._record_turn("我不想学这个了，我想听故事", reply, activity_transition=transition)
                self.assertEqual(store.get_activity_state()["activity"], "story")
                self.assertEqual(store.get_parent_dashboard()["current_activity"]["activity"], "story")
                self.assertEqual(store.export_bundle()["current_activity"]["activity"], "story")

                reply, transition = _activity_turn_reply("找海豹帮忙", profile)
                self.assertIn("海豹", reply)
                self.assertNotIn("我猜是", reply)
                main_module._record_turn("找海豹帮忙", reply, activity_transition=transition)
                self.assertEqual(store.get_activity_state()["step"], 2)

    def test_welcome_back_uses_only_evidence_backed_continuity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(json.dumps({"name": "小宝", "age": 4}, ensure_ascii=False), encoding="utf-8")
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            store.save_session_turn("我想学恐龙", "恐龙很久以前生活在地球上。")
            with patch.object(main_module, "memory", store):
                reply, transition = _activity_turn_reply("爸爸老师，我回来了", store.get_child_profile())
                self.assertIn("小宝", reply)
                self.assertIn("上次聊到恐龙", reply)
                self.assertEqual(transition["activity"], "animals")
                main_module._record_turn("爸爸老师，我回来了", reply, activity_transition=transition)

                reply, transition = _activity_turn_reply("可以呀", store.get_child_profile())
                self.assertIn("小狗或恐龙", reply)
                self.assertNotIn("小宝", reply)
                self.assertEqual(transition["activity"], "animals")

                store.apply_activity_transition({"action": "clear"})

                store.add_memory("最近很喜欢太空", category="interest", status="durable", tags=["太空"])
                reply, _ = _activity_turn_reply("我回来啦", store.get_child_profile())
                self.assertIn("我记得你喜欢太空", reply)

    def test_parent_activity_control_and_offline_reply_stay_child_friendly(self) -> None:
        profile = {"enabled_activities": ["drawing"]}
        self.assertIn("今天先休息", _explicit_lesson_reply("给我讲一个故事", profile))
        self.assertIn("没看清", _offline_safe_reply("爸爸你看看我画的", profile))
        prompt = _system_prompt(
            {
                "age": 5,
                "teacher_style": "calm",
                "learning_goals": ["表达感受"],
                "content_boundaries": ["不讲吓人的故事"],
                "enabled_activities": ["drawing"],
            },
            [],
            [],
            {"skills": []},
            {},
            None,
        )
        self.assertIn("孩子年龄：5 岁", prompt)
        self.assertIn("语气平静", prompt)
        self.assertIn("不讲吓人的故事", prompt)

    def test_english_topic_does_not_drift_to_a_chinese_only_reply(self) -> None:
        reply = _ensure_guided_reply("我想学英语", "看，这是苹果。你想吃吗？")
        self.assertIn("Hello", reply)

    def test_preschool_knowledge_answers_are_direct_and_guided(self) -> None:
        profile = {"name": "小宝"}
        examples = (
            ("为什么月亮一直跟着我走？", "很远", "窗边"),
            ("恐龙为什么灭绝了？", "陨石", "哪种恐龙"),
            ("鱼在水里为什么不会淹死？", "鳃", "一张一合"),
            ("天空为什么是蓝色的？", "蓝色的光", "最蓝"),
            ("为什么会下雨？", "小水滴", "听起来"),
        )
        for question, fact, invitation in examples:
            reply = _local_knowledge_reply(question, profile)
            self.assertFalse(reply.startswith("小宝，"))
            self.assertIn(fact, reply)
            self.assertIn(invitation, reply)
            self.assertTrue(reply.endswith("？"))

    def test_science_reply_starts_with_content_while_greetings_keep_nicknames(self) -> None:
        profile = {"name": "测试宝", "enabled_activities": ["drawing", "story"]}
        state = {"status": "active", "activity": "drawing", "step": 2, "topic": "恐龙"}
        with patch.object(main_module, "_current_activity_state", return_value=state):
            reply, transition = _activity_turn_reply("为什么月亮会跟着我走？", profile)
        expected = "月亮离我们很远。走动时它看起来像在跟着你，要去窗边看看吗？"
        self.assertEqual(reply, expected)
        self.assertIsNone(transition)
        self.assertEqual(_spoken_chunks(reply, "测试宝"), [
            "月亮离我们很远。", "走动时它看起来像在跟着你，要去窗边看看吗？",
        ])
        self.assertTrue(_explicit_lesson_reply("带我一起画画吧", profile).startswith("先画一个大圆形。"))
        self.assertTrue(_parent_message_reply({"text": "告诉宝宝爸爸想他。"}, profile).startswith("测试宝，"))
        with patch.object(main_module, "memory", SimpleNamespace(get_continuity_cue=lambda: {"kind": "none"})):
            self.assertTrue(main_module._welcome_back_reply(profile).startswith("测试宝，"))

    def test_vision_requests_keep_a_separate_timeout_budget(self) -> None:
        settings = SimpleNamespace(
            llm_configured=True,
            llm_model="test-model",
            llm_api_key="test-key",
            llm_base_url="http://127.0.0.1:1",
            llm_timeout_seconds=8.0,
            llm_vision_timeout_seconds=25.0,
        )
        client = OpenAICompatibleClient(settings)
        with patch.object(
            client,
            "chat",
            return_value=SimpleNamespace(text="看见一只小熊", elapsed_s=0.01),
        ) as chat_mock:
            result = client.describe_images([(b"image-bytes", "image/jpeg")], "看见了什么？")
        self.assertEqual(result.text, "看见一只小熊")
        self.assertEqual(chat_mock.call_args.kwargs["timeout_seconds"], 25.0)

    def test_tts_prewarm_batches_two_phrases_and_reuses_ram_cache(self) -> None:
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(16000)
            wav_file.writeframes(b"\0\0" * 160)
        audio = output.getvalue()
        adapter = PersistentNathanTTSAdapter(SimpleNamespace(tts_ready=True))

        def fake_batch(texts: list[str]) -> list[tuple[bytes, float]]:
            return [(audio, 0.01) for _ in texts]

        with patch.object(adapter, "_request_batch", side_effect=fake_batch) as batch_mock:
            self.assertEqual(adapter.prewarm(["第一句。", "第二句。", "第三句。"]), 3)
            self.assertEqual([call.args[0] for call in batch_mock.call_args_list], [["第一句。", "第二句。"], ["第三句。"]])
            self.assertEqual(adapter.cache_entries, 3)
            self.assertEqual(adapter.prewarm(["第一句。", "第二句。"]), 0)
            self.assertEqual(batch_mock.call_count, 2)

    def test_remote_prewarm_caches_ack_without_loading_local_fallback(self) -> None:
        class FakePrimary:
            ready = True
            calls: list[str] = []
            discarded: list[str] = []

            @classmethod
            def synthesize(cls, text: str, **_kwargs) -> TTSResult:
                cls.calls.append(text)
                return TTSResult(
                    audio_bytes=b"remote-opus",
                    duration_s=0.4,
                    elapsed_s=1.2,
                    gpu=unavailable_gpu_measurement(),
                    backend="self-host",
                    audio_mime="audio/webm",
                    avatar_cue_id="temporary-cue",
                )

            @classmethod
            def discard_avatar(cls, result: TTSResult) -> None:
                cls.discarded.append(result.avatar_cue_id)

        class FailIfLoadedFallback:
            ready = True
            calls = 0

            @classmethod
            def synthesize(cls, *_args, **_kwargs) -> TTSResult:
                cls.calls += 1
                raise AssertionError("local fallback must not load during remote prewarm")

        adapter = FallbackNathanTTSAdapter(FakePrimary(), FailIfLoadedFallback())
        self.assertEqual(adapter.prewarm([" 嗯，我听见啦。 ", "嗯，我听见啦。"]), 1)
        self.assertEqual(adapter.prewarm(["嗯，我听见啦。"]), 0)
        self.assertTrue(adapter.is_cached("嗯，我听见啦。"))
        self.assertEqual(adapter.cache_entries, 1)
        self.assertEqual(adapter.last_backend, "self-host-cache")

        result = adapter.synthesize("嗯，我听见啦。")
        self.assertEqual(result.backend, "self-host-cache")
        self.assertEqual(result.elapsed_s, 0.0)
        self.assertEqual(result.avatar_cue_id, "")
        self.assertFalse(result.avatar_cued)
        self.assertEqual(FakePrimary.calls, ["嗯，我听见啦。"])
        self.assertEqual(FakePrimary.discarded, ["temporary-cue"])
        self.assertEqual(FailIfLoadedFallback.calls, 0)

    def test_remote_failure_falls_back_once_without_retrying_child_silence(self) -> None:
        class FailingPrimary:
            ready = True
            calls = 0

            @classmethod
            def synthesize(cls, *_args, **_kwargs) -> TTSResult:
                cls.calls += 1
                raise TTSAdapterError("remote timeout")

        class WorkingFallback:
            ready = True
            calls = 0

            @classmethod
            def synthesize(cls, *_args, **_kwargs) -> TTSResult:
                cls.calls += 1
                return TTSResult(
                    audio_bytes=b"local-wav",
                    duration_s=0.2,
                    elapsed_s=0.1,
                    gpu=unavailable_gpu_measurement(),
                    backend="local",
                )

        adapter = FallbackNathanTTSAdapter(FailingPrimary(), WorkingFallback())
        result = adapter.synthesize("测试降级。")
        self.assertEqual(result.backend, "local")
        self.assertEqual(FailingPrimary.calls, 1)
        self.assertEqual(WorkingFallback.calls, 1)

    def test_activity_stream_starts_with_instruction_and_requires_playback_receipt(self) -> None:
        class InstructionTts:
            def __init__(self):
                self.spoken = []

            def synthesize_stream(self, text, **_kwargs):
                self.spoken.append(text)
                wav_bytes = io.BytesIO()
                with wave.open(wav_bytes, "wb") as wav:
                    wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                    wav.writeframes(b"\0\0" * 1600)
                yield TTSResult(audio_bytes=wav_bytes.getvalue(), duration_s=0.1,
                                elapsed_s=0.01, gpu=unavailable_gpu_measurement(), backend="test")

        async def collect(text, turn_id):
            events = []
            async for chunk in main_module._stream_conversation(text, turn_id=turn_id, audio_streaming=True):
                events.extend(json.loads(line[6:]) for line in chunk.splitlines() if line.startswith("data: "))
            return events

        cases = (
            ("我想画一只恐龙", "我们画恐龙，先画长长的椭圆身体。"),
            ("我想听一个恐龙故事", "小恐龙在森林里发现了一串脚印。"),
            ("我想学数字", "我们从十一接着数：十一、十二、十三。"),
        )
        for index, (request, first_instruction) in enumerate(cases):
            with self.subTest(request=request), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                template = root / "profile.example.json"
                template.write_text(json.dumps({"name": "测试宝", "age": 4}, ensure_ascii=False), encoding="utf-8")
                store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
                voice = InstructionTts()
                skills = {"skills": [{"id": "math.count_1_10", "status": "mastered"}]}
                turn_id = f"instruction-first-{index}"
                with patch.object(main_module, "memory", store), patch.object(main_module, "tts", voice), patch.object(store, "get_skill_graph", return_value=skills):
                    events = asyncio.run(collect(request, turn_id))
                    try:
                        audio = [item for item in events if item.get("event") == "audio"]
                        done = next(item for item in events if item.get("event") == "done")
                        self.assertTrue(done["ok"], events)
                        self.assertEqual(voice.spoken[0], first_instruction)
                        self.assertTrue(audio[0]["semantic"])
                        self.assertTrue(all(item["semantic"] for item in audio))
                        self.assertEqual("".join(voice.spoken), done["assistant_text"])
                        self.assertTrue(done["assistant_text"].endswith("？"))
                        self.assertTrue(done["ok"] and done["commit_required"])
                        self.assertEqual(store.get_history(), [])
                        self.assertEqual(store.get_activity_state()["status"], "idle")
                    finally:
                        asyncio.run(main_module.cancel_streaming_turn(turn_id))
                    self.assertEqual(store.get_history(), [])

    def test_cached_nickname_prevents_redundant_acknowledgement(self) -> None:
        class AckFirstTts:
            spoken: list[str] = []

            @staticmethod
            def is_cached(text: str) -> bool:
                return text in {main_module.ACKNOWLEDGEMENT_TEXT, "小宝，"}

            @classmethod
            def synthesize(cls, text: str, **_kwargs):
                cls.spoken.append(text)
                gpu = SimpleNamespace(available=False, start_mib=None, peak_mib=None, end_mib=None, sample_count=0)
                return SimpleNamespace(
                    audio_bytes=b"test-audio",
                    audio_mime="audio/ogg",
                    duration_s=0.1,
                    elapsed_s=0.0,
                    backend="test-memory",
                    gpu=gpu,
                    avatar_cued=False,
                    avatar_audio_lead_ms=0,
                )

        async def collect() -> list[dict]:
            result = []
            # Welcomes retain the cached nickname, while requested activities
            # start with their teaching content.
            async for chunk in main_module._stream_conversation("我回来了"):
                for line in chunk.splitlines():
                    if line.startswith("data: "):
                        result.append(json.loads(line[6:]))
            return result

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(json.dumps({"name": "小宝", "age": 4}, ensure_ascii=False), encoding="utf-8")
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            with patch.object(main_module, "tts", AckFirstTts()), patch.object(main_module, "memory", store):
                events = asyncio.run(collect())
        audio = [item for item in events if item.get("event") == "audio"]
        self.assertFalse(audio[0].get("acknowledgement", False))
        self.assertFalse(any(item.get("acknowledgement", False) for item in audio))
        self.assertEqual(AckFirstTts.spoken[0], "小宝，")
        self.assertNotIn(main_module.ACKNOWLEDGEMENT_TEXT, AckFirstTts.spoken)
        self.assertTrue(next(item for item in events if item.get("event") == "done")["ok"])

    def test_slow_remote_first_sentence_gets_one_cached_acknowledgement(self) -> None:
        class SlowLlm:
            configured = True

            @staticmethod
            def stream_chat(*_args, **_kwargs):
                time.sleep(0.04)
                yield "积木塔搭得很高。"
                yield "你数过有几层吗？"

        class CachedAckTts:
            @staticmethod
            def is_cached(text: str) -> bool:
                return text == main_module.ACKNOWLEDGEMENT_TEXT

            @staticmethod
            def synthesize(_text, **_kwargs):
                gpu = SimpleNamespace(available=False, start_mib=None, peak_mib=None, end_mib=None, sample_count=0)
                return SimpleNamespace(
                    audio_bytes=b"test-audio",
                    audio_mime="audio/ogg",
                    duration_s=0.1,
                    elapsed_s=0.0,
                    backend="test-memory",
                    gpu=gpu,
                    avatar_cued=False,
                    avatar_audio_lead_ms=0,
                )

        async def collect() -> list[dict]:
            result = []
            async for chunk in main_module._stream_conversation("我今天搭了一个很高的积木塔"):
                for line in chunk.splitlines():
                    if line.startswith("data: "):
                        result.append(json.loads(line[6:]))
            return result

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(json.dumps({"name": "小宝", "age": 4}, ensure_ascii=False), encoding="utf-8")
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            with (
                patch.object(main_module, "llm", SlowLlm()),
                patch.object(main_module, "tts", CachedAckTts()),
                patch.object(main_module, "memory", store),
                patch.object(main_module, "REMOTE_ACK_DELAY_S", 0.01),
            ):
                events = asyncio.run(collect())
        audio = [item for item in events if item.get("event") == "audio"]
        self.assertTrue(audio[0].get("acknowledgement"))
        self.assertEqual(sum(bool(item.get("acknowledgement")) for item in audio), 1)
        self.assertTrue(next(item for item in events if item.get("event") == "done")["ok"])

    def test_mouth_energy_has_three_states(self) -> None:
        self.assertEqual(state_for_energy(0.0), "closed")
        self.assertEqual(state_for_energy(0.05), "half")
        self.assertEqual(state_for_energy(0.2), "open")

    def test_camera_capture_is_ephemeral(self) -> None:
        result = BrowserCameraAdapter().capture_frame(b"\xff\xd8\xff" + b"x")
        self.assertTrue(result["captured"])
        self.assertFalse(result["persisted"])
        with self.assertRaises(CameraAdapterError):
            BrowserCameraAdapter().capture_frame(b"not-an-image")

    def test_openai_message_text_parser(self) -> None:
        payload = {"choices": [{"message": {"content": "短回答"}}]}
        self.assertEqual(OpenAICompatibleClient._extract_text(payload), "短回答")
        fallback = {"choices": [{"message": {"reasoning_content": "备用回答"}}]}
        self.assertEqual(OpenAICompatibleClient._extract_text(fallback), "备用回答")

    def test_memory_interfaces_write_text_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(json.dumps({"name": "", "age": 4}), encoding="utf-8")
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            self.assertEqual(store.get_child_profile()["age"], 4)
            store.save_session_turn("我想学恐龙", "恐龙是很久以前的动物。")
            store.save_learning_event("conversation", {"user_text": "我想学恐龙"})
            self.assertEqual(len(store.get_recent_context()), 1)
            self.assertEqual(len(store.get_history()), 1)
            self.assertEqual(store.get_history()[0]["assistant_text"], "恐龙是很久以前的动物。")
            self.assertNotIn("audio", (root / "data/events.jsonl").read_text(encoding="utf-8"))

    def test_structured_memory_skills_and_parent_messages_are_model_independent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(json.dumps({"name": "宝宝", "age": 4}), encoding="utf-8")
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            for _ in range(3):
                store.observe_turn("我想学恐龙", "恐龙很久以前生活在地球上。你猜它吃什么？")
            memories = store.get_memories()
            self.assertEqual(memories[0]["status"], "durable")
            self.assertEqual(memories[0]["occurrences"], 3)
            dinosaur_skill = next(skill for skill in store.get_skill_graph()["skills"] if skill["id"] == "english.animals")
            self.assertEqual(dinosaur_skill["status"], "practicing")
            message = store.add_parent_message("告诉宝宝爸爸很想他。")
            self.assertEqual(store.get_pending_parent_message()["id"], message["id"])
            with self.assertRaises(KeyError):
                store.mark_parent_message_delivered("wrong-id", "不应送达")
            store.mark_parent_message_delivered(message["id"], "爸爸说他很想你。")
            store.capture_parent_message_response("我也想爸爸。")
            self.assertEqual(store.get_parent_messages()[0]["status"], "responded")
            exported = store.export_bundle()
            self.assertFalse(exported["raw_media_included"])
            self.assertNotIn("audio", json.dumps(exported, ensure_ascii=False))

    def test_parent_controls_are_validated_and_model_independent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(json.dumps({"name": "", "age": 4}), encoding="utf-8")
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            profile = store.update_child_profile(
                {
                    "name": "宝宝",
                    "learning_goals": ["数到20"],
                    "daily_guidance": "  今天   练刷牙  ",
                    "daily_guidance_date": main_module.datetime.now().astimezone().date().isoformat(),
                    "teacher_style": "playful",
                    "content_boundaries": ["不讲吓人的故事"],
                    "enabled_activities": ["story", "unknown", "story"],
                    "brain_mode": "local_lessons_only",
                }
            )
            self.assertEqual(profile["enabled_activities"], ["story"])
            self.assertEqual(profile["brain_mode"], "local_lessons_only")
            self.assertEqual(store.export_bundle()["profile"]["learning_goals"], ["数到20"])
            self.assertEqual(profile["daily_guidance"], "今天 练刷牙")
            self.assertIn("爸爸今天希望自然引导的主题：今天 练刷牙", _system_prompt(
                profile, [], [], {"skills": []}, {}, None,
            ))
            stale = {**profile, "daily_guidance_date": "2000-01-01"}
            self.assertNotIn("爸爸今天希望自然引导的主题", _system_prompt(
                stale, [], [], {"skills": []}, {}, None,
            ))
            with self.assertRaises(ValueError):
                store.update_child_profile({"teacher_style": "strict"})
            with self.assertRaises(ValueError):
                store.update_child_profile({"daily_guidance_date": "09/09/2026"})

    def test_parent_data_deletion_is_confirmed_scoped_and_model_safe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            template = root / "profile.example.json"
            template.write_text(json.dumps({"name": "小宝", "age": 4}, ensure_ascii=False), encoding="utf-8")
            store = MemoryStore(data, data / "profile.json", data / "history.jsonl", data / "events.jsonl", template)
            store.get_child_profile()
            store.save_session_turn("你好", "你好呀")
            store.save_learning_event("activity", {"activity": "story"})
            store.add_memory("喜欢恐龙", status="durable")
            store.get_skill_graph()
            store.add_parent_message("爸爸想你")
            store.apply_activity_transition({"action": "set", "activity": "story", "step": 1})

            with patch.object(main_module, "memory", store):
                wrong = main_module.FamilyDataDeleteRequest(scopes=["history"], confirmation="错误")
                with self.assertRaises(main_module.HTTPException) as raised:
                    asyncio.run(main_module.delete_parent_data(wrong))
                self.assertEqual(raised.exception.status_code, 400)
                self.assertEqual(len(store.get_history()), 1)

                request = main_module.FamilyDataDeleteRequest(
                    scopes=["history", "learning_events", "activity"],
                    confirmation="小宝",
                )
                result = asyncio.run(main_module.delete_parent_data(request))
                self.assertTrue(result["ok"])
                self.assertEqual(store.get_history(), [])
                self.assertEqual(store.get_recent_learning_events(), [])
                self.assertEqual(store.get_activity_state()["status"], "idle")
                self.assertEqual(len(store.get_memories()), 1)
                self.assertEqual(len(store.get_parent_messages()), 1)

            with self.assertRaises(ValueError):
                store.delete_family_data(["unknown"])
            store.delete_family_data(["all"])
            for path in (
                store.profile_path,
                store.history_path,
                store.learning_events_path,
                store.memories_path,
                store.skills_path,
                store.parent_messages_path,
                store.activity_state_path,
            ):
                self.assertFalse(path.exists())

    def test_growth_journal_keeps_prior_weeks_and_structured_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            template = root / "profile.example.json"
            template.write_text(json.dumps({"name": "宝宝", "age": 4}), encoding="utf-8")
            history = data / "history.jsonl"
            events = data / "events.jsonl"
            history.write_text(
                "\n".join(
                    json.dumps(item, ensure_ascii=False)
                    for item in (
                        {"created_at": "2026-08-25T10:00:00+08:00", "user_text": "我不会数到十三", "assistant_text": "我们从十一开始数。"},
                        {"created_at": "2026-09-01T10:00:00+08:00", "user_text": "我第一次会说 Apple 了", "assistant_text": "Apple 是苹果。"},
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            events.write_text(
                json.dumps(
                    {"created_at": "2026-09-01T10:02:00+08:00", "event_type": "vision", "payload": {"description": "画了一只绿色恐龙"}},
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            (data / "memories.json").write_text(
                json.dumps(
                    [{"id": "m1", "created_at": "2026-09-01T10:01:00+08:00", "category": "episodic", "status": "durable", "summary": "第一次说出 Apple"}],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            store = MemoryStore(data, data / "profile.json", history, events, template)
            journals = {item["week"]: item for item in store.get_growth_journal()}
            self.assertIn("2026-W35", journals)
            self.assertIn("2026-W36", journals)
            self.assertIn("我不会数到十三", journals["2026-W35"]["difficulties"])
            self.assertIn("第一次说出 Apple", journals["2026-W36"]["milestones"])
            self.assertIn("画了一只绿色恐龙", journals["2026-W36"]["observations"])
            self.assertTrue(journals["2026-W36"]["learning_progress"])

    def test_streaming_voice_falls_back_when_ai_station_is_unavailable(self) -> None:
        class FailingLlm:
            configured = True
            calls = 0

            @classmethod
            def stream_chat(cls, *_args, **_kwargs):
                cls.calls += 1
                raise LLMError("temporary outage")

        class MemoryOnlyTts:
            @staticmethod
            def synthesize(_text, **_kwargs):
                gpu = SimpleNamespace(available=False, start_mib=None, peak_mib=None, end_mib=None, sample_count=0)
                return SimpleNamespace(
                    audio_bytes=b"test-audio",
                    audio_mime="audio/ogg",
                    duration_s=0.1,
                    elapsed_s=0.01,
                    backend="test-memory",
                    gpu=gpu,
                    avatar_cued=False,
                    avatar_audio_lead_ms=0,
                )

        async def collect() -> list[dict]:
            result = []
            async for chunk in main_module._stream_conversation("爸爸老师，今天我们聊什么呀？"):
                for line in chunk.splitlines():
                    if line.startswith("data: "):
                        result.append(json.loads(line[6:]))
            return result

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(json.dumps({"name": "宝宝", "age": 4}), encoding="utf-8")
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            with patch.object(main_module, "llm", FailingLlm()), patch.object(main_module, "tts", MemoryOnlyTts()), patch.object(main_module, "memory", store):
                events = asyncio.run(collect())
            self.assertTrue(any(item.get("event") == "audio" for item in events))
            done = next(item for item in events if item.get("event") == "done")
            self.assertTrue(done["ok"])
            self.assertIn("？", done["assistant_text"])
            self.assertEqual(FailingLlm.calls, 1)
            self.assertEqual(len(store.get_history()), 0)
            self.assertTrue(done["commit_required"])
            with patch.object(main_module, "memory", store):
                asyncio.run(main_module.complete_streaming_turn(done["turn_id"]))
            self.assertEqual(len(store.get_history()), 1)

    def test_parent_message_receipt_waits_for_audio_commit(self) -> None:
        class MemoryOnlyTts:
            @staticmethod
            def synthesize(_text, **_kwargs):
                gpu = SimpleNamespace(available=False, start_mib=None, peak_mib=None, end_mib=None, sample_count=0)
                return SimpleNamespace(
                    audio_bytes=b"test-audio",
                    audio_mime="audio/ogg",
                    duration_s=0.1,
                    elapsed_s=0.01,
                    backend="test-memory",
                    gpu=gpu,
                    avatar_cued=False,
                    avatar_audio_lead_ms=0,
                )

        async def collect(turn_id: str) -> list[dict]:
            result = []
            async for chunk in main_module._stream_conversation("爸爸老师，我来啦", turn_id=turn_id):
                for line in chunk.splitlines():
                    if line.startswith("data: "):
                        result.append(json.loads(line[6:]))
            return result

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(
                json.dumps({"name": "小宝", "age": 4, "brain_mode": "local_lessons_only"}, ensure_ascii=False),
                encoding="utf-8",
            )
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            message = store.add_parent_message("告诉宝宝爸爸很想他。")
            turn_id = "parent-message-turn-001"
            with patch.object(main_module, "tts", MemoryOnlyTts()), patch.object(main_module, "memory", store):
                with main_module._stream_turn_lock:
                    main_module._stream_turns.clear()
                events = asyncio.run(collect(turn_id))
                done = next(item for item in events if item.get("event") == "done")
                self.assertTrue(done["commit_required"])
                self.assertIn("小宝", done["assistant_text"])
                self.assertEqual(store.get_pending_parent_message()["id"], message["id"])
                self.assertEqual(len(store.get_history()), 0)
                asyncio.run(main_module.complete_streaming_turn(turn_id))
                self.assertIsNone(store.get_pending_parent_message())
                delivered = store.get_parent_messages()[0]
                self.assertEqual(delivered["status"], "delivered")
                self.assertEqual(delivered["delivered_in_reply"], done["assistant_text"])
                self.assertEqual(len(store.get_history()), 1)
                with main_module._stream_turn_lock:
                    main_module._stream_turns.clear()

    def test_activity_progress_waits_for_playback_and_cancel_discards_next_step(self) -> None:
        class MemoryOnlyTts:
            @staticmethod
            def synthesize(_text, **_kwargs):
                gpu = SimpleNamespace(available=False, start_mib=None, peak_mib=None, end_mib=None, sample_count=0)
                return SimpleNamespace(
                    audio_bytes=b"test-audio",
                    audio_mime="audio/ogg",
                    duration_s=0.1,
                    elapsed_s=0.01,
                    backend="test-memory",
                    gpu=gpu,
                    avatar_cued=False,
                    avatar_audio_lead_ms=0,
                )

        async def collect(text: str, turn_id: str) -> list[dict]:
            result = []
            async for chunk in main_module._stream_conversation(text, turn_id=turn_id):
                for line in chunk.splitlines():
                    if line.startswith("data: "):
                        result.append(json.loads(line[6:]))
            return result

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "profile.example.json"
            template.write_text(
                json.dumps({"name": "小宝", "age": 4, "brain_mode": "local_lessons_only"}, ensure_ascii=False),
                encoding="utf-8",
            )
            store = MemoryStore(root / "data", root / "data/profile.json", root / "data/history.jsonl", root / "data/events.jsonl", template)
            with patch.object(main_module, "tts", MemoryOnlyTts()), patch.object(main_module, "memory", store):
                with main_module._stream_turn_lock:
                    main_module._stream_turns.clear()
                first_turn = "activity-turn-start-001"
                events = asyncio.run(collect("我想学英语", first_turn))
                self.assertTrue(next(item for item in events if item.get("event") == "done")["commit_required"])
                self.assertEqual(store.get_activity_state()["status"], "idle")
                asyncio.run(main_module.complete_streaming_turn(first_turn))
                self.assertEqual(store.get_activity_state()["step"], 1)

                second_turn = "activity-turn-next-002"
                events = asyncio.run(collect("Apple", second_turn))
                self.assertIn("Red", next(item for item in events if item.get("event") == "done")["assistant_text"])
                self.assertEqual(store.get_activity_state()["step"], 1)
                asyncio.run(main_module.cancel_streaming_turn(second_turn))
                self.assertEqual(store.get_activity_state()["step"], 1)
                self.assertEqual(len(store.get_history()), 1)
                with main_module._stream_turn_lock:
                    main_module._stream_turns.clear()


if __name__ == "__main__":
    unittest.main()
