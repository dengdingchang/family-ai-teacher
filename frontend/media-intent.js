// Pure intent selection: no network, DOM, family data, or guessed ASR repair.
const TOPIC_ALIASES = [
  ["刷牙", ["刷牙", "牙刷", "牙齿", "牙齒"]], ["恐龙", ["恐龙", "恐龍", "霸王龙", "暴龍"]],
  ["月亮", ["月亮", "月球"]], ["太空", ["太空", "宇宙", "星球"]], ["鱼", ["鱼", "魚"]],
  ["钢琴", ["钢琴", "鋼琴", "琴键", "琴鍵"]], ["红绿灯", ["红绿灯", "紅綠燈", "交通灯", "交通燈"]],
];
const EDUCATION_TOPICS = [
  "蝴蝶", "蜜蜂", "熊猫", "长颈鹿", "大象", "海豚", "鲸鱼", "鲨鱼", "企鹅", "乌龟",
  "青蛙", "狮子", "老虎", "斑马", "袋鼠", "猫头鹰", "孔雀", "蜗牛", "蚂蚁", "瓢虫",
  "彩虹", "火山", "地震", "云朵", "闪电", "雪花", "太阳", "地球", "星星", "海洋",
  "森林", "沙漠", "河流", "瀑布", "山峰", "春天", "夏天", "秋天", "冬天", "太阳系",
  "木星", "火星", "土星", "火车", "飞机", "轮船", "汽车", "自行车", "直升机", "火箭",
  "小提琴", "吉他", "架子鼓", "长笛", "向日葵", "蒲公英", "苹果树", "水循环", "磁铁",
];
const TOPICS = [...TOPIC_ALIASES.flatMap(([topic, aliases]) => aliases.map(alias => [alias, topic])),
  ...EDUCATION_TOPICS.map(topic => [topic, topic])];
const CONTROL_CHARACTERS = { 圖: "图", 給: "给", 師: "师", 張: "张", 個: "个", 開: "开",
  剛: "刚", 來: "来", 幫: "帮", 視: "视", 頻: "频", 現: "现", 說: "说", 講: "讲",
  還: "还", 這: "这", 換: "换", 聽: "听", 畫: "画", 為: "为", 讓: "让" };
const normalize = value => String(value || "").replace(/\s+/g, "").slice(0, 400)
  .replace(/[圖給師張個開剛來幫視頻現說講還這換聽畫為讓]/g, char => CONTROL_CHARACTERS[char]);
const topicIn = text => TOPICS.filter(([alias]) => text.includes(alias))
  .sort((a, b) => b[0].length - a[0].length || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))[0]?.[1] || "";
const MEDIA_WORDS = /看|图片|图画|插图|照片|视频|短片|影片|画|生成/;
const REFUSAL = /不想|不要|不看|别|不用|不需要|算了|取消|关闭/;
const HISTORY = /昨天|以前|上次|如果|假如|等会|明天|之后|以后|说过|讲过/;
const MEDIA_NOUN = /图片|图画|插图|照片|视频|短片|影片/;
const PHYSICAL_OR_QUESTION = /(?:我|你|他|她|妈妈|爸爸)(?:说|讲|想|要|的)|为什么|怎么|是不是|有没有|看不到|看得见|手里|眼前/;
const REPLAY = /(?:(?:刚才|刚刚|之前)(?:的)?(?:那|这)?|那|这|上一)(?:一)?(?:张|个)?(?:图片|图画|图|照片|视频|短片|影片)/;

function childChoice(raw) {
  // Quoted requests describe speech; they do not authorize another image job.
  const quoted = /“[^”]*”|‘[^’]*’|"[^"]*"/g;
  let blocked = [...raw.matchAll(quoted)].some(match => MEDIA_WORDS.test(match[0]));
  const text = raw.replace(quoted, "");
  let choice = null, reported = false;
  for (let clause of text.split(/[，,。！？!?；;]/)) {
    if (/(?:说|讲|问)(?:过|了)?[：:]?$/.test(clause)) {
      reported = true; blocked = true; continue;
    }
    if (/^(?:但是|不过|现在)/.test(clause)) reported = false;
    if (reported) continue;
    clause = clause.replace(/^(?:爸爸老师|爸爸|老师|请|现在|但是|不过|然后|那|能不能|可以|能|帮我)+/, "");
    if (REFUSAL.test(clause) && (MEDIA_WORDS.test(clause) || /算了|取消|不要了|不用了/.test(clause))) {
      choice = null; blocked = true; continue;
    }
    if (HISTORY.test(clause) || /(?:妈妈|爸爸|他|她|别人|故事里).{0,8}(?:说|讲|想看|要看)/.test(clause)) {
      if (MEDIA_WORDS.test(clause)) blocked = true;
      continue;
    }
    const show = clause.match(/^(?:我(?:想要|想|要)(?:再)?(?:看(?:看|一看|一下)?|看一眼)|(?:再)?给我(?:再)?(?:看(?:看|一看|一下)?|打开|找(?:一张|个)?|展示)|(?:再)?(?:打开|放大|展示|看看|看一下|看一看))(.{1,65}?)(?:好不好|好吗|可以吗|吧|呀|啊|呢|吗)?$/);
    const draw = clause.match(/^(?:(?:给我|请你|你|帮我)|(?:我想请你|我想让你))?(?:画一张|画一个|画一幅|画幅|画出|生成一张|做一张)(.{1,65}?)(?:吧|呀|啊|好吗|可以吗)?$/)
      || clause.match(/^(?:给我|帮我)(?:画|生成|做)(.{1,65}?)(?:吧|呀|啊|好吗|可以吗)?$/)
      || clause.match(/^(?:我想要|我要)(?:一张|一个|一幅)?(.{1,65}(?:图片|图画|插图|照片))(?:吧|呀|啊)?$/);
    const subject = show?.[1] || draw?.[1];
    if (subject && !PHYSICAL_OR_QUESTION.test(subject)) {
      if (REPLAY.test(subject)) { choice = null; blocked = true; continue; }
      const topic = topicIn(subject);
      // Unknown/private topics never fall back to an old topic from the reply.
      blocked = true;
      choice = topic ? { topic, generateImage: !!draw } : null;
      continue;
    }
    if (/^(?:我想|我要|我们|一起|给我|教我|带我)(?:要)?(?:听|学|画|玩|唱|下)/.test(clause)) {
      choice = null; blocked = true;
    }
  }
  return { choice, blocked };
}

function teacherChoice(text, childTopic = "") {
  // One definite display/narration clause must contain both the action and topic.
  for (const clause of text.replace(/“[^”]*”|‘[^’]*’|"[^"]*"/g, "").split(/[，,。！？!?；;]/)) {
    if (REFUSAL.test(clause) || HISTORY.test(clause) || /不能|无法|没能|没有|手里|眼前|你来|你自己/.test(clause)) continue;
    const draw = /^(?:我|爸爸老师|爸爸)(?:现在|马上|来|可以|给你|为你|帮你){0,4}(?:画|生成|做)(?:一张|一个|一幅|幅)?/.test(clause)
      && (MEDIA_NOUN.test(clause) || /(?:画|生成|做)(?:一张|一幅|幅)/.test(clause));
    const show = /^(?:(?:我|爸爸老师|爸爸)(?:现在|马上|来|可以){0,3})?(?:给你看|给你展示|展示给你)/.test(clause)
      || /^(?:我们(?:来)?|来|一起)(?:看看|看一看|一起看|看一下|看)/.test(clause) && !!topicIn(clause);
    if (draw || show) {
      const topic = childTopic || topicIn(clause);
      if (topic) return { topic, generateImage: !/视频|短片|影片/.test(clause) };
    }
  }
  return null;
}

export function chooseMediaSuggestion(childText, assistantText = "") {
  const child = normalize(childText), teacher = normalize(assistantText);
  // These are the server's local parent-boundary replies, not a model guess.
  if (/这个话题今天先放一放|这个活动今天先休息/.test(teacher)) return null;
  const { choice, blocked } = childChoice(child);
  if (choice) {
    // A clear child topic always wins, including when an old model reply drifts.
    const presentation = teacherChoice(teacher, choice.topic);
    return { ...choice, generateImage: choice.generateImage || !!presentation?.generateImage };
  }
  if (blocked) return null;
  return teacherChoice(teacher, topicIn(child));
}
