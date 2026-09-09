const test = require('node:test');
const assert = require('node:assert/strict');
const guidance = require('../frontend/daily-guidance.js');

test('the server active flag is authoritative for what Mac displays as today', () => {
  assert.equal(guidance.valueForForm({daily_guidance_active:true,daily_guidance:'  练   刷牙  '}), '练 刷牙');
  assert.equal(guidance.valueForForm({daily_guidance_active:false,daily_guidance:'昨天主题'}), '');
});

test('the browser sends content only and never stamps its own date', () => {
  assert.deepEqual(guidance.patchForSave('  收   玩具  '), {daily_guidance:'收 玩具'});
  assert.deepEqual(guidance.patchForSave(''), {daily_guidance:''});
  assert.equal(Object.hasOwn(guidance.patchForSave('刷牙'), 'daily_guidance_date'), false);
});
