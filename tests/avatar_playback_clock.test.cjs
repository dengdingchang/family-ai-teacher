const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app.js'), 'utf8');

function playBurst(audioPosition) {
  let now = 0;
  const timers = [], decoded = [];
  const c = vm.createContext({
    queueGeneration: 1, avatarNeedsKeyframe: true, avatarPumpTimer: null,
    avatarEncodedQueue: Array.from({length:12}, (_,i)=>({key:i===0,timestamp:i*40000,data:new Uint8Array([i])})),
    streamingPlayback: {generation:1,player:{playbackPositionSeconds:()=>audioPosition+now/1000}},
    ensureAvatarDecoder:()=>true,
    avatarDecoder: {decode(frame) {decoded.push({pts:frame.timestamp,at:now,voice:audioPosition+now/1000});}},
    EncodedVideoChunk:class {constructor(value) {Object.assign(this,value);}},
    setTimeout(callback,delay) {timers.push({callback,at:now+delay});return timers.length;},
  });
  vm.runInContext(source.slice(source.indexOf('function pumpAvatarVideo('),source.indexOf('function queueEncodedAvatarFrame(')),c);
  c.pumpAvatarVideo();
  let iterations = 0;
  while (timers.length && iterations++ < 200) {
    timers.sort((a,b)=>a.at-b.at);
    const timer = timers.shift(); now=timer.at; timer.callback();
  }
  assert.equal(iterations<200,true,'pump must settle');
  return decoded;
}

test('a late burst keeps all H264 dependencies without adding another half-second queue', () => {
  const decoded = playBurst(0.48);
  assert.deepEqual(decoded.map(x=>x.pts),Array.from({length:12},(_,i)=>i*40000));
  assert.ok(decoded.at(-1).at<80,'late dependencies should catch up immediately');
});

test('an early burst waits for audio instead of animating the whole sentence at once', () => {
  const decoded = playBurst(0);
  assert.equal(decoded.length,12);
  assert.ok(decoded.at(-1).at>=390);
  assert.ok(decoded.every(x=>x.pts/1000000<=x.voice+0.040001));
});
