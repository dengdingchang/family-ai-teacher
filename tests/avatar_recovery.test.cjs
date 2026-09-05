const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');

function setup() {
  let writes = 0;
  let label = '声音先开始，动作稍后恢复';
  const c = vm.createContext({
    avatarCanvas: { hidden: true, getContext: () => ({ drawImage() {} }) },
    avatarImage: {}, avatarFrameGeneration: 1, avatarAcceptFrames: true, avatarDrawing: false,
    avatarFrameSerial: 0, avatarFrameWaiters: [],
    avatarStateText: { get textContent() { return label; }, set textContent(value) { writes++; label = value; } },
    window: { createImageBitmap: true }, createImageBitmap: async () => ({ close() {} }),
    syncAvatarIdle() {}, clearTimeout,
  });
  for (const [start, end] of [
    ['function setAvatarState(', 'function waitForAvatarFrame('],
    ['async function drawAvatarFrame(', 'function ensureAvatarDecoder('],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), c);
  return { c, writes: () => writes };
}

for (const transport of ['JPEG', 'H264']) {
  test(`the first successful visible ${transport} frame clears stale fallback text without repeated DOM writes`, async () => {
    const { c, writes } = setup();
    let ready = false;
    c.avatarFrameWaiters.push({ afterSerial: 0, timer: null, resolve() { ready = true; } });
    const render = () => transport === 'JPEG'
      ? c.drawAvatarFrame({}) : c.showDecodedAvatarFrame({ close() {} });
    await render();
    assert.equal(c.avatarStateText.textContent, '准备好啦，可以一起说话');
    assert.equal(ready, true, 'frame readiness must retain its existing behavior');
    await render();
    assert.equal(writes(), 1, 'following frames must not rewrite the same label');
  });
}

test('failed, cancelled, or hidden frames do not claim that visible motion recovered', async () => {
  const { c, writes } = setup();
  c.createImageBitmap = async () => { throw new Error('bad frame'); };
  await c.drawAvatarFrame({});
  c.avatarAcceptFrames = false;
  c.showDecodedAvatarFrame({ close() {} });
  c.avatarAcceptFrames = true;
  c.syncAvatarIdle = () => { c.avatarCanvas.hidden = true; };
  c.showDecodedAvatarFrame({ close() {} });
  assert.equal(c.avatarStateText.textContent, '声音先开始，动作稍后恢复');
  assert.equal(writes(), 0);
});
