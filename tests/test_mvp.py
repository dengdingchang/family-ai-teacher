from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from avatar.protocol import state_for_energy
from camera.adapter import BrowserCameraAdapter, CameraAdapterError
from llm.client import OpenAICompatibleClient
from memory.store import MemoryStore


class MvpUnitTests(unittest.TestCase):
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
            self.assertNotIn("audio", (root / "data/events.jsonl").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
