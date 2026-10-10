/* v2.9.3 文本词频通道：固定判别探针 + BoW 词频余弦相似度。
   依据：arXiv 2501.07493（与 Chatbot Arena 官方合作的去匿名化研究）——
   固定提示下，词频特征+线性分类器对模型版本的区分度 95%+；数学/编程/中文提示区分度最高。
   纯函数、无 DOM / 无 chrome API：经典脚本里把 API 挂到 ArenaProbeRuntime（若有），模块环境 import 后同样可读。 */

/* 固定判别探针：数学 / 中文 / 编程各两条（论文实测区分度最高的三类），建档与匿名局评分用同一组。 */
const TEXT_PROBES = Object.freeze([
  Object.freeze({id: 'text-math-1', prompt: 'Solve step by step: what is 37*54+123? Give the final number on its own line at the end.'}),
  Object.freeze({id: 'text-math-2', prompt: '用一两句话解释鸽笼原理，然后给一个生活中的例子。'}),
  Object.freeze({id: 'text-zh-1', prompt: '用中文写一段 80 字左右的短文，主题：下雨天的城市。'}),
  Object.freeze({id: 'text-zh-2', prompt: '把这句话翻译成英文，并用一句话解释你的翻译选择：「摸着石头过河」。'}),
  Object.freeze({id: 'text-code-1', prompt: 'Write a short Python function is_palindrome(s) and show one test case.'}),
  Object.freeze({id: 'text-code-2', prompt: 'Explain the difference between let and var in JavaScript in three sentences.'}),
]);
/* 匿名局评分只发这三条（区分度最高的三个类别各一），控制消息数。 */
const TEXT_SCORE_PROBES = Object.freeze(['text-math-1', 'text-zh-1', 'text-code-1']);
/* 建档目标：每个模型每个提示的响应数。 */
const TEXT_BANK_TARGET = 12;
/* 评分门槛：某模型某提示的参考响应数达到该值才参与打分（两轮自动建档即可生效）。 */
const TEXT_MIN_RESPONSES = 2;

/** 小写化取词（字母/数字），过滤 1 字符与超长串，单条回复最多 4000 词。 */
function tokenizeText(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.filter(word => word.length >= 2 && word.length <= 24).slice(0, 4000);
}

/** 词频向量。 */
function textToCounts(text) {
  const counts = {};
  for (const word of tokenizeText(text)) counts[word] = (counts[word] || 0) + 1;
  return counts;
}

/** 词频余弦相似度（0–1）。 */
function textCosine(left, right) {
  const l = left || {}, r = right || {};
  let dot = 0, la = 0, ra = 0;
  const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
  for (const key of keys) {
    const a = Number(l[key]) || 0, b = Number(r[key]) || 0;
    dot += a * b; la += a * a; ra += b * b;
  }
  return la > 0 && ra > 0 ? dot / Math.sqrt(la * ra) : 0;
}

const textChannelApi = Object.freeze({TEXT_PROBES, TEXT_SCORE_PROBES, TEXT_BANK_TARGET, TEXT_MIN_RESPONSES, tokenizeText, textToCounts, textCosine});
try {
  const runtime = globalThis.ArenaProbeRuntime;
  if (runtime && typeof runtime === 'object') {
    Object.defineProperty(globalThis, 'ArenaProbeRuntime', {
      value: Object.freeze(Object.assign({}, runtime, textChannelApi)),
      configurable: true,
      writable: false,
    });
  }
} catch { /* 拿不到就算了，调用方按「通道不可用」处理 */ }
