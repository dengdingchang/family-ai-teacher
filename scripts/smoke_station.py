"""Synthetic integration smoke for an isolated station deployment, no raw media files."""
import argparse
import asyncio
import base64
import io
import json
import subprocess
import time
import uuid
from pathlib import Path

import httpx
from PIL import Image, ImageDraw


def run(base, receipt):
    results = {}
    client = httpx.Client(base_url=base, timeout=240, trust_env=False)
    deadline = time.monotonic()+90
    while time.monotonic()<deadline:
        try:
            h=client.get("/health").json()
            if h.get("tts_warmup")=="ready": break
        except (httpx.HTTPError, ValueError): pass
        time.sleep(1)
    def check(name, fn):
        started = time.monotonic()
        try:
            detail = fn()
            results[name] = {"status": "PASS", "seconds": round(time.monotonic()-started,3), "detail": detail}
        except Exception as exc:
            results[name] = {"status": "FAIL", "error": type(exc).__name__}
        print(name, json.dumps(results[name],ensure_ascii=True),flush=True)
        receipt.write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding="utf-8")
    def speech():
        rows=[]
        for text, words in [("我们一起数一数，苹果有三个。", ("苹果", "三")), ("我喜欢蓝色，I like blue。", ("blue",)), ("The little cat is sleeping.", ("cat", "sleep"))]:
            start=time.monotonic()
            response=client.post("/api/tts",json={"text":text}); response.raise_for_status()
            audio=base64.b64decode(response.json()["audio_base64"])
            voice_s=time.monotonic()-start
            response=client.post("/api/transcribe",files={"audio":("synthetic.wav",audio,"audio/wav")}); response.raise_for_status()
            payload=response.json()
            rows.append({"tts_s":round(voice_s,3),"stt_s":payload["elapsed_s"],"content_match":all(w in payload["text"].lower() for w in words),"audio_bytes":len(audio)})
        return rows
    def conversation():
        turn=uuid.uuid4().hex; chunks=0; first=None; done=False
        started=time.monotonic()
        with client.stream("POST","/api/conversation/text/stream",json={"text":"为什么天上会下雨？"},headers={"X-Conversation-Turn-Id":turn,"X-Audio-Streaming":"1"}) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line.startswith("data:"): continue
                event=json.loads(line[5:])
                if event.get("event")=="audio":
                    chunks+=1
                    if first is None: first=round(time.monotonic()-started,3)
                if event.get("event")=="done": done=event.get("ok")
                assert event.get("event")!="error"
        r=client.post("/api/conversation/turns/"+turn+"/cancel"); r.raise_for_status()
        assert done and chunks and r.json().get("cancelled")
        return {"audio_chunks":chunks,"first_audio_s":first,"cancelled":True}
    def picture():
        image=Image.new("RGB",(512,512),"white"); ImageDraw.Draw(image).ellipse((90,90,420,420),fill="red")
        out=io.BytesIO(); image.save(out,"JPEG")
        r=client.post("/api/vision/describe-frame",content=out.getvalue(),headers={"Content-Type":"image/jpeg"}); r.raise_for_status()
        assert r.json()["persisted_image"] is False and r.json()["description"]
        return {"described":True,"persisted_image":False}
    def video():
        p=subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i","color=c=blue:s=320x240:d=2","-c:v","libx264","-movflags","frag_keyframe+empty_moov","-f","mp4","pipe:1"],capture_output=True,check=True)
        r=client.post("/api/vision/describe-video",files={"video":("synthetic.mp4",p.stdout,"video/mp4")}); r.raise_for_status()
        body=r.json(); assert not body["persisted_video"] and not body["persisted_frames"] and body["description"]
        return {"frames":body["frames"],"persisted_video":False}
    def search():
        r=client.post("/api/media/suggestions",json={"topic":"月亮","kind":"link"}); r.raise_for_status()
        body=r.json(); assert body["online_search"] and body["cards"]
        return {"sources":len(body["cards"])}
    def imagegen():
        r=client.post("/api/media/suggestions",json={"topic":"小熊坐着积木火车去月球","kind":"image","generate_image":True}); r.raise_for_status()
        body=r.json(); job=body.get("image_generation_job")
        assert job, body.get("image_generation")
        deadline=time.monotonic()+330
        while time.monotonic()<deadline:
            r=client.get(job["status_url"]); r.raise_for_status(); body=r.json()
            if body["status"]=="completed": return {"completed":True}
            if body["status"] in ("failed","cancelled"): raise RuntimeError("image generation failed")
            time.sleep(2)
        raise TimeoutError()
    for name,fn in [("speech",speech),("continuous_stream_cancel",conversation),("explicit_photo",picture),("explicit_video",video),("public_search",search),("image_generation",imagegen)]: check(name,fn)
    client.close()
    return all(v["status"]=="PASS" for v in results.values())


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url",default="http://127.0.0.1:18760")
    parser.add_argument("--receipt",type=Path,required=True)
    parser.add_argument("--isolated-data-confirmed",action="store_true",required=True)
    args=parser.parse_args()
    raise SystemExit(0 if run(args.base_url,args.receipt) else 1)
