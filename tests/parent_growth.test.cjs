const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/parent.js'), 'utf8');

class Element {
  constructor(tag = '') {
    this.tag = tag; this.children = []; this.dataset = {}; this.events = {}; this.textContent = '';
  }
  append(...items) {
    this.children.push(...items);
    for (const item of items) if (item.tag === 'option' && item.selected) this.value = item.value;
  }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  addEventListener(name, action) { this.events[name] = action; }
  get options() { return this.children; }
}

function setup() {
  const ids = new Map();
  const byId = (id) => {
    if (!ids.has(id)) ids.set(id, new Element());
    return ids.get(id);
  };
  const apiState = { fails: false, requests: 0 };
  const context = vm.createContext({
    byId, document: { createElement: (tag) => new Element(tag) },
    text: (value) => String(value || ''), showStatus() {},
    api: async (_path, { body }) => {
      apiState.requests++;
      if (apiState.fails) throw new Error('synthetic save failure');
      return { ...JSON.parse(body), parent_reviewed_at: '2026-09-06T01:00:00Z' };
    },
  });
  vm.runInContext(
    source.slice(source.indexOf('const statusLabels ='), source.indexOf('const defaultActivities ='))
    + '\nlet allJournal = []; let journalVisible = 4;\n'
    + source.slice(source.indexOf('function formatTime('), source.indexOf('function listText('))
    + source.slice(source.indexOf('function appendQuestionQuotes('), source.indexOf('function renderToday('))
    + source.slice(source.indexOf('function skillStatusLabel('), source.indexOf('function renderMemories('))
    + source.slice(source.indexOf('function renderJournal('), source.indexOf('async function loadDashboard(')),
    context,
  );
  const select = () => byId('skillGroups').children[0].children[1].children[2];
  const practicingLabel = () => select().options.find((option) => option.value === 'practicing').textContent;
  const facts = () => byId('journalContent').children[0].children[1].children.map((item) => item.textContent).join('\n');
  return { context, apiState, select, practicingLabel, facts, journalRoot: () => byId('journalContent'), recoveryNotice: () => byId('skillRecoveryNotice') };
}

function skill(reviewed = false) {
  return { id: 'math.addition', name: '简单加法', domain: '数学', status: 'practicing',
    practice_count: 3, parent_reviewed_at: reviewed ? '2026-09-06T00:00:00Z' : '' };
}

test('a parent-classified episodic memory is a confirmed record without inventing a first occurrence', () => {
  const { context, facts } = setup();
  context.renderJournal([{ week: '2026-W36', milestones: ['今天独立画了一架飞机'] }]);
  assert.match(facts(), /已确认的成长记录：今天独立画了一架飞机/);
  assert.doesNotMatch(facts(), /第一次/);
});

test('automatic exposure and parent practice stay distinct across successful and failed saves', async () => {
  const { context, apiState, select, practicingLabel } = setup();
  const automatic = skill();
  context.renderSkills({ skills: [automatic] });
  assert.equal(practicingLabel(), '持续接触');
  select().value = 'mastered';
  await select().events.change();
  assert.equal(practicingLabel(), '持续练习');
  assert.ok(automatic.parent_reviewed_at);
  context.renderSkills({ skills: [skill(true)] });
  assert.equal(practicingLabel(), '持续练习');
  context.renderSkills({ skills: [skill()] });
  apiState.fails = true;
  select().value = 'mastered';
  await select().events.change();
  assert.equal(select().value, 'practicing');
  assert.equal(practicingLabel(), '持续接触');
});

test('journal renders sourced results and parent changes without inventing past practice or mastery', () => {
  const { context, facts } = setup();
  context.renderJournal([{
    week: '2026-W36', learning_progress: [{ name: '日常单词', turns: 4, trend: '↑' }],
    practice_results: [
      { source: 'local_number_activity', activity: 'numbers', question: '两加一，一共有几个？', correct: 1, incorrect: 3, last_result: 'correct' },
      { source: 'unknown', activity: 'numbers', question: '不应展示', correct: 100, last_result: 'correct' },
    ],
    skill_reviews: [{ name: '简单加法', previous_status: 'practicing', status: 'mastered', evidence: '爸爸看到独立摆出两加一' }],
  }]);
  assert.match(facts(), /话题接触 · 日常单词：4 轮/);
  assert.doesNotMatch(facts(), /↑|不应展示|持续练习 →/);
  assert.match(facts(), /数字练习记录：两加一，一共有几个？ · 答对 1 次、再试 3 次 · 最近一次答对/);
  assert.match(facts(), /单题结果不代表独立掌握/);
  assert.match(facts(), /爸爸确认：简单加法 · 接触或练习中 → 已经掌握（爸爸看到独立摆出两加一）/);
  assert.equal(context.formatSkillReview({ name: '数数', previous_status: 'not_started', status: 'practicing' }),
    '爸爸确认：数数 · 尚未开始 → 持续练习');
});

test('legacy journals without practice results or previous status remain readable', () => {
  const { context, facts } = setup();
  context.renderJournal([{ week: '2026-W35', learning_progress: [{ name: '日常单词', turns: 1, trend: '↑' }] }]);
  assert.equal(facts(), '话题接触 · 日常单词：1 轮');
  assert.equal(context.formatSkillReview({ name: '数数', status: 'practicing' }), '爸爸确认：数数 · 持续练习');
});

test('a damaged learning graph is visibly provisional and cannot submit edits until recovery', async () => {
  const { context, apiState, select, recoveryNotice } = setup();
  context.renderSkills({ skills: [skill()], recovery_required: true });
  assert.equal(recoveryNotice().hidden, false);
  assert.equal(select().disabled, true);
  select().value = 'mastered';
  await select().events.change();
  assert.equal(apiState.requests, 0);
  context.renderSkills({ skills: [skill()], recovery_required: false });
  assert.equal(recoveryNotice().hidden, true);
  assert.equal(select().disabled, false);
});

test('journal shows repeated family requests with expandable dated source text, without inventing emotions', () => {
  const { context, journalRoot } = setup();
  const request = { family_member: '爸爸', activity: '搭积木', count: 3,
    examples: [1, 2, 3].map(day => ({text: '我想和爸爸一起搭积木', created_at: `2026-09-0${day}T08:00:00Z`})) };
  context.renderJournal([{ week: '2026-W36', companionship_requests: [request] }]);
  const texts = element => [element.textContent, ...element.children.map(texts)].join('\n');
  const content = texts(journalRoot());
  assert.match(content, /本周 3 次提到：想和爸爸一起搭积木/);
  assert.match(content, /最近 3 条已完成对话的文字记录/);
  assert.equal((content.match(/“我想和爸爸一起搭积木”/g) || []).length, 3);
  assert.doesNotMatch(content, /孤独|失落|没有回应|没有形成足够/);
  const note = journalRoot().children[0].children[1].children[0];
  assert.equal(note.children[0].tag, 'details');
  assert.notEqual(note.children[0].open, true);
  assert.deepEqual(note.children[0].children[2].children.map(item => item.children[0].dateTime), request.examples.map(item => item.created_at));
});

test('journal ignores malformed or unsupported family aggregates and preserves source markup as text', () => {
  const { context, journalRoot } = setup();
  const examples = [{text: '<script>doNotRun()</script>', created_at: '2026-09-03T08:00:00Z'}];
  const valid = {family_member: '妈妈', activity: '画画', count: 3, examples};
  context.renderJournal([{week:'2026-W36', companionship_requests: [null, {...valid,count:2}, {...valid,family_member:'爸爸老师'}, {...valid,examples:[{text:'missing date'}]}, valid]}]);
  const notes = journalRoot().children[0].children[1].children;
  assert.equal(notes.length, 1);
  const words = notes[0].children[0].children[2].children[0].children[1];
  assert.equal(words.tag, 'p');
  assert.equal(words.textContent, '“<script>doNotRun()</script>”');
  assert.equal(words.children.length, 0);
});
