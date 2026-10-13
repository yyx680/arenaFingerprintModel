/* Arena 花费账本（v2.13.2）—— 把「这次会话花了多少」算出来并摊成逐条明细。

   为什么能算：Arena 公开每个模型的 token 单价（`arena-pricing-table.json`，USD/百万 token），
   而每条消息的真实 token 用量是**下发**的（`GET /api/evaluation/<sid>` 的
   `messages[].metadata.usage`，见 usage-channel.js）。两者相乘就是基准价：

       基准价(base) = Σ tokensᵢ/1e6 × 单价ᵢ(模型)

   实测确认（Arena成本接口实测.md §7）：Arena 界面上的 `charged = base × 2`，
   而 `base` 正是上面这个口径 —— 所以只要知道是哪个模型，花费就能算出来，不需要计费账号。

   三档数字的关系（都能在界面上核对）：
       base     ← 本模块算的（公开单价 × 实测 token 用量）
       charged  ← 页面下发（= base × 倍率），只有已开通计费的账号才有
       credits  ← 页面下发（= charged × 1000，即 CREDITS_PER_USD）

   铁律：纯函数 + 只读数据。不发请求、不写存储、不改动指纹评分结果。
   没有真实成本时本模块依然给出 base（标 `source:'pricing-table'`）；
   有真实成本时用真实值并标 `source:'cost-route'`，两者可逐条对照。 */

import {parseUsage, totalOf, describeUsage, estimateUsageFromStats, estimateTokensFromChars, transcriptStats, ESTIMATE_METHOD} from './usage-channel.js';
import {bankPricing, expectedCostUsd} from './pricing-channel.js';

export const LEDGER_SCHEMA = 'arena-cost-ledger';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;

/** 金额显示：小额多给有效位，0 显示 $0，无效显示 —。 */
export function formatUsd(value) {
  if (!finite(value)) return '—';
  if (value === 0) return '$0';
  if (value < 0.0001) return `$${value.toExponential(2)}`;
  if (value < 1) return `$${Number(value.toFixed(6))}`;
  return `$${Number(value.toFixed(4))}`;
}

/** 金额显示（表格用，固定 4 位小数，便于纵向对齐）。 */
export function formatUsdFixed(value, digits = 4) {
  return finite(value) ? `$${value.toFixed(digits)}` : '—';
}

/* ---------- 1. 结构化抽取逐条用量 ---------- */

/** 从 `/api/evaluation/<sid>`（或 `/api/chat/<id>`）的响应体里抽出**逐条消息**的用量。
 *
 *  与 usage-channel.extractUsageSignals 的区别：那个只按 `"usage":{...}` 扫字段、不带消息身份；
 *  这里解析整个 JSON，把 messageId / role / participantPosition / modelId 一起带出来，
 *  才能摊成「逐条明细」表。
 *
 *  实测消息形状：
 *    {id:"01a1…", role:"assistant", participantPosition:"a", modelId:null,
 *     metadata:{usage:{inputTokens,outputTokens,…}, workflowRunId:"run_x"}} */
export function extractMessageUsage(text) {
  const source = String(text || '');
  if (!source || source.length > 400000 || !source.includes('"usage"')) return [];
  let parsed = null;
  try { parsed = JSON.parse(source); } catch { return []; }
  const messages = parsed?.messages;
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const usage = parseUsage(message.metadata?.usage);
    if (!usage) continue;
    out.push({
      message_id: typeof message.id === 'string' ? message.id.slice(0, 64) : null,
      role: typeof message.role === 'string' ? message.role.slice(0, 20) : null,
      position: typeof message.participantPosition === 'string' ? message.participantPosition.slice(0, 4) : null,
      model_id: typeof message.modelId === 'string' ? message.modelId.slice(0, 120) : null,
      usage,
    });
  }
  return out;
}

/* ---------- 2. 单价 × 用量 → 基准价 ---------- */

/** 一条用量在某个模型下的基准价（未加价）。
 *  `modelId` 可以是 Arena 变体 key，也可以是指纹库基础 id（自动展开全部变体，取 min/max 区间）。
 *  模型未知或没价时返回 `{priced:false}` —— **绝不猜价**。 */
export function baseCostFor(usage, modelId, table) {
  if (!usage || !modelId || !table) return {priced: false, reason: 'no-model-or-usage'};
  const priced = bankPricing(modelId, table);
  if (!priced?.priced) return {priced: false, reason: 'no-price', model: modelId};
  const usds = [];
  let complete = true;
  for (const key of priced.keys) {
    const profile = table.profile(key);
    if (!profile) continue;
    const expected = expectedCostUsd(usage, profile);
    if (!expected || !(expected.usd > 0)) continue;
    usds.push(expected.usd);
    if (!expected.complete) complete = false;
  }
  if (!usds.length) return {priced: false, reason: 'zero-cost', model: modelId};
  return {
    priced: true,
    model: modelId,
    usd: Number(Math.min(...usds).toFixed(6)),
    min_usd: Number(Math.min(...usds).toFixed(6)),
    max_usd: Number(Math.max(...usds).toFixed(6)),
    variants: usds.length,
    complete,
  };
}

/* ---------- 2b. `/cost` 路由 → 逐条明细（服务端权威值，无需 token） ---------- */

/** 把 `GET /api/chat/:id/cost`（Agent）或 `/api/evaluation/:id/cost`（Battle）响应的
 *  `messages` 映射摊成账本行。与 `extractMessageUsage` 的产出**同形**，差别是这里没有 token 用量，
 *  只有服务端给的金额 —— 所以 `tokens` / `usage` 为 null，`source` 标 `cost-route`。
 *
 *  实测响应形状（见 Arena成本接口实测.md §7）：
 *    {session:{actualTotalUsd, chargedTotalUsd, basePriceUsd, costMultiplier, marginMultiplier},
 *     messages:{[messageId]:{actual:{totalCostUsd, basePriceUsd, totalChargedUsd, totalChargedCredits, …}}}}
 *
 *  这是 Agent 模式**唯一**可能的金额来源：Agent 的会话包不下发 token 用量，
 *  实时流是 Trigger.dev 的二进制帧，所以只能指望这个路由（本账号实测 403）。 */
export function ledgerRowsFromCostMessages(messages) {
  if (!messages || typeof messages !== 'object') return [];
  const rows = [];
  let index = 0;
  for (const [messageId, entry] of Object.entries(messages)) {
    if (!entry || typeof entry !== 'object') continue;
    const actual = entry.actual && typeof entry.actual === 'object' ? entry.actual : entry;
    /* 双来源：actual 子对象优先，回退 entry 顶层。实测 /cost 的 schema 是
       「basePriceUsd / totalChargedUsd / totalChargedCredits / pricingStrategy / marginMultiplier
       在 entry 顶层，上游明细在 actual 里」—— 只看 actual 会把 base 落到 totalCostUsd（上游口径），
       charged/credits 直接丢。key 顺序仍是 basePriceUsd → … → totalCostUsd，不会混口径。 */
    const pick = (...keys) => {
      for (const key of keys) {
        const value = Number(actual[key] ?? entry[key]);
        if (finite(value) && value > 0) return value;
      }
      return null;
    };
    const base = pick('basePriceUsd', 'base_price_usd', 'totalCostUsd');
    const charged = pick('totalChargedUsd', 'total_charged_usd') ?? (positive(Number(entry.charged)) ? Number(entry.charged) : null);
    const credits = pick('totalChargedCredits', 'total_charged_credits');
    const multiplier = positive(Number(entry.marginMultiplier)) ? Number(entry.marginMultiplier)
      : (positive(Number(entry.costMultiplier)) ? Number(entry.costMultiplier) : null);
    if (base === null && charged === null && credits === null) continue;
    /* v2.19.1：把 /cost 的**四项分项费用**也带出来（输入/输出/缓存写/缓存读），
       供价格指纹面板按表格展示「消费级明细」。缺项记 null（≠0），不与「该项为 0」混淆。 */
    const part = (...keys) => {
      for (const key of keys) {
        const value = Number(actual[key] ?? entry[key]);
        if (finite(value) && value >= 0) return value;
      }
      return null;
    };
    const breakdown = {
      input_usd: part('inputTokensCostUsd', 'input_tokens_cost_usd'),
      output_usd: part('outputTokensCostUsd', 'output_tokens_cost_usd'),
      cache_write_usd: part('cacheWriteTokensCostUsd', 'cache_write_tokens_cost_usd'),
      cache_read_usd: part('cacheReadTokensCostUsd', 'cache_read_tokens_cost_usd'),
    };
    const hasBreakdown = Object.values(breakdown).some((value) => value !== null);
    index += 1;
    rows.push({
      schema: LEDGER_SCHEMA,
      index,
      message_id: messageId,
      role: null,
      position: null,
      model: typeof actual.model === 'string' ? actual.model : (typeof entry.model === 'string' ? entry.model : null),
      usage: null,
      tokens: null,
      usage_text: null,
      base_usd: base,
      base_min_usd: base,
      base_max_usd: base,
      variants: 0,
      complete: true,
      actual_usd: pick('totalCostUsd', 'total_cost_usd'),
      charged_usd: charged,
      credits,
      multiplier,
      pricing_strategy: typeof entry.pricingStrategy === 'string' ? entry.pricingStrategy : null,
      breakdown: hasBreakdown ? breakdown : null,
      source: 'cost-route',
    });
  }
  return rows;
}

/* ---------- 2c. 转录字数估算 → 账本行（Agent 会话，v2.14.0） ----------

   Agent 会话既没有 token 用量（会话包 metadata 无 usage）、也没有 /cost 金额（按账号灰度），
   所以退到唯一不依赖任何特权的口径：**用转录字数估输出侧 token**（正文 + thinking，
   usage-channel.ESTIMATE_METHOD），再乘公开单价得基准价。
   行结构与「token 用量路径」完全一致（buildLedgerRow 产物），只多一个 `estimate` 字段、
   source 标 `transcript-estimate` —— 认得出是估算，不会被当成服务端数字。 */

function estimateLedgerRow(entry, table, fallbackModel, index) {
  const built = estimateUsageFromStats(entry?.chars);
  if (!built) return null;
  const model = (typeof entry?.model_id === 'string' && entry.model_id) || fallbackModel || null;
  const row = buildLedgerRow({
    message_id: entry?.message_id || null,
    role: entry?.role || 'assistant',
    position: null,
    model_id: model,
    usage: built.usage,
  }, table, null);
  row.estimate = built.estimate;
  /* v2.15.0：用户那条消息的正文估算 —— 该条回复的**输入下界**（只含用户文字，
     不含历史上下文与系统提示，真实输入远大于此）。只展示、**不计入** tokens/base，
     否则会把「输出侧估算」的口径搞混。 */
  const inputChars = entry?.input_chars && typeof entry.input_chars === 'object' ? entry.input_chars : null;
  const inputLower = inputChars
    ? estimateTokensFromChars(inputChars)
    : (Number.isFinite(Number(entry?.input_tokens_lower_bound)) ? Number(entry.input_tokens_lower_bound) : 0);
  if (inputLower > 0) row.estimate.input_tokens_lower_bound = inputLower;
  row.source = row.base_usd === null ? 'transcript-estimate' : 'transcript-estimate+pricing-table';
  if (Number.isFinite(index)) row.index = index + 1;
  return row;
}

const estimateModelOption = (options) => (typeof options?.model === 'string' && options.model.trim() ? options.model.trim() : null);

/** 从 `GET /api/chat/<sid>` 的响应体直接建估算行。
 *  `options.model` 可选：会话已知模型时（例如 pinnedModel）用它折 base；不知道就只报 token。 */

/* ---------- 3.5 花费反推的原料：官方逐条 base × 同消息估算 token ---------- */

/** 按**消息 id** 把 /cost 官方逐条 base 与转录估算 token 配成对（v2.16.1）。
 *  实测确认（dev-scratch/_cdp-id-align.mjs）：会话包 assistant 消息 id 与 /cost messages
 *  的 key 是同一套 UUID，5/5 完全对齐 —— 否则反推的地基不成立。
 *  返回 {pairs, total_base_usd, total_tokens, usage, cost_only, estimate_only, n_pairs}。
 *  纯函数：任何一侧缺失或对不上都如实报告，绝不凑数（usage_source 标估算口径）。 */
export function pairCostWithEstimates(costMessages, estimates) {
  const estimateById = new Map();
  for (const entry of Array.isArray(estimates) ? estimates : []) {
    if (!entry || typeof entry !== 'object' || !entry.message_id) continue;
    const built = estimateUsageFromStats(entry.chars);
    if (built) estimateById.set(String(entry.message_id), built.usage);
  }
  const costMap = costMessages && typeof costMessages === 'object' ? costMessages : {};
  const pairs = [];
  const costOnly = [];
  const pairedIds = new Set();
  for (const [messageId, entry] of Object.entries(costMap)) {
    const id = String(messageId);
    const base = Number(entry?.basePriceUsd ?? entry?.actual?.basePriceUsd);
    const usage = estimateById.get(id) || null;
    if (!(Number.isFinite(base) && base > 0)) continue;
    if (!usage || !(Number(usage.totalTokens) > 0)) { costOnly.push(id); continue; }
    pairs.push({message_id: id, base_usd: base, tokens: Number(usage.totalTokens), usage});
    pairedIds.add(id);
  }
  const estimateOnly = [...estimateById.keys()].filter(id => !pairedIds.has(id));
  const totalBase = pairs.reduce((sum, row) => sum + row.base_usd, 0);
  const totalTokens = pairs.reduce((sum, row) => sum + row.tokens, 0);
  /* 汇总用量：只带 token 数字（估算口径），供 rankByObservedCost 折算期望成本。 */
  const usage = pairs.length
    ? {
        type: 'language_model',
        usage_source: ESTIMATE_METHOD,
        outputTokens: pairs.reduce((sum, row) => sum + (Number(row.usage.outputTokens) || 0), 0),
        reasoningTokens: pairs.reduce((sum, row) => sum + (Number(row.usage.reasoningTokens) || 0), 0),
        totalTokens: pairs.reduce((sum, row) => sum + (Number(row.usage.totalTokens) || 0), 0),
      }
    : null;
  return {
    pairs, cost_only: costOnly, estimate_only: estimateOnly,
    total_base_usd: Number(totalBase.toFixed(9)), total_tokens: totalTokens,
    usage, n_pairs: pairs.length,
  };
}
export function ledgerRowsFromTranscript(payload, table, options = {}) {
  const stats = transcriptStats(payload);
  if (!stats) return [];
  const fallbackModel = estimateModelOption(options);
  const out = [];
  /* 把用户消息的输入下界配给紧随其后的 assistant 行（一条 user 可对应多步 assistant）。 */
  let lastInputLowerBound = 0;
  for (const message of stats.messages) {
    if (message.role === 'user') { lastInputLowerBound = message.input_tokens_lower_bound || 0; continue; }
    if (message.role !== 'assistant' || !(message.output_tokens > 0)) continue;
    const row = estimateLedgerRow({message_id: message.message_id, role: message.role, model_id: message.model_id, chars: message.stats, input_tokens_lower_bound: lastInputLowerBound}, table, fallbackModel, out.length);
    if (row) { lastInputLowerBound = 0; out.push(row); }
  }
  return out;
}

/** 嗅探器上报的估算条目（{message_id, model_id?, chars:{text,reasoning}}）→ 账本行。
 *  与 ledgerRowsFromTranscript 同形 —— 后台只有嗅探器的条目时走这里。 */
export function ledgerRowsFromEstimates(estimates, table, options = {}) {
  const list = Array.isArray(estimates) ? estimates : [];
  const fallbackModel = estimateModelOption(options);
  const out = [];
  for (const entry of list) {
    const row = estimateLedgerRow(entry, table, fallbackModel, out.length);
    if (row) out.push(row);
  }
  return out;
}

/* ---------- 3. 逐条明细行 ---------- */

/** 构造一行明细。`entry` 来自 extractMessageUsage，`realCost` 可选（来自 /cost 路由或字段信号）。 */
export function buildLedgerRow(entry, table, realCost = null) {
  const usage = entry?.usage || null;
  const model = entry?.model_id || realCost?.model || null;
  const base = baseCostFor(usage, model, table);
  const row = {
    schema: LEDGER_SCHEMA,
    message_id: entry?.message_id || null,
    role: entry?.role || null,
    position: entry?.position || null,
    model,
    usage,
    tokens: usage ? totalOf(usage) : 0,
    usage_text: usage ? describeUsage(usage) : null,
    base_usd: base.priced ? base.usd : null,
    base_min_usd: base.priced ? base.min_usd : null,
    base_max_usd: base.priced ? base.max_usd : null,
    variants: base.priced ? base.variants : 0,
    complete: base.priced ? base.complete : false,
    actual_usd: positive(Number(realCost?.actual_usd)) ? Number(realCost.actual_usd) : null,
    charged_usd: positive(Number(realCost?.charged_usd)) ? Number(realCost.charged_usd) : null,
    credits: positive(Number(realCost?.credits)) ? Number(realCost.credits) : null,
    multiplier: positive(Number(realCost?.multiplier)) ? Number(realCost.multiplier) : null,
    source: base.priced ? (realCost ? 'cost-route+pricing-table' : 'pricing-table') : (realCost ? 'cost-route' : null),
  };
  return row;
}

/** 汇总整个账本。`base_usd` 只累加有价的行（缺价的行计入 `unpriced`，不当作 0）。 */
export function ledgerTotals(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const totals = {
    schema: LEDGER_SCHEMA,
    messages: list.length,
    priced: 0,
    unpriced: 0,
    tokens: 0,
    base_usd: 0,
    base_complete: true,
    actual_usd: null,
    charged_usd: null,
    credits: null,
    multiplier: null,
  };
  let actualSum = 0;
  let chargedSum = 0;
  let creditsSum = 0;
  let hasActual = false;
  let hasCharged = false;
  let hasCredits = false;
  let inputLowerSum = 0;
  for (const row of list) {
    totals.tokens += row.tokens || 0;
    /* v2.15.0：估算行可能带「输入下界」（用户消息正文估算），单独累计，不混进 tokens。 */
    if (row.estimate && Number.isFinite(Number(row.estimate.input_tokens_lower_bound))) {
      inputLowerSum += Number(row.estimate.input_tokens_lower_bound);
    }
    if (row.base_usd === null || row.base_usd === undefined) { totals.unpriced += 1; continue; }
    totals.priced += 1;
    totals.base_usd += row.base_usd;
    if (!row.complete) totals.base_complete = false;
    if (row.actual_usd !== null) { actualSum += row.actual_usd; hasActual = true; }
    if (row.charged_usd !== null) { chargedSum += row.charged_usd; hasCharged = true; }
    if (row.credits !== null) { creditsSum += row.credits; hasCredits = true; }
    if (row.multiplier !== null) totals.multiplier = row.multiplier;
  }
  /* v2.14.0：估算行单独标记，UI 据此显示「估算」而不是服务端数字。 */
  const estimated = list.some((row) => row && row.estimate);
  totals.estimated = estimated;
  if (estimated) totals.estimate_method = ESTIMATE_METHOD;
  if (estimated && inputLowerSum > 0) totals.input_tokens_lower_bound = inputLowerSum;
  totals.base_usd = Number(totals.base_usd.toFixed(6));
  if (hasActual) totals.actual_usd = Number(actualSum.toFixed(6));
  if (hasCharged) totals.charged_usd = Number(chargedSum.toFixed(6));
  if (hasCredits) totals.credits = Number(creditsSum.toFixed(6));
  // 没有下发倍率时，用 charged/base 推（实测 = 2）。
  if (totals.multiplier === null && positive(totals.base_usd) && positive(totals.charged_usd)) {
    totals.multiplier = Number((totals.charged_usd / totals.base_usd).toFixed(6));
  }
  return totals;
}

/** 一次构建整个账本：entries（extractMessageUsage 的输出）+ 单价表 → {rows, totals}。 */
export function buildLedger(entries, table, realCosts = null) {
  const list = Array.isArray(entries) ? entries : [];
  const byMessage = realCosts && typeof realCosts === 'object' ? realCosts : {};
  const rows = list.map((entry, index) => {
    const row = buildLedgerRow(entry, table, byMessage[entry?.message_id] || null);
    row.index = index + 1;
    return row;
  });
  return {schema: LEDGER_SCHEMA, rows, totals: ledgerTotals(rows)};
}

/* ---------- 4. 展示辅助 ---------- */

/** `输出:缓存写:缓存读` 比例（归一到最小项 = 1），用于快速看出这个模型的用量形态。 */
export function tokenRatioText(usage) {
  if (!usage) return null;
  const parts = [
    ['输出', usage.outputTokens || 0],
    ['缓存写', usage.cacheWriteTokens || 0],
    ['缓存读', usage.cacheReadTokens || 0],
  ];
  const positiveValues = parts.filter(([, value]) => value > 0).map(([, value]) => value);
  if (positiveValues.length < 2) {
    // 只有一项（或全 0）时比值没意义，直接给原始计数。
    return `${parts.map(([name, value]) => `${name} ${value}`).join(' / ')}（不足两项，无法比）`;
  }
  const base = Math.min(...positiveValues);
  const ratios = parts.map(([, value]) => (value === 0 ? '0' : value === base ? '1' : (value / base).toFixed(1)));
  return `${parts.map(([name]) => name).join(':')} = ${ratios.join(' : ')}`;
}

/** 把候选模型按「价格签名」分组：签名相同的模型，**单靠价格区分不开**，
 *  必须靠指纹或人工指定。用于浮层里提示「这几个同价」。
 *
 *  v2.19.0：签名从「(输入价, 输出价)」升级为**四项**（输入 / 输出 / 缓存写 / 缓存读）——
 *  借鉴参考扩展 cost-browser-extension 的 samePriceGroups 做法。只看输入输出会把
 *  「输入输出相同、缓存费率不同」的模型误判为同价（缓存费率经 OpenRouter 补充后已可区分），
 *  四项全同才是真的分不开。缺 cache 费率时该位记 '—'，不与「费率为 0」混淆。 */
export function samePriceGroups(ids, table) {
  if (!table || !Array.isArray(ids) || !ids.length) return [];
  const groups = new Map();
  const sigOf = (profile) => [
    profile.input_usd_per_mtok,
    profile.output_usd_per_mtok,
    profile.cache_write_usd_per_mtok == null ? '—' : profile.cache_write_usd_per_mtok,
    profile.cache_read_usd_per_mtok == null ? '—' : profile.cache_read_usd_per_mtok,
  ].join('/');
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim()) continue;
    const priced = bankPricing(id, table);
    if (!priced?.priced) continue;
    const signatures = priced.keys
      .map((key) => table.profile(key))
      .filter(Boolean)
      .map(sigOf)
      .sort();
    const signature = [...new Set(signatures)].join('|');
    if (!signature) continue;
    if (!groups.has(signature)) {
      const first = table.profile(priced.keys[0]);
      groups.set(signature, {
        signature,
        input_usd_per_mtok: first ? first.input_usd_per_mtok : null,
        output_usd_per_mtok: first ? first.output_usd_per_mtok : null,
        cache_write_usd_per_mtok: first ? first.cache_write_usd_per_mtok : null,
        cache_read_usd_per_mtok: first ? first.cache_read_usd_per_mtok : null,
        cache_rate_source: first ? (first.cache_rate_source || null) : null,
        ids: [],
      });
    }
    groups.get(signature).ids.push(id);
  }
  const out = [...groups.values()];
  // 同价组（≥2 个模型）排前面 —— 那才是需要人工/指纹消歧的部分。
  out.sort((a, b) => b.ids.length - a.ids.length);
  return out;
}

/** 表摘要文本，供浮层一行显示。 */
export function describeTotals(totals) {
  if (!totals || !totals.messages) return '尚无用量记录（发一条消息后才有）';
  const parts = [`${totals.messages} 条${totals.estimated ? '（估算）' : ''}`];
  if (totals.priced) parts.push(`基准价合计 ${formatUsd(totals.base_usd)}${totals.base_complete ? '' : '（下界）'}`);
  /* v2.14.0：估算会话（Agent 转录字数通道）里 token 估算往往**就是唯一产出** ——
     模型未揭晓时全部行 unpriced，旧摘要只会写「N 条 · N 条无单价」，把真正的数字藏了。
     这里把输出 token 估算显式露出来；有单价的行仍照常显示基准价。 */
  if (totals.estimated && totals.tokens) parts.push(`输出约 ${totals.tokens} token`);
  /* v2.15.0：用户那条消息的输入下界 —— 用户问的是「每条发送消息消费的 token」，
     发送侧（输入）只有用户文字这一部分是可知的，明确标「下界」。 */
  if (totals.estimated && totals.input_tokens_lower_bound) parts.push(`输入下界约 ${totals.input_tokens_lower_bound} token`);
  if (totals.unpriced) parts.push(`${totals.unpriced} 条无单价`);
  /* v2.16.0：/cost 官方账单带三层语义 —— 上游成本（actual）与 Arena 计价（base）通常不同，
     摘要里把上游成本也露出来（估算会话 actual 为空，不受影响）。 */
  if (totals.actual_usd !== null && totals.actual_usd !== totals.base_usd) parts.push(`上游成本合计 ${formatUsd(totals.actual_usd)}`);
  if (totals.charged_usd !== null) {
    parts.push(`实扣合计 ${formatUsd(totals.charged_usd)}`);
    if (totals.multiplier) parts.push(`×${totals.multiplier}`);
  }
  if (totals.credits !== null) parts.push(`${Number(totals.credits.toFixed(2))} 积分`);
  return parts.join(' · ');
}
