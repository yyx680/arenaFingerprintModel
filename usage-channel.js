/* Arena 用量通道（v2.11.0）—— 把 arena.ai 真实下发的「每次请求 token 用量」接进探针。

   实测背景（2026-10-11，CDP 直连调试实例，详见 Arena成本接口实测.md）：
   · 发一条消息后，GET /api/evaluation/<sid> 的 messages[].metadata 里带：
       "usage": {"type":"language_model","inputTokens":6,"outputTokens":4142,
                 "totalTokens":15291,"cacheReadTokens":0,"cacheWriteTokens":11143,
                 "reasoningTokens":0,"usageSource":"provider"}
   · 但 **没有美元成本字段**（metadata.cost 为 null）；美元价由前端 useCostContext
     按「token 数 × 模型单价」自己算（CREDITS_PER_USD / MESSAGE_COST_OPTIONAL_NUMBER_FIELDS）。
   · /api/evaluation/<sid>/cost 这个路由真实存在，但返回 403 {"error":"Unauthorized"}，会话 cookie 拿不到。

   所以这里把 usage 当成一条**独立的只读证据通道**：
     1) 归一化 token 用量（纯函数，便于测试）；
     2) 提取「用量形态」—— cacheWriteTokens 只在支持 prompt caching 的厂商出现，
        reasoningTokens 只在推理模型出现，这两者是相当强的厂商/模型类别旁证；
     3) 一旦拿到单价表，可用 estimateCostUsd 折算成美元，再交给 price-channel 做成本一致性检查。

   铁律：纯函数 + 只读，不发请求、不写存储、不改动指纹评分结果。 */

import './token-estimator.js';
const tokenEstimator = globalThis.ArenaTokenEstimator;
export const normalizeEstimateBucket = tokenEstimator.normalize;

export const USAGE_SCHEMA = 'arena-message-usage';

/** Arena 归一化用量里出现过的数值字段（camelCase，实测）。 */
export const USAGE_NUMBER_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
]);

/** 单字段上限，防止把异常大数当证据。 */
const MAX_TOKENS = 1e9;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const nonNeg = (value) => finite(value) && value >= 0;

/** 把一条原始 usage 对象归一化成稳定结构；没有可用 token 字段时返回 null。 */
export function parseUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {schema: USAGE_SCHEMA, type: typeof raw.type === 'string' ? raw.type.slice(0, 40) : null, usage_source: typeof raw.usageSource === 'string' ? raw.usageSource.slice(0, 40) : null};
  let has = false;
  for (const field of USAGE_NUMBER_FIELDS) {
    const value = raw[field];
    if (!nonNeg(value) || value > MAX_TOKENS) continue;
    out[field] = Math.round(value);
    has = true;
  }
  if (!has) return null;
  if (!nonNeg(out.totalTokens)) out.totalTokens = totalOf(out);
  // 全 0 用量没有信息量，丢弃（避免把空对象当证据）。
  if (!(out.totalTokens > 0) && totalOf(out) === 0) return null;
  return out;
}

/** 用各分项之和补齐 totalTokens（Arena 有时不给 totalTokens）。 */
export function totalOf(usage) {
  if (!usage) return 0;
  return (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
}

/** 用量形态：厂商/模型类别的强旁证（缓存写入、缓存读取、推理 token）。 */
export function usageShape(usage) {
  if (!usage) return null;
  const total = usage.totalTokens || totalOf(usage) || 0;
  const share = (value) => (total > 0 ? Number(((value || 0) / total).toFixed(4)) : 0);
  return {
    has_cache_write: (usage.cacheWriteTokens || 0) > 0,
    has_cache_read: (usage.cacheReadTokens || 0) > 0,
    has_reasoning: (usage.reasoningTokens || 0) > 0,
    cache_write_share: share(usage.cacheWriteTokens),
    cache_read_share: share(usage.cacheReadTokens),
    reasoning_share: share(usage.reasoningTokens),
    output_share: share(usage.outputTokens),
    signature: `${(usage.cacheWriteTokens || 0) > 0 ? 'cw' : '--'}${(usage.cacheReadTokens || 0) > 0 ? 'cr' : '--'}${(usage.reasoningTokens || 0) > 0 ? 'rz' : '--'}`,
  };
}

export const SHAPE_LABEL = Object.freeze({
  cw: '缓存写入',
  cr: '缓存读取',
  rz: '推理 token',
});

/** 人读描述，用于浮层/诊断输出。 */
export function describeUsage(usage) {
  if (!usage) return '—';
  const parts = [`in ${usage.inputTokens ?? 0}`, `out ${usage.outputTokens ?? 0}`];
  if (usage.cacheReadTokens) parts.push(`cacheR ${usage.cacheReadTokens}`);
  if (usage.cacheWriteTokens) parts.push(`cacheW ${usage.cacheWriteTokens}`);
  if (usage.reasoningTokens) parts.push(`reason ${usage.reasoningTokens}`);
  parts.push(`total ${usage.totalTokens ?? totalOf(usage)}`);
  return parts.join(' / ');
}

/** 把多条 usage 合并（同一轮两个参与方、或同一模型多次请求）。 */
export function sumUsage(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = {schema: USAGE_SCHEMA, type: null, usage_source: null, requests: 0};
  for (const item of list) {
    const usage = item && item.schema === USAGE_SCHEMA ? item : parseUsage(item);
    if (!usage) continue;
    out.requests += 1;
    for (const field of USAGE_NUMBER_FIELDS) out[field] = (out[field] || 0) + (usage[field] || 0);
    if (!out.type && usage.type) out.type = usage.type;
    if (!out.usage_source && usage.usage_source) out.usage_source = usage.usage_source;
  }
  if (!out.requests) return null;
  if (!out.totalTokens) out.totalTokens = totalOf(out);
  return out;
}

/** 单价表（每百万 token 美元）折算美元成本；缺单价时返回 null，绝不猜。 */
export function estimateCostUsd(usage, rates) {
  if (!usage || !rates || typeof rates !== 'object') return null;
  const per = (field, key) => {
    const rate = rates[key];
    if (!finite(rate) || rate < 0) return null;
    return ((usage[field] || 0) / 1e6) * rate;
  };
  const parts = [
    per('inputTokens', 'input_usd_per_mtok'),
    per('outputTokens', 'output_usd_per_mtok'),
    per('cacheReadTokens', 'cache_read_usd_per_mtok'),
    per('cacheWriteTokens', 'cache_write_usd_per_mtok'),
  ].filter((value) => value !== null);
  if (!parts.length) return null;
  return Number(parts.reduce((sum, value) => sum + value, 0).toFixed(6));
}

/* ---------- 从响应文本里抽取 ---------- */

/** 从 start（指向 '{'）开始做花括号配对，返回平衡的子串；超长或失衡返回 null。 */
export function sliceBalanced(text, start, maxLen = 4000) {
  const source = String(text || '');
  if (source[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const end = Math.min(source.length, start + maxLen);
  for (let i = start; i < end; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** 逐字段兜底正则（camelCase + snake_case 都覆盖）。 */
const FIELD_RE = /"(inputTokens|outputTokens|totalTokens|cacheReadTokens|cacheWriteTokens|reasoningTokens|input_tokens|output_tokens|total_tokens|cache_read_tokens|cache_write_tokens|reasoning_tokens)"\s*:\s*(\d+)/g;
const SNAKE = Object.freeze({
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  total_tokens: 'totalTokens',
  cache_read_tokens: 'cacheReadTokens',
  cache_write_tokens: 'cacheWriteTokens',
  reasoning_tokens: 'reasoningTokens',
});

/** 从一段（可能是流式/转义的）响应文本里抽出所有 usage 记录。 */
export function extractUsageSignals(text, where = '', url = '') {
  const source = String(text || '');
  if (!source || source.length > 400000) return [];
  if (!/Tokens|tokens/.test(source)) return [];
  const out = [];
  const seen = new Set();
  const push = (usage, via) => {
    const key = USAGE_NUMBER_FIELDS.map((f) => usage[f] || 0).join(',');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({kind: 'usage', where: String(where).slice(0, 60), url: String(url).slice(0, 200), via, usage, shape: usageShape(usage)});
  };

  // 1) 正规路径：定位 "usage": { ... } 后解析
  let idx = 0;
  let guard = 0;
  while (guard < 24) {
    const at = source.indexOf('"usage"', idx);
    if (at < 0) break;
    guard += 1;
    const brace = source.indexOf('{', at);
    if (brace < 0 || brace - at > 40) { idx = at + 7; continue; }
    const slice = sliceBalanced(source, brace, 2000);
    idx = brace + 1;
    if (!slice) continue;
    let parsed = null;
    try { parsed = JSON.parse(slice); } catch {
      try { parsed = JSON.parse(slice.replace(/\\"/g, '"')); } catch { parsed = null; }
    }
    const usage = parseUsage(parsed);
    if (usage) push(usage, 'usage-object');
  }

  // 2) 兜底：单字段正则（流式分片里对象可能被截断）
  if (!out.length) {
    FIELD_RE.lastIndex = 0;
    const loose = {type: null, usageSource: null};
    let match;
    let n = 0;
    while ((match = FIELD_RE.exec(source)) && n < 12) {
      n += 1;
      const field = SNAKE[match[1]] || match[1];
      const value = Number(match[2]);
      if (!nonNeg(value) || value > MAX_TOKENS) continue;
      loose[field] = value;
    }
    const usage = parseUsage(loose);
    if (usage) push(usage, 'field-regex');
  }

  return out;
}

/** 从一组 usage 信号里取「最近一次请求」的用量（用于展示单次成本）。 */
export function latestUsage(signals) {
  if (!Array.isArray(signals) || !signals.length) return null;
  const valid = signals.filter((item) => item && item.usage);
  if (!valid.length) return null;
  const last = valid[valid.length - 1];
  return {usage: last.usage, shape: last.shape || usageShape(last.usage), where: last.where || '', at: last.at || null};
}

/* ---------- v2.14.0 转录字数 → token 估算（Agent 会话） ----------

   背景：Agent 会话（`GET /api/chat/<sid>`）**不下发** token 用量 —— messages[].metadata
   里没有 usage 字段（实测），实时流是 Trigger.dev 二进制帧，`/cost` 又按账号灰度。
   于是不需要任何特权的口径只剩一个：把转录里模型生成的文字（正文 + thinking）数字符，
   按字形系数折成 token，再配公开单价进账本（见 cost-ledger.js）。

   实测 part 形状（v2.14.0 抓包）：{type:'step-start'} / {type:'reasoning', text, state} /
   {type:'text', text, state}。非文本 part 只计数不取内容（工具帧 v1 不估）。

   铁律不变：纯函数、只读、不发请求。这里算出来的**一律标 estimate**，绝不冒充服务端数字。 */

export const ESTIMATE_METHOD = 'chars-v2';
// 保留旧计数的兼容系数；v2 使用共享分段特征，不承诺固定误差率。
export const ESTIMATE_RATES = Object.freeze({cjk_tokens_per_char: 1, other_tokens_per_char: 0.27});
export const countChars = tokenEstimator.count;
export function estimateTokensFromChars(stats) {
  return tokenEstimator.estimate(stats).tokens;
}

/** 一条消息的生成文字统计：正文（text part）与思考（reasoning part）分开算。 */
export function messageTextStats(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const text = tokenEstimator.empty();
  const reasoning = tokenEstimator.empty();
  let skipped_parts = 0;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const bucket = part.type === 'text' ? text : (part.type === 'reasoning' ? reasoning : null);
    if (!bucket) {
      if (part.type !== 'step-start' && part.type !== 'step-finish') skipped_parts += 1;
      continue;
    }
    const counted = countChars(typeof part.text === 'string' ? part.text : '');
    tokenEstimator.add(bucket, counted);
  }
  return {text, reasoning, skipped_parts};
}

/** 一条消息的估算用量（只对 assistant 有意义）：outputTokens = 正文 + thinking 的估算和，
    reasoningTokens 是其中 thinking 的部分（已含在 outputTokens 里，不重复计）。 */
export function estimateUsageFromStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const textEstimate = tokenEstimator.estimate(stats.text);
  const reasoningEstimate = tokenEstimator.estimate(stats.reasoning);
  const textTokens = textEstimate.tokens;
  const reasoningTokens = reasoningEstimate.tokens;
  const outputTokens = textTokens + reasoningTokens;
  if (!(outputTokens > 0)) return null;
  const methods = [...new Set([textEstimate, reasoningEstimate].filter(item => item.tokens > 0).map(item => item.method))];
  const method = methods.length === 1 ? methods[0] : 'chars-v2+legacy';
  return {
    usage: {
      schema: USAGE_SCHEMA,
      type: 'language_model',
      usage_source: method,
      outputTokens,
      reasoningTokens,
      totalTokens: outputTokens,
    },
    estimate: {
      method,
      chars: {text: stats.text?.chars || 0, reasoning: stats.reasoning?.chars || 0},
      output_is_estimate: true,
      output_range: {low: textEstimate.low + reasoningEstimate.low, high: textEstimate.high + reasoningEstimate.high},
      text_tokens: textTokens,
      visible_reasoning_tokens: reasoningTokens,
      skipped_parts: Math.max(0, Number(stats.skipped_parts) || 0),
      range_kind: 'heuristic-sensitivity',
      calibrated: false,
      coverage: 'visible-text-only',
      note: `${method} 分类型启发式估算；数字组、英文词段、标点/空白、CJK 与其他 Unicode 分开处理。参考范围未校准，不是置信区间或计费总量上下界；不含完整输入上下文、缓存、工具内容及未公开的推理。旧计数缺少特征时保留 v1 回退。`,
    },
  };
}

/** `/api/chat/<sid>` 整体统计：逐条 assistant 的估算 + 用户文字的输入下界。 */
export function transcriptStats(payload) {
  const source = payload && typeof payload === 'object' ? payload : null;
  const messages = Array.isArray(source?.messages) ? source.messages : (Array.isArray(source) ? source : null);
  if (!messages) return null;
  const rows = [];
  const totals = {messages: 0, assistants: 0, text_chars: 0, reasoning_chars: 0, output_tokens: 0, input_tokens_lower_bound: 0, skipped_parts: 0};
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const stats = messageTextStats(message);
    const built = estimateUsageFromStats(stats);
    const isAssistant = message.role === 'assistant' && !!built;
    const userInput = message.role === 'user' ? estimateTokensFromChars(stats.text) : 0;
    rows.push({
      message_id: typeof message.id === 'string' ? message.id.slice(0, 64) : null,
      role: typeof message.role === 'string' ? message.role : null,
      model_id: typeof message.modelId === 'string' ? message.modelId : null,
      stats,
      output_tokens: isAssistant ? built.usage.outputTokens : 0,
      reasoning_tokens: isAssistant ? built.usage.reasoningTokens : 0,
      input_tokens_lower_bound: userInput,
    });
    totals.messages += 1;
    totals.text_chars += stats.text.chars;
    totals.reasoning_chars += stats.reasoning.chars;
    totals.skipped_parts += stats.skipped_parts;
    if (isAssistant) { totals.assistants += 1; totals.output_tokens += built.usage.outputTokens; }
    totals.input_tokens_lower_bound += userInput;
  }
  return {method: ESTIMATE_METHOD, rates: ESTIMATE_RATES, messages: rows, totals};
}
