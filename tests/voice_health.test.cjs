const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const fn = source.slice(source.indexOf('async function checkHealth()'), source.indexOf('\ninitializeAvatarIdle();'));

for (const state of ['failed', 'retry_wait', 'retrying', 'ready', 'warming']) {
  test(`voice health correctly represents ${state} without overriding a live turn`, async () => {
    for (const active of [false, true, 'typed']) {
      const classes = new Map();
      const statuses = [], busy = [], timers = [];
      const context = vm.createContext({
        fetch: async () => ({ok: true, json: async () => ({
          llm_configured: true, stt_ready: true, tts_ready: true, tts_warmup: state,
        })}),
        serviceBadge: {textContent: '', classList: {toggle: (k,v) => classes.set(k,v)}},
        conversationActive: active === true, conversationStarting: false,
        activeRequestController: active === 'typed' ? {} : null,
        setBusy: v => busy.push(v), setStatus: (...args) => statuses.push(args), setAvatarIdleAvailable() {},
        setTimeout: (...args) => timers.push(args),
      });
      vm.runInContext(fn, context);
      await vm.runInContext('checkHealth()', context);
      assert.equal(classes.get('ready'), state === 'ready');
      assert.equal(context.serviceBadge.textContent === '准备好了', state === 'ready');
      assert.equal(statuses.length, active ? 0 : 1);
      assert.equal(busy.length, active ? 0 : 1);
      if (!active) assert.equal(busy[0], state === 'warming');
      assert.equal(timers.length, ['warming', 'retry_wait', 'retrying'].includes(state) ? 1 : 0);
    }
  });
}

test('unconfigured remote brain still clearly offers the available local voice activities', async () => {
  const statuses = [];
  const c = vm.createContext({
    fetch: async () => ({ok: true, json: async () => ({
      llm_configured: false, stt_ready: true, tts_ready: true, tts_warmup: 'ready',
    })}),
    serviceBadge: {textContent: '', classList: {toggle(){}}},
    conversationActive: false, conversationStarting: false, activeRequestController: null,
    setBusy(){}, setStatus: text => statuses.push(text), setAvatarIdleAvailable(){}, setTimeout(){},
  });
  vm.runInContext(fn, c);
  await vm.runInContext('checkHealth()', c);
  assert.equal(c.serviceBadge.textContent, '本地活动可以玩');
  assert.match(statuses[0], /画画、故事和数字/);
});
