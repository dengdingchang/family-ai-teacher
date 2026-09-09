const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/app.js"), "utf8");
const start = source.indexOf("function cancelMediaSuggestionLookup(");
const end = source.indexOf("function renderHistory(", start);
const implementation = source.slice(start, end);

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test("a later media topic aborts and rejects an older result even when it returns last", async () => {
  const requests = [], groups = [], renders = [];
  const context = vm.createContext({
    AbortController,
    mediaSuggestionRequestController: null,
    mediaSuggestionGeneration: 0,
    mediaSuggestionGroups: groups,
    renderHistory() { renders.push(groups.map(group => group.topic)); },
    fetch(_url, options) {
      const wait = deferred();
      requests.push({ options, wait });
      return wait.promise;
    },
  });
  vm.runInContext(implementation, context);

  const butterfly = context.loadMediaSuggestions("我想看看蝴蝶");
  await new Promise(resolve => setImmediate(resolve));
  const volcano = context.loadMediaSuggestions("我想看看火山");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.signal.aborted, true);

  requests[1].wait.resolve({ ok: true, json: async () => ({ topic: "火山", cards: [{ kind: "image" }], reason: "" }) });
  await volcano;
  requests[0].wait.resolve({ ok: true, json: async () => ({ topic: "蝴蝶", cards: [{ kind: "image" }], reason: "" }) });
  await butterfly;
  assert.deepEqual(groups.map(group => group.topic), ["火山"]);
  assert.deepEqual(renders, [["火山"]]);

  const rainbow = context.loadMediaSuggestions("看看彩虹");
  await new Promise(resolve => setImmediate(resolve));
  context.cancelMediaSuggestionLookup();
  requests[2].wait.resolve({ ok: true, json: async () => ({ topic: "彩虹", cards: [{ kind: "image" }], reason: "" }) });
  await rainbow;
  assert.deepEqual(groups.map(group => group.topic), ["火山"]);
});
