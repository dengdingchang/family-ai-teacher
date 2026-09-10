import json,tempfile
from pathlib import Path
from unittest.mock import patch
import app.main as main
from memory.store import MemoryStore
with tempfile.TemporaryDirectory() as folder:
    root=Path(folder)
    store=MemoryStore(root,root/'profile.json',root/'history.jsonl',root/'events.jsonl',root/'missing.json')
    store.update_child_profile({'name':'合成测试','brain_mode':'local_lessons_only','enabled_activities':['game']})
    rounds=[]
    with patch.object(main,'memory',store):
        for text in ['爸爸老师，和我玩一个简单的互动小游戏吧。','我找到了','两个都找到了','两个']:
            reply,transition=main._activity_turn_reply(text,store.get_child_profile())
            assert transition
            rounds.append({'text':text,'reply':reply,'transition':transition})
            store.apply_activity_transition(transition)
    assert rounds[-1]['transition']=={'action':'clear'},rounds
    Path('runtime/playtime-game-fixture.json').write_text(json.dumps(rounds,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'rounds':len(rounds),'final':rounds[-1]['transition']}))
