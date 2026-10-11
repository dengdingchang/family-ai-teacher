"""Read an existing valid session privately; probe HTTPS media/WS without saving raw media."""
import argparse
import asyncio
import base64
import json
import math
import struct
import subprocess
import time
import uuid
from pathlib import Path

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus


async def avatar(url, token):
    started=time.monotonic(); frames=0; stream=bytearray(); key=False
    async with connect(url.replace('https://','wss://')+'/ws/avatar', origin=url,
                       additional_headers={'Cookie':'teacher_session='+token},max_size=16*1024*1024,proxy=None) as ws:
        while frames<16:
            packet=await asyncio.wait_for(ws.recv(),30)
            if isinstance(packet,str):
                event=json.loads(packet)
                if event.get('type')=='ready':
                    pcm=struct.pack('<32000h',*[int(2000*math.sin(2*math.pi*180*n/16000)) for n in range(32000)])
                    await ws.send(json.dumps({'type':'audio_begin'}))
                    await ws.send(json.dumps({'type':'audio','pcm':base64.b64encode(pcm).decode()}))
                    await ws.send(json.dumps({'type':'audio_end'}))
                if event.get('type')=='error': raise RuntimeError('avatar protocol error')
                continue
            assert packet.startswith(b'FATV1')
            pos=6
            for n in range(packet[5]):
                is_key,_,size=struct.unpack_from('>BQI',packet,pos); pos+=13
                stream.extend(packet[pos:pos+size]);pos+=size;frames+=1;key=key or bool(is_key)
    decoded=subprocess.run(['ffmpeg','-v','error','-f','h264','-i','pipe:0','-frames:v','1','-f','null','-'],input=bytes(stream),capture_output=True,timeout=30)
    assert key and decoded.returncode==0
    return {'frames':frames,'h264_decoded':True,'seconds':round(time.monotonic()-started,3)}


async def anonymous_websocket(url):
    try:
        async with connect(url.replace('https://','wss://')+'/ws/avatar',origin=url,proxy=None):
            raise AssertionError('Anonymous websocket was accepted')
    except InvalidStatus as exc:
        assert exc.response.status_code==403
        return 403


def run(args):
    result={}
    def check(name,fn):
        try: result[name]={'status':'PASS','detail':fn()}
        except Exception as exc: result[name]={'status':'FAIL','error':type(exc).__name__}
        print(name,json.dumps(result[name],ensure_ascii=True),flush=True)
        args.receipt.write_text(json.dumps(result,indent=2),encoding='utf-8')
    with httpx.Client(base_url=args.base_url,trust_env=False,timeout=90) as public:
        def entry():
            times=[]
            for n in range(3):
                start=time.monotonic(); r=public.get('/login'); assert r.status_code==200
                times.append(round(time.monotonic()-start,3))
            assert public.get('/api/profile').status_code==401
            r=public.get(args.base_url.replace('https://','http://')+'/login'); assert r.status_code==308
            assert r.headers['location']==args.base_url+'/login'
            return {'login_seconds':times,'anonymous_api':401,'http_upgrade':308,'anonymous_ws':asyncio.run(anonymous_websocket(args.base_url))}
        check('public_entry',entry)
    sessions=json.loads(args.sessions.read_text(encoding='utf-8'))
    valid=[(row['expires_at'],token) for token,row in sessions.items() if row.get('expires_at',0)>time.time()]
    if not valid:
        result['authenticated']={'status':'NOT RUN','reason':'No existing unexpired session'}
        args.receipt.write_text(json.dumps(result,indent=2)); return False
    token=max(valid)[1]
    with httpx.Client(base_url=args.base_url,trust_env=False,timeout=120,cookies={'teacher_session':token}) as client:
        def media():
            sizes={}
            if args.expected_port:
                health=client.get('/health');health.raise_for_status()
                assert health.json()['port']==args.expected_port
                sizes['application_port']=args.expected_port
            for path in ('/','/setup','/parent','/app.js','/drawing-board.js','/chess-board.js','/music-studio.js','/api/avatar','/api/avatar/idle'):
                r=client.get(path); r.raise_for_status(); sizes[path]=len(r.content)
            return sizes
        check('authenticated_pages_and_media',media)
        if not args.entry_only:
            check('authenticated_websocket',lambda:asyncio.run(avatar(args.base_url,token)))
            def conversation():
                turn=uuid.uuid4().hex; start=time.monotonic(); count=0; first=None; semantic=None; done={}
                try:
                    with client.stream('POST','/api/conversation/text/stream',json={'text':'我用积木搭了一座有三个窗户的小房子。'},headers={'Origin':args.base_url,'X-Conversation-Turn-Id':turn,'X-Audio-Streaming':'1'}) as response:
                        response.raise_for_status()
                        for line in response.iter_lines():
                            if not line.startswith('data:'):continue
                            event=json.loads(line[5:])
                            if event.get('event')=='audio':
                                count+=1
                                if first is None:first=round(time.monotonic()-start,3)
                                if event.get('semantic') and semantic is None:semantic=round(time.monotonic()-start,3)
                            if event.get('event')=='done':done=event
                            assert event.get('event')!='error'
                    assert count and done.get('ok')
                finally:
                    r=client.post('/api/conversation/turns/'+turn+'/cancel',headers={'Origin':args.base_url});r.raise_for_status()
                return {'audio_chunks':count,'first_audio_s':first,'first_semantic_s':semantic,'llm_elapsed_s':done.get('llm_elapsed_s'),'cancelled':r.json().get('cancelled')}
            check('authenticated_conversation_cancel',conversation)
    return all(row['status']=='PASS' for row in result.values())


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='https://teacher.example.com')
    parser.add_argument('--sessions',type=Path,required=True)
    parser.add_argument('--receipt',type=Path,required=True)
    parser.add_argument('--entry-only',action='store_true')
    parser.add_argument('--expected-port',type=int)
    args=parser.parse_args()
    raise SystemExit(0 if run(args) else 1)
