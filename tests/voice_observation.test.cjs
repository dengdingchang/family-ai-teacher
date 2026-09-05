const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app.js'), 'utf8');

for (const mode of ['requested', 'ordinary', 'denied', 'cancelled']) {
  test(`voice observation: ${mode} respects one-shot capture and cancellation`, async () => {
    const requests = []; let captures = 0, streams = 0;
    const c = vm.createContext({
      activeRequestController: null, activeTurnId: null, interruptedRequestController: null,
      queueGeneration: 0,
      conversationActive: false, avatarReady: false, AbortController, FormData, Blob, DOMException,
      globalThis: { crypto: { randomUUID: () => 'observation-test-turn' } },
      setBusy(){}, setStatus(){}, resetLiveTurn(){}, stopBargeInMonitor(){}, hideLiveTurn(){},
      clearResponseQueue(){}, cancelPlayback(){}, enqueueAudio(){}, waitForAudioQueue: async () => {},
      answerBox: { classList: { add(){} }, textContent: '' }, liveTurn: { hidden: false },
      userTextBox: { textContent: '' }, captureState: { textContent: '' }, cameraStatus: { textContent: '' },
      appendHistoryRecord(){}, activityEnabled: () => true,
      fetch: async (url, options) => { requests.push({url, options}); return {ok: true, json: async () => ({ok: true})}; },
      consumeSse: async (_response, emit) => {
        if (streams++ === 0 && mode !== 'ordinary') emit({event: 'vision_request', text: '爸爸你看我的画'});
        else emit({event: 'done', assistant_text: '一起看看', ok: true});
      },
      makeFrameBlob: async () => {
        captures++;
        if (mode === 'denied') throw new Error('permission denied');
        if (mode === 'cancelled') c.activeRequestController.abort();
        return new Blob(['synthetic-image'], {type: 'image/jpeg'});
      },
    });
    vm.runInContext(source.slice(source.indexOf('function createConversationTurnId()'), source.indexOf('\nasync function sendText(')), c);
    await vm.runInContext('sendStreamingRequest({endpoint:"/api/conversation/stream",body:new FormData()})', c);
    const conversationRequests = requests.filter(item => item.url === '/api/conversation/stream');
    assert.equal(captures, mode === 'ordinary' ? 0 : 1);
    assert.equal(conversationRequests.length, ['requested','denied'].includes(mode) ? 2 : 1);
    if (mode === 'requested' || mode === 'denied') {
      const form = conversationRequests[1].options.body;
      assert.equal(form.get('transcript'), '爸爸你看我的画');
      assert.equal(form.get('observation_attempted'), 'true');
      assert.equal(form.has('frame'), mode === 'requested');
    }
  });
}

for (const mode of ['disconnected', 'done-failed', 'late-cancel']) {
  test(`incomplete SSE ${mode} cannot acknowledge playback or parent delivery`, async () => {
    const requests = []; let played = 0;
    const c = vm.createContext({
      activeRequestController: null, activeTurnId: null, interruptedRequestController: null,
      queueGeneration: 1, conversationActive: false, avatarReady: false,
      AbortController, FormData, Blob, DOMException,
      globalThis: { crypto: { randomUUID: () => 'incomplete-test-turn' } },
      setBusy(){}, setStatus(){}, resetLiveTurn(){}, stopBargeInMonitor(){}, hideLiveTurn(){},
      clearResponseQueue(){}, cancelPlayback(){}, enqueueAudio(){ played++; },
      waitForAudioQueue: async () => {},
      answerBox: { classList: { add(){} }, textContent: '' }, liveTurn: { hidden: false },
      userTextBox: { textContent: '' }, appendHistoryRecord(){},
      fetch: async (url) => { requests.push(url); return {ok: true, json: async () => ({ok: true})}; },
      consumeSse: async (_response, emit) => {
        emit({event: 'assistant_delta', text: '这句还没说完'});
        if (mode === 'late-cancel') c.activeRequestController.abort();
        emit({event: 'audio', sequence: 1});
        if (mode !== 'disconnected') emit({event: 'done', assistant_text: '回答', commit_required: true, ok: mode !== 'done-failed'});
      },
    });
    vm.runInContext(source.slice(source.indexOf('function createConversationTurnId()'), source.indexOf('\nasync function sendText(')), c);
    const result = await vm.runInContext('sendStreamingRequest({endpoint:"/fixture",body:"{}"})', c);
    assert.equal(result.ok, false);
    assert.equal(requests.some(url => url.endsWith('/complete')), false);
    assert.equal(requests.some(url => url.endsWith('/cancel')), true);
    if (mode === 'late-cancel') assert.equal(played, 0);
  });
}
