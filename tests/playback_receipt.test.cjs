const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
function queueContext(play) {
  const c = vm.createContext({audioQueue: [], queueDraining: false, queueGeneration: 0,
    queueDrainWaiters: [], queuePlaybackError: null,
    cancelAvatarFrameWaiters(){}, cancelPlayback(){}, playAudioPayload: play});
  vm.runInContext(source.slice(source.indexOf('function resolveQueueWaiters()'), source.indexOf('function cancelPlayback()')), c);
  vm.runInContext(source.slice(source.indexOf('async function drainResponseQueue()'), source.indexOf('async function consumeSse(')), c);
  return c;
}

test('failed audio stops following chunks and rejects completion; next turn recovers', async () => {
  let calls = 0, fail = true;
  const c = queueContext(async () => { calls++; if (fail) throw new Error('private browser detail'); });
  vm.runInContext('enqueueAudio({}); enqueueAudio({});', c);
  await assert.rejects(vm.runInContext('waitForAudioQueue()', c), /声音没有播放成功/);
  vm.runInContext('enqueueAudio({})', c);
  assert.equal(calls, 1);
  fail = false;
  vm.runInContext('clearResponseQueue(); enqueueAudio({})', c);
  await vm.runInContext('waitForAudioQueue()', c);
  assert.equal(calls, 2);
});

test('late failure from cancelled generation cannot poison a new turn', async () => {
  let rejectOld;
  let calls = 0;
  const c = queueContext(() => ++calls === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve());
  vm.runInContext('enqueueAudio({}); clearResponseQueue(); enqueueAudio({});', c);
  rejectOld(new Error('old failure'));
  await vm.runInContext('waitForAudioQueue()', c);
  assert.equal(c.queuePlaybackError, null);
  assert.equal(calls, 2);
});

for (const fail of [true, false]) {
  test(`streaming request ${fail ? 'cancels rather than commits failed' : 'commits successful'} playback`, async () => {
    const c = queueContext(async () => { if (fail) throw new Error('speaker unavailable'); });
    const requests = [];
    Object.assign(c, {
      activeRequestController: null, activeTurnId: null, interruptedRequestController: null,
      conversationActive: false, avatarReady: false, AbortController, FormData, Blob,
      globalThis: {crypto:{randomUUID:() => 'fixture-turn'}},
      setBusy(){}, setStatus(){}, resetLiveTurn(){}, stopBargeInMonitor(){}, hideLiveTurn(){},
      answerBox: {classList:{add(){}}, textContent:''}, liveTurn: {hidden:false},
      appendHistoryRecord(){},
      fetch: async url => { requests.push(url); return {ok:true,json:async()=>({ok:true})}; },
      consumeSse: async (_response, emit) => {
        emit({event:'audio'});
        emit({event:'done',assistant_text:'你好',commit_required:true,ok:true});
      },
    });
    const start = source.indexOf('function createConversationTurnId()');
    const end = source.indexOf('\nasync function sendText(', start);
    assert.ok(end > start);
    vm.runInContext(source.slice(start, end), c);
    const result = await vm.runInContext('sendStreamingRequest({endpoint:"/fixture",body:"{}"})', c);
    assert.equal(result.ok, !fail);
    assert.equal(requests.some(url => url.endsWith('/complete')), !fail);
    assert.equal(requests.some(url => url.endsWith('/cancel')), fail);
  });
}

test('ending conversation after SSE done but before audio ends never sends a completion receipt', async () => {
  const requests = [];
  let finishDrain, playerCancelled = false;
  const c = vm.createContext({
    activeRequestController: null, activeTurnId: null, interruptedRequestController: null,
    queueGeneration: 0, queuePlaybackError: null, queueDraining: false, audioQueue: [], queueDrainWaiters: [],
    streamingPlayback: null, activePlayback: null, activeAudio: null, activeAudioUrl: null,
    conversationActive: true, avatarReady: false, segmentShouldSend: false,
    AbortController, FormData, Blob, DOMException, URL,
    globalThis: {crypto:{randomUUID:()=>'cancel-after-done-0001'}},
    setBusy(){}, setStatus(){}, resetLiveTurn(){}, stopBargeInMonitor(){}, hideLiveTurn(){}, startBargeInMonitor(){},
    flushAvatar(){}, cancelAvatarFrameWaiters(){}, releaseInputStream(){}, stopVadLoop(){},
    recordButton: {classList:{remove(){}},setAttribute(){}}, recordLabel:{}, recordHint:{},
    answerBox:{classList:{add(){}},textContent:''}, liveTurn:{hidden:false}, appendHistoryRecord(){},
    fetch:async url=>{requests.push(url); return {ok:true,json:async()=>({ok:true})};},
    enqueueAudio(){
      c.streamingPlayback = {generation:c.queueGeneration, finishInput(){}, player:{
        drain(){return new Promise(resolve=>{finishDrain=resolve;});},
        cancel(){playerCancelled = true; if(finishDrain) finishDrain({cancelled:true});},
      }};
    },
    consumeSse:async (_response,emit)=>{
      emit({event:'audio'});
      emit({event:'done',assistant_text:'A full parent message',commit_required:true,ok:true});
    },
  });
  for (const [start, end] of [
    ['function resolveQueueWaiters()', 'async function playAudioPayload('],
    ['function createConversationTurnId()', '\nasync function sendText('],
    ['function stopContinuousConversation()', '\nrecordButton.addEventListener('],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), c);
  const pending = c.sendStreamingRequest({endpoint:'/fixture',body:'{}',continuous:true});
  for (let attempt = 0; !finishDrain && attempt < 50; attempt++) {
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal(typeof finishDrain, 'function', 'the test must interrupt during audio drain');
  const controller = c.activeRequestController;
  c.stopContinuousConversation();
  const result = await pending;
  assert.equal(controller.signal.aborted, true);
  assert.equal(playerCancelled, true);
  assert.equal(result.ok, false);
  assert.equal(requests.some(url=>url.endsWith('/cancel')), true);
  assert.equal(requests.some(url=>url.endsWith('/complete')), false);
});
