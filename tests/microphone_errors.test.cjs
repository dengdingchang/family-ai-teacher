const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/app.js', 'utf8');
const fn = source.slice(source.indexOf('function microphoneErrorMessage('), source.indexOf('async function startContinuousConversation('));
function message(secure, name) {
  const context = {window: {isSecureContext: secure}, error: {name}};
  vm.runInNewContext(fn + '; result = microphoneErrorMessage(error)', context);
  return context.result;
}
test('HTTP directs to HTTPS before suggesting permission changes', () => assert.match(message(false, 'NotAllowedError'), /https:\/\/teacher/));
test('permission denial is actionable on iPad', () => assert.match(message(true, 'NotAllowedError'), /iPad.*权限/));
test('missing and busy microphones are distinct', () => {
  assert.match(message(true, 'NotFoundError'), /没有找到/);
  assert.match(message(true, 'NotReadableError'), /其他录音/);
});
