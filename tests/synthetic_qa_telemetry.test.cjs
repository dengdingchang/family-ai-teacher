const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function recordPayload(payload) {
  const source = fs.readFileSync(path.join(__dirname, "../scripts/qa_synthetic_microphone.js"), "utf8");
  const start = source.indexOf("const record = (frame) => {");
  const end = source.indexOf("\n              try {", start);
  assert.ok(start >= 0 && end > start);
  const turn = {events:[]};
  vm.runInNewContext(`${source.slice(start, end)}\nrecord(frame);`, {
    turn, at:()=>123, frame:`data: ${JSON.stringify(payload)}\n\n`,
  });
  return JSON.parse(JSON.stringify(turn.events[0]));
}

test("synthetic journey records server timing without audio or new assistant text", () => {
  const audio = recordPayload({event:"audio",sequence:2,semantic:true,audio_stream:true,
    tts_started_s:0.036,tts_call_s:0.724,audio_base64:"DO_NOT_EXPORT_AUDIO",avatar_pcm_base64:"DO_NOT_EXPORT_AUDIO",text:"DO_NOT_EXPORT_TEXT"});
  assert.equal(audio.ttsStartedS, 0.036);
  assert.equal(audio.ttsCallS, 0.724);
  assert.equal(audio.semantic, true);
  assert.equal(audio.sequence, 2);
  assert.equal(audio.at, 123);
  assert.equal(JSON.stringify(audio).includes("DO_NOT_EXPORT"), false);

  const text = "只统计这段字符数，不新增保存正文";
  const delta = recordPayload({event:"assistant_delta",text});
  assert.equal(delta.deltaChars, text.length);
  assert.equal(Object.hasOwn(delta,"text"), false);
  assert.equal(JSON.stringify(delta).includes(text), false);
});

test("missing or malformed timing is omitted instead of fabricated as zero", () => {
  for (const payload of [
    {event:"audio"},
    {event:"audio",tts_started_s:null,tts_call_s:"0.25"},
    {event:"assistant_delta",text:null,tts_started_s:{unexpected:true}},
  ]) {
    const event = recordPayload(payload);
    assert.equal(Object.hasOwn(event,"ttsStartedS"), false);
    assert.equal(Object.hasOwn(event,"ttsCallS"), false);
    assert.equal(Object.hasOwn(event,"deltaChars"), false);
  }
});
