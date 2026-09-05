const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('a reset decoder is configured again before the next turn', () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
  const functionSource = source.slice(
    source.indexOf('function ensureAvatarDecoder()'),
    source.indexOf('function pumpAvatarVideo()'),
  );
  let configurations = 0;
  const decoder = {
    state: 'configured',
    reset() { this.state = 'unconfigured'; },
    configure() { configurations++; this.state = 'configured'; },
  };
  const context = vm.createContext({
    avatarDecoder: decoder,
    window: { VideoDecoder() {}, EncodedVideoChunk() {} },
    avatarNeedsKeyframe: false,
    setAvatarState() {},
  });
  vm.runInContext(functionSource, context);
  for (let turn = 0; turn < 3; turn++) {
    decoder.reset();
    assert.equal(vm.runInContext('ensureAvatarDecoder()', context), true);
    assert.equal(decoder.state, 'configured');
    assert.equal(context.avatarNeedsKeyframe, true);
  }
  assert.equal(configurations, 3);
});
