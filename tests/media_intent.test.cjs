const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const api = import(pathToFileURL(path.join(__dirname, "../frontend/media-intent.js")).href);

test("explicit child image topics win over old lesson words and generic look hints", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  assert.deepEqual(choose("我想看大蝴蝶", "小提示：看看衣服、玩具或积木。你找到红色了吗？"), { topic: "蝴蝶", generateImage: false });
  assert.deepEqual(choose("给我看看飞机图片", "鱼会游泳，我们继续找红色。"), { topic: "飞机", generateImage: false });
  assert.deepEqual(choose("我想看一下彩虹", "我们一起看月亮的图片。"), { topic: "彩虹", generateImage: true });
});

test("longest canonical alias preserves whale, shark, and solar system", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  for (const [query, topic] of [["鲸鱼", "鲸鱼"], ["鲨鱼", "鲨鱼"], ["太阳系", "太阳系"], ["月球", "月亮"], ["霸王龙", "恐龙"], ["牙齒", "刷牙"]]) {
    assert.deepEqual(choose(`我想看${query}的图片`, ""), { topic, generateImage: false });
  }
});

test("short look imperatives work without requiring the child to say I want", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  for (const [child, topic] of [["看看彩虹", "彩虹"], ["看一下月亮", "月亮"], ["爸爸老师，看一看蝴蝶吧", "蝴蝶"]])
    assert.deepEqual(choose(child, ""), { topic, generateImage: false });
  for (const child of ["看看衣服玩具", "看看你手里的蝴蝶", "别看看彩虹", "昨天看看彩虹"])
    assert.equal(choose(child, ""), null, child);
});

test("pure text about a supported topic never launches media without a clear teacher offer", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  for (const pair of [
    ["我喜欢蝴蝶", "蝴蝶会飞。你喜欢什么颜色？"],
    ["磁铁能吸什么", "磁铁能吸一些铁做的东西。"],
    ["蝴蝶", "小提示：看看衣服、玩具或积木。"],
    ["彩虹为什么有颜色", "看看你手里的彩虹积木。"],
    ["好", "我们继续找红色，看看玩具里有没有。"],
  ]) assert.equal(choose(...pair), null, pair.join(" / "));
});

test("refused, reported, historical, and cancelled media cannot be revived by the teacher", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  for (const child of [
    "我不想看蝴蝶", "不要给我看蝴蝶", "别画蝴蝶图片", "我不想画一张蝴蝶",
    "妈妈说我想看蝴蝶", "妈妈说，我想看蝴蝶", "妈妈说：我想看蝴蝶",
    "昨天我想看蝴蝶", "如果我想看蝴蝶", "故事里说“我想看蝴蝶”",
    "我想看蝴蝶，不想看了", "我想看蝴蝶，算了", "我想看蝴蝶，不要给我看了",
    "我想看蝴蝶，然后我想听故事", "我想画蝴蝶", "给我看小明的照片",
  ]) assert.equal(choose(child, "我们一起看看蝴蝶的图片。"), null, child);
});

test("a later current request may replace a refused or reported topic", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  assert.deepEqual(choose("不要蝴蝶，我想看彩虹", ""), { topic: "彩虹", generateImage: false });
  assert.deepEqual(choose("妈妈说，不过我想看彩虹", ""), { topic: "彩虹", generateImage: false });
});

test("explicit drawing requests retain Codex generation intent", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  for (const child of ["画一张蝴蝶图片", "给我画一个蝴蝶", "画幅蝴蝶的图", "画出蝴蝶", "生成一张蝴蝶图片", "做一张蝴蝶插图", "给我画蝴蝶图片", "我要一张蝴蝶的图片"]) {
    assert.deepEqual(choose(child, ""), { topic: "蝴蝶", generateImage: true }, child);
  }
});

test("explicit teacher drawing and educational display may introduce a topic", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  for (const teacher of ["我来画一张磁铁的图片。", "我来画一张磁铁。", "爸爸老师给你画一张磁铁图画。", "我们一起看看磁铁的图片。", "给你看一张磁铁图片。", "我给你展示磁铁。"])
    assert.deepEqual(choose("好的", teacher), { topic: "磁铁", generateImage: true }, teacher);
  assert.deepEqual(choose("磁铁能吸什么", "我来画一张图片。"), { topic: "磁铁", generateImage: true });
});

test("negative, hypothetical, quoted, and child-led drawing replies are not offers", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  for (const teacher of ["我不能给你画蝴蝶图片。", "不要看蝴蝶图片。", "如果我们看看蝴蝶图片呢？", "故事里说“我来画一张蝴蝶图片”。", "你来画一张蝴蝶图片。", "我们看看你手里的蝴蝶。", "蝴蝶会飞，看看积木。"])
    assert.equal(choose("蝴蝶", teacher), null, teacher);
});

test("reopening existing images never starts a new media or generation job", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  for (const child of ["爸爸老师，再给我看刚才的图片", "再给我看看刚才那张图", "打开刚才的图片"]) {
    assert.equal(choose(child, "我们再看看刚才的蝴蝶图片。"), null, child);
  }
});

test("video requests do not cause image generation from a topic mention", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  assert.deepEqual(choose("给我看看刷牙的视频", "我们一起看刷牙的视频。"), { topic: "刷牙", generateImage: false });
});

test("server parent-boundary replies cannot be bypassed by a valid child request", async () => {
  const { chooseMediaSuggestion: choose } = await api;
  assert.equal(choose("我想看蝴蝶", "这个话题今天先放一放。我们数手指好吗？"), null);
  assert.equal(choose("画一张蝴蝶图片", "这个活动今天先休息。"), null);
});
