const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const filename of ['qa_avatar_browser.js', 'qa_synthetic_microphone.js']) {
  const source = fs.readFileSync(path.join(__dirname, '../scripts', filename), 'utf8');
  const start = source.indexOf('  // Block timing writes');
  const endText = '  await page.route(interactionRoute, interceptInteractionInterval);';
  const end = source.indexOf(endText, start) + endText.length;

  async function setupGuard() {
    let handler, pattern;
    const run = vm.runInNewContext(`(async (page) => {${source.slice(start, end)}
      return interactionIntervals;
    })`);
    const records = await run({ route(routePattern, callback) { pattern = routePattern; handler = callback; } });
    return { handler, pattern, records };
  }

  function fakeRoute(invalidJson = false) {
    let reply;
    return {
      request: () => ({ method: () => 'POST', resourceType: () => 'fetch', postDataJSON() {
        if (invalidJson) throw new Error('bad JSON');
        return { session_id: 'synthetic-test-session', sequence: 2,
          start_at: '2026-09-06T01:00:00Z', end_at: '2026-09-06T01:00:12.500Z',
          extra_private_text: 'DO_NOT_EXPORT' };
      } }),
      async fulfill(value) { reply = value; },
      continue() { assert.fail('timing must never reach the real backend'); },
      fallback() { assert.fail('timing must never reach another forwarding handler'); },
      reply: () => reply,
    };
  }

  test(`${filename}: timing POST receives simulated success with safe metadata only`, async () => {
    const { handler, pattern, records } = await setupGuard();
    assert.ok(pattern.test('http://127.0.0.1:8760/api/conversation/interaction-interval'));
    assert.ok(pattern.test('http://127.0.0.1:8760/api/conversation/interaction-interval?qa=1'));
    assert.equal(pattern.test('http://127.0.0.1:8760/api/conversation/interaction-interval-other'), false);
    const route = fakeRoute();
    await handler(route);
    assert.equal(route.reply().status, 200);
    assert.deepEqual(JSON.parse(route.reply().body), { ok: true, recorded: true, qa_intercepted: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].durationSeconds, 12.5);
    assert.equal(records[0].sequence, 2);
    assert.equal(records[0].fulfilled, true);
    assert.equal(JSON.stringify(records).includes('DO_NOT_EXPORT'), false);
    assert.equal(JSON.stringify(records).includes('synthetic-test-session'), false);
  });

  test(`${filename}: malformed requests stay blocked and are visible in the QA receipt`, async () => {
    const { handler, records } = await setupGuard();
    const route = fakeRoute(true);
    await handler(route);
    assert.equal(route.reply().status, 200);
    assert.equal(records[0].validJson, false);
    assert.equal(records[0].durationSeconds, null);
  });

  for (const navigationFails of [false, true]) {
    test(`${filename}: setup failure keeps the timing guard through teardown${navigationFails ? ' and leaves it installed if exit fails' : ''}`, async () => {
      const events = [];
      let handler;
      const route = fakeRoute();
      const page = {
        async route(pattern, callback) { events.push('route'); handler = callback; },
        async unroute() { events.push('unroute'); },
        async emulateMedia() { throw new Error('setup failure'); },
        async evaluate() { throw new Error('setup failure'); },
        locator() { throw new Error('setup failure'); },
        async goto(url) {
          assert.equal(url, 'about:blank');
          events.push('exit-start');
          await handler(route); // Models the old page's final keepalive request.
          if (navigationFails) throw new Error('navigation failure');
          events.push('exit-done');
        },
      };
      const run = vm.runInNewContext(`(${source})`);
      let result;
      try { result = await run(page); } catch (error) {
        assert.match(error.message, /setup failure|navigation failure/);
      }
      assert.equal(route.reply().status, 200);
      assert.deepEqual(events, navigationFails
        ? ['route', 'exit-start'] : ['route', 'exit-start', 'exit-done', 'unroute']);
      if (result) {
        assert.equal(result.status, 'FAIL');
        assert.equal(result.interactionTimingQa.interceptedCount, 1);
      }
    });
  }
}
