"""Parent enrollment uses synthetic media and an isolated temporary data folder."""

import io
import asyncio
import importlib
import math
import struct
import wave

import pytest

from app.parent_enrollment import (
    EnrollmentError, ParentEnrollmentStore, check_portrait, check_voice,
    decode_media,
)


def synthetic_portrait(level=140):
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (640, 640), (level, level, level))
    draw = ImageDraw.Draw(image)
    draw.ellipse((170, 90, 470, 490), fill=(level + 20, level + 10, level))
    draw.ellipse((220, 250, 255, 285), fill=(40, 40, 40))
    draw.ellipse((385, 250, 420, 285), fill=(40, 40, 40))
    draw.arc((270, 300, 370, 390), 0, 180, fill=(45, 45, 45), width=12)
    draw.rectangle((120, 470, 520, 639), fill=(70, 95, 82))
    output = io.BytesIO()
    image.save(output, "JPEG", quality=88)
    return output.getvalue()


def synthetic_voice(amplitude=1800):
    rate = 16000
    samples = [int(amplitude * math.sin(2 * math.pi * 220 * n / rate))
               for n in range(rate * 8)]
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(struct.pack("<" + "h" * len(samples), *samples))
    return output.getvalue()


def mostly_silent_voice():
    rate = 16000
    samples = [int(1800 * math.sin(2 * math.pi * 220 * n / rate)) if n < rate else 0
               for n in range(rate * 8)]
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(struct.pack("<" + "h" * len(samples), *samples))
    return output.getvalue()


def test_quality_gate_checks_light_sharpness_voice_and_duration():
    picture, report = check_portrait(synthetic_portrait())
    assert picture.startswith(b"\xff\xd8") and report["sharpness"] == "合格"
    assert check_voice(synthetic_voice())["volume"] == "合格"
    with pytest.raises(EnrollmentError, match="太暗"):
        check_portrait(synthetic_portrait(level=15))
    with pytest.raises(EnrollmentError, match="声音太小"):
        check_voice(synthetic_voice(amplitude=0))
    with pytest.raises(EnrollmentError, match="说话时间太短"):
        check_voice(mostly_silent_voice())


def test_only_derived_portrait_and_embedding_persist(tmp_path):
    store = ParentEnrollmentStore(tmp_path)
    portrait, _ = check_portrait(synthetic_portrait())
    embedding = struct.pack("<8f", *([0.25] * 8))
    token = store.stage(portrait, embedding)
    assert not store.active()
    assert store.peek(token) == (portrait, embedding)
    assert store.peek(token) == (portrait, embedding)
    assert store.take(token) == (portrait, embedding)
    with pytest.raises(EnrollmentError, match="失效"):
        store.take(token)
    retry_token = store.stage(portrait, embedding)
    assert store.peek(retry_token) == (portrait, embedding)
    store.discard(retry_token)
    with pytest.raises(EnrollmentError, match="失效"):
        store.peek(retry_token)
    store.commit(portrait, embedding)
    assert store.active()
    assert {path.name for path in store.root.iterdir()} == {"portrait.jpg", "voice.f32", "active.json"}
    assert synthetic_voice()[:64] not in b"".join(path.read_bytes() for path in store.root.iterdir())
    store.clear()
    assert not store.active() and not list(store.root.iterdir())


def test_invalid_media_and_corrupt_embedding_fail_closed(tmp_path):
    with pytest.raises(EnrollmentError):
        decode_media("???", limit=20)
    store = ParentEnrollmentStore(tmp_path)
    with pytest.raises(EnrollmentError, match="特征"):
        store.stage(b"portrait", b"\x00")
    embedding = struct.pack("<8f", *([0.25] * 8))
    store.commit(b"portrait", embedding)
    (store.root / "voice.f32").write_bytes(b"changed")
    assert not store.active() and store.voice_path() is None


def test_activation_can_retry_after_avatar_connection_fails(tmp_path, monkeypatch):
    import httpx

    from app.parent_avatar import ParentAvatarError

    main = importlib.import_module("app.main")
    store = ParentEnrollmentStore(tmp_path)
    embedding = struct.pack("<8f", *([0.25] * 8))
    token = store.stage(b"approved-portrait", embedding)

    class Voice:
        def activate_parent_voice(self, _):
            pass

        def restore_nathan_voice(self):
            pass

    class Avatar:
        attempts = 0

        def activate(self, _):
            self.attempts += 1
            if self.attempts == 1:
                raise ParentAvatarError("temporary connection failure")

        def restore(self):
            pass

    avatar = Avatar()
    monkeypatch.setattr(main, "parent_enrollment", store)
    monkeypatch.setattr(main, "parent_avatar", avatar)
    monkeypatch.setattr(main, "tts", Voice())

    async def check():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8760") as client:
            headers = {"X-Family-Enroll": "1", "Origin": "http://127.0.0.1:8760"}
            failed = await client.post("/api/parent/enrollment/activate", headers=headers, json={"token": token})
            assert failed.status_code == 503
            assert store.peek(token) == (b"approved-portrait", embedding)
            succeeded = await client.post("/api/parent/enrollment/activate", headers=headers, json={"token": token})
            assert succeeded.status_code == 200
            assert store.active()
            with pytest.raises(EnrollmentError, match="失效"):
                store.peek(token)

    asyncio.run(check())
    assert avatar.attempts == 2
