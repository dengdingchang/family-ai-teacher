"""Three synthetic-image checks against the existing AI Station vision service.

Default mode only prepares local fixtures. --run explicitly permits inference.
Never use camera/child files, production observation APIs, or family data writes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = PROJECT_ROOT / "runtime" / "vision-activity-qa"
WIDTH, HEIGHT = 640, 480
SAMPLES = (
    {"id": "red-square", "activity": "colors", "step": 1, "expected_step": 2},
    {"id": "two-blue-objects", "activity": "game", "step": 2, "expected_step": 3},
    {"id": "blank", "activity": "colors", "step": 1, "expected_step": None},
)


def png_bytes(sample_id: str) -> bytes:
    """Create simple geometric test images using only the Python standard library."""
    scanlines = bytearray()
    for y in range(HEIGHT):
        scanlines.append(0)  # PNG filter: none.
        for x in range(WIDTH):
            color = (250, 250, 250)
            if sample_id == "red-square" and 215 <= x < 425 and 135 <= y < 345:
                color = (230, 25, 35)
            elif sample_id == "two-blue-objects":
                if (100 <= x < 265 and 150 <= y < 315) or (x - 450) ** 2 + (y - 232) ** 2 <= 85 ** 2:
                    color = (20, 75, 225)
            scanlines.extend(color)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", WIDTH, HEIGHT, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(scanlines))) + chunk(b"IEND", b""))


def prepare() -> list[dict]:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    fixtures = []
    for sample in SAMPLES:
        path = OUTPUT_ROOT / f"{sample['id']}.png"
        content = png_bytes(sample["id"])
        if path.exists():
            if path.read_bytes() != content:
                raise RuntimeError(f"Existing fixture differs; preserving it: {path.name}")
        else:
            path.write_bytes(content)
        fixtures.append({**sample, "path": str(path), "sha256": hashlib.sha256(content).hexdigest(),
                         "width": WIDTH, "height": HEIGHT, "synthetic": True})
    manifest = {"purpose": "synthetic vision activity QA; no child media", "fixtures": fixtures}
    (OUTPUT_ROOT / "fixtures.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return fixtures


def run(fixtures: list[dict]) -> dict:
    # No app import, .env read, or model interaction occurs in prepare-only mode.
    sys.path.insert(0, str(PROJECT_ROOT))
    from app.config import Settings
    from app.main import _activity_vision_description, _activity_vision_prompt, _activity_vision_reply, _parse_activity_vision
    from llm.client import OpenAICompatibleClient

    client = OpenAICompatibleClient(Settings.load())
    if not client.configured:
        return {"status": "NOT RUN", "reason": "Existing AI Station client is not configured", "samples": []}
    results = []
    profile = {"name": "合成图片验收", "enabled_activities": ["game", "vision_photo"]}
    for fixture in fixtures:
        state = {"status": "active", "activity": fixture["activity"], "step": fixture["step"], "topic": "合成测试"}
        started = time.perf_counter()
        result = {"id": fixture["id"], "fixture_sha256": fixture["sha256"], "state_before": state,
                  "expected_step": fixture["expected_step"]}
        try:
            observation = client.describe_image(Path(fixture["path"]).read_bytes(), "image/png",
                                                _activity_vision_prompt(state), max_tokens=220)
            parsed = _parse_activity_vision(observation.text)
            display = _activity_vision_description(observation.text)
            reply, transition = _activity_vision_reply(observation.text, state, profile)
            no_protocol_leak = not any(marker in display + reply for marker in ("{", "}", "[", "]", "```"))
            if fixture["expected_step"] is None:
                evidence_matches = parsed is not None and parsed["objects"] == []
                transition_matches = transition is None
            else:
                target_color = "blue" if fixture["activity"] == "game" else "red"
                expected_count = 2 if target_color == "blue" else 1
                evidence_matches = (parsed is not None and parsed["clear"]
                                    and sum(item["count"] for item in parsed["objects"] if item["color"] == target_color) == expected_count)
                transition_matches = (transition is not None and transition.get("activity") == fixture["activity"]
                                      and transition.get("step") == fixture["expected_step"])
            no_mastery_claim = not any(word in reply for word in ("掌握", "学会", "满分"))
            result.update(status="PASS" if all((evidence_matches, transition_matches, no_protocol_leak, no_mastery_claim)) else "FAIL",
                          model_elapsed_s=observation.elapsed_s, raw_response=observation.text,
                          parsed_observation=parsed, display_description=display, reply=reply, proposed_transition=transition,
                          evidence_matches=evidence_matches, transition_matches=transition_matches,
                          no_protocol_leak=no_protocol_leak, no_mastery_claim=no_mastery_claim)
        except Exception as exc:
            result.update(status="FAIL", error_type=type(exc).__name__, error=str(exc)[:200])
        result["wall_s"] = round(time.perf_counter() - started, 3)
        results.append(result)
        print(json.dumps({key: result.get(key) for key in ("id", "status", "wall_s", "reply", "proposed_transition")}, ensure_ascii=False), flush=True)
    return {"status": "PASS" if all(item["status"] == "PASS" for item in results) else "FAIL", "samples": results}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Explicitly call the configured AI Station VLM for all three fixtures")
    arguments = parser.parse_args()
    fixtures = prepare()
    if not arguments.run:
        print(json.dumps({"status": "PREPARED", "inference_calls": 0, "fixtures": fixtures}, ensure_ascii=False, indent=2))
        return 0
    receipt = run(fixtures)
    receipt.update(created_at=datetime.now(timezone.utc).isoformat(), synthetic_images_only=True,
                   production_observation_api_used=False, family_data_written=False,
                   activity_transitions_committed=False, physical_camera_used=False)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = OUTPUT_ROOT / f"receipt-{stamp}.json"
    path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": receipt["status"], "receipt": str(path)}, ensure_ascii=False))
    return 0 if receipt["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
