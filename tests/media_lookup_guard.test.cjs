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
    chooseMediaSuggestion: (await import("../frontend/media-intent.js")).chooseMediaSuggestion,
    mediaSuggestionRequestController: null,
    mediaSuggestionGeneration: 0,
    mediaSuggestionJobStatusUrl: "",
    mediaSuggestionGroups: groups,
    crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    setTimeout,
    clearTimeout,
    document: { hidden: false },
    mediaViewer: { close() {}, openImage() {} },
    renderHistory() { renders.push(groups.map(group => group.topic)); },
    fetch(_url, options) {
      if (_url.endsWith("/cancel")) return Promise.resolve({ ok: true, json: async () => ({ status: "cancelled" }) });
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

  requests[1].wait.resolve({ ok: true, json: async () => ({ topic: "火山", cards: [{ kind: "image", topic: "火山" }], reason: "" }) });
  await volcano;
  requests[0].wait.resolve({ ok: true, json: async () => ({ topic: "蝴蝶", cards: [{ kind: "image" }], reason: "" }) });
  await butterfly;
  assert.deepEqual(groups.map(group => group.topic), ["火山"]);
  assert.deepEqual(renders, [["蝴蝶"], ["火山"], ["火山"]]);

  const rainbow = context.loadMediaSuggestions("看看彩虹");
  await new Promise(resolve => setImmediate(resolve));
  context.cancelMediaSuggestionLookup();
  requests[2].wait.resolve({ ok: true, json: async () => ({ topic: "彩虹", cards: [{ kind: "image" }], reason: "" }) });
  await rainbow;
  assert.deepEqual(groups.map(group => group.topic), ["火山"]);
});

test("generated image polling stays async and adds only the current topic result", async () => {
  const groups = [], renders = [], requests = [];
  const jobId = "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
  const context = vm.createContext({
    AbortController,
    chooseMediaSuggestion: (await import("../frontend/media-intent.js")).chooseMediaSuggestion,
    mediaSuggestionRequestController: null,
    mediaSuggestionGeneration: 0,
    mediaSuggestionJobStatusUrl: "",
    mediaSuggestionGroups: groups,
    crypto: { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    setTimeout(fn) { queueMicrotask(fn); return 1; },
    clearTimeout() {},
    document: { hidden: false },
    mediaViewer: { close() {}, openImage(card) { requests.push({ url: "auto-open", card }); } },
    renderHistory() { renders.push(groups.map(group => group.cards.length)); },
    async fetch(url, options = {}) {
      requests.push({ url, options });
      if (url === "/api/media/suggestions") return { ok: true, json: async () => ({
        topic: "蝴蝶", cards: [], reason: "", image_generation: "queued",
        image_generation_job: { status_url: `/api/image-generation/jobs/${jobId}` },
      }) };
      return { ok: true, json: async () => ({
        topic: "蝴蝶", status: "completed",
        card: { kind: "image", topic: "蝴蝶", thumbnail_url: "/api/generated-media/0123456789abcdef01234567.png" },
      }) };
    },
  });
  vm.runInContext(implementation, context);
  await context.loadMediaSuggestions("请给我画一张蝴蝶图");
  assert.deepEqual(JSON.parse(requests[0].options.body), { topic: "蝴蝶", kind: "image", generate_image: true, image_job_id: jobId });
  assert.deepEqual(groups.map(group => group.topic), ["蝴蝶"]);
  assert.equal(groups[0].cards[0].thumbnail_url, "/api/generated-media/0123456789abcdef01234567.png");
  assert.deepEqual(renders, [[0], [0], [1]]);
  assert.equal(requests.at(-1).url, "auto-open");
});

test("an ordinary text-only mention does not open or fetch pictures", async () => {
  const groups = [], requests = [];
  const context = vm.createContext({
    AbortController,
    chooseMediaSuggestion: (await import("../frontend/media-intent.js")).chooseMediaSuggestion,
    mediaSuggestionRequestController: null,
    mediaSuggestionGeneration: 0,
    mediaSuggestionJobStatusUrl: "",
    mediaSuggestionGroups: groups,
    crypto: { randomUUID: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    setTimeout,
    clearTimeout,
    document: { hidden: false },
    mediaViewer: { close() {}, openImage() { throw new Error("must not auto-open"); } },
    renderHistory() {},
    async fetch(url, options = {}) {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ topic: "蝴蝶", cards: [], reason: "no_suitable_result", image_generation: "not_configured" }) };
    },
  });
  vm.runInContext(implementation, context);
  await context.loadMediaSuggestions("蝴蝶有几只翅膀", "蝴蝶通常有两对翅膀。 ");
  assert.equal(requests.length, 0);
});

test("a child request or teacher visual teaching cue can generate an image", async () => {
  const requests = [];
  const context = vm.createContext({
    AbortController,
    chooseMediaSuggestion: (await import("../frontend/media-intent.js")).chooseMediaSuggestion,
    mediaSuggestionRequestController: null,
    mediaSuggestionGeneration: 0,
    mediaSuggestionJobStatusUrl: "",
    mediaSuggestionGroups: [],
    crypto: { randomUUID: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    setTimeout,
    clearTimeout,
    document: { hidden: false },
    mediaViewer: { close() {}, openImage() {} },
    renderHistory() {},
    async fetch(url, options = {}) {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ topic: "蝴蝶", cards: [], reason: "", image_generation: "failed" }) };
    },
  });
  vm.runInContext(implementation, context);

  await context.loadMediaSuggestions("请给我画一张蝴蝶图", "好呀。");
  await context.loadMediaSuggestions("蝴蝶有几只翅膀", "我们来看看蝴蝶的翅膀。");

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(JSON.parse(request.options.body).generate_image, true);
  }
});
