const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/parent.js'), 'utf8');

function setup() {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', replaceChildren() {} });
    return elements.get(id);
  };
  const context = vm.createContext({ byId });
  vm.runInContext(source.slice(source.indexOf('function formatInteractionTime('),
    source.indexOf('function renderProfile(')), context);
  return { context, byId };
}

test('unavailable or malformed timing never derives minutes from a turn count', () => {
  const { context, byId } = setup();
  for (const today of [
    { conversation_turns: 90 },
    { conversation_turns: 90, interaction_seconds: 260, interaction_timing_available: false },
  ]) {
    context.renderToday(today);
    assert.equal(byId('todayInteractionTime').textContent, '尚无计时');
    assert.equal(byId('todayTurns').textContent, '90轮完整对话');
  }
  for (const seconds of [undefined, null, '260', NaN, Infinity, -1])
    assert.equal(context.formatInteractionTime(seconds, true), '尚无计时');
});

test('recorded zero remains distinct from unknown timing and a positive sub-minute interval', () => {
  const { context } = setup();
  assert.equal(context.formatInteractionTime(0, false), '尚无计时');
  assert.equal(context.formatInteractionTime(0, true), '0秒');
  for (const seconds of [0.1, 1, 59, 59.999])
    assert.equal(context.formatInteractionTime(seconds, true), '小于1分钟');
});

test('time formatting crosses minute and hour boundaries without rounding up', () => {
  const { context } = setup();
  for (const [seconds, expected] of [
    [60, '1分0秒'], [60.999, '1分0秒'], [260, '4分20秒'],
    [3599.999, '59分59秒'], [3600, '1小时0分'], [3661, '1小时1分'],
  ]) assert.equal(context.formatInteractionTime(seconds, true), expected);
});

test('today renders timing and completed conversation count independently', () => {
  const { context, byId } = setup();
  context.renderToday({ interaction_seconds: 260, interaction_timing_available: true,
    conversation_turns: 3, topics: ['秋天'] });
  assert.equal(byId('todayInteractionTime').textContent, '4分20秒');
  assert.equal(byId('todayTurns').textContent, '3轮完整对话');
  assert.equal(byId('todayTopics').textContent, '今天：秋天');
  context.renderToday({ interaction_seconds: 0, interaction_timing_available: true });
  assert.equal(byId('todayInteractionTime').textContent, '0秒');
  assert.equal(byId('todayTurns').textContent, '0轮完整对话');
});
