/* Arena 价格通道（v2.10.0 引入，v2.13.1 补真实字段）—— 把 arena.ai 公开的「每模型任务成本」接进探针，做旁证与一致性检查。

   背景（详见 Arena价格接口调研.md）：
   · arena.ai 在 https://arena.ai/leaderboard/agent/pareto 公开每个模型的
     「Median cost per task (last 14 days)」，口径见 https://arena.ai/blog/agent-categories-and-cost
     （真实 Agent Mode 会话的 token 用量 × 模型定价；每会话只统计前 3 个任务）。
   · 但网页版 Agent Mode **不下发**每次请求的美元成本（只有 /api/me/pulse 的额度百分比），
     所以「按每次请求价格反推模型」在网页版无法单独成立 —— 这里把它做成：
       1) 每个候选模型的成本档位（展示 + 一致性检查）；
       2) 一旦嗅探器在页面响应里抓到 cost/usage 字段，立刻按成本对候选做一次加权重排。
   铁律：本模块是纯函数 + 只读数据，不发送任何请求、不写入任何存储、不改动现有指纹评分结果
   （status / nearest 由指纹决定；成本只作为附加信号与排序旁证）。 */

export const COST_SCHEMA = 'arena-agent-cost-table';
export const DEFAULT_TIERS = Object.freeze({premium: 2.5, high: 1.0, mid: 0.4, low: 0});
/** 只有单档成本点时用的对数空间标准差：成本随任务长短波动很大，给宽容的默认值。 */
export const DEFAULT_SIGMA = 0.7;
/** 一致性判定的宽容度（对数空间，单位为 σ）。 */
export const CONSISTENT_Z = 1.5;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;

export function validateCostTable(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('价格表格式无效');
  if (table.schema !== COST_SCHEMA) throw new Error('价格表 schema 无效');
  if (!Array.isArray(table.rows) || table.rows.length < 1 || table.rows.length > 400) throw new Error('价格表行数无效');
  for (const row of table.rows) {
    if (!row || typeof row !== 'object') throw new Error('价格表行无效');
    if (typeof row.label !== 'string' || !row.label.trim() || row.label.length > 80) throw new Error('价格表模型名无效');
    if (!positive(row.cost_usd) || row.cost_usd > 1000) throw new Error('价格表成本无效');
    if (row.bank_id !== null && row.bank_id !== undefined && !/^[a-zA-Z0-9@._:-]{1,160}$/.test(String(row.bank_id))) throw new Error('价格表 bank_id 无效');
  }
  return table;
}

const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function tierOf(cost, tiers = DEFAULT_TIERS) {
  if (!positive(cost)) return null;
  if (cost >= (tiers.premium ?? DEFAULT_TIERS.premium)) return 'premium';
  if (cost >= (tiers.high ?? DEFAULT_TIERS.high)) return 'high';
  if (cost >= (tiers.mid ?? DEFAULT_TIERS.mid)) return 'mid';
  return 'low';
}

export const TIER_LABEL = Object.freeze({premium: '很贵', high: '偏贵', mid: '中等', low: '便宜'});

export function formatCost(usd) {
  return positive(usd) ? `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(3).replace(/0$/, '')}/task` : '—';
}

/** 把逐档价格行归并成「按指纹库模型 ID 索引」的成本档案。 */
export function normalizeCostTable(table) {
  validateCostTable(table);
  const tiers = {...DEFAULT_TIERS, ...(table.tiers || {})};
  const byBank = new Map();
  const byModelId = new Map();
  for (const row of table.rows) {
    const record = {
      model_id: row.model_id ? String(row.model_id) : null,
      label: row.label,
      variant: row.variant ? String(row.variant) : null,
      org: row.org ? String(row.org) : null,
      license: row.license ? String(row.license) : null,
      cost_usd: Number(row.cost_usd),
    };
    if (record.model_id) {
      const bucket = byModelId.get(record.model_id) || [];
      bucket.push(record);
      byModelId.set(record.model_id, bucket);
    }
    if (row.bank_id) {
      const bucket = byBank.get(row.bank_id) || [];
      bucket.push(record);
      byBank.set(row.bank_id, bucket);
    }
  }
  const profiles = new Map();
  for (const [bankId, rows] of byBank) {
    const costs = rows.map(row => row.cost_usd);
    const min = Math.min(...costs);
    const max = Math.max(...costs);
    const spread = min > 0 ? max / min : 1;
    profiles.set(bankId, {
      bank_id: bankId,
      label: rows[0].label,
      org: rows[0].org,
      license: rows[0].license,
      variants: rows.map(row => ({variant: row.variant, cost_usd: row.cost_usd})),
      cost_p50: median(costs),
      cost_min: min,
      cost_max: max,
      // 多档时用档位跨度估 σ（min/max ≈ ±1.1σ），至少 DEFAULT_SIGMA（成本随任务长短天然波动大）。
      sigma: spread > 1 ? Math.max(DEFAULT_SIGMA, Math.log(spread) / 2.2) : DEFAULT_SIGMA,
      tier: tierOf(median(costs), tiers),
    });
  }
  return {
    schema: table.schema,
    fetched_at: table.fetched_at || null,
    source: table.source || null,
    metric: table.metric || null,
    tiers,
    rows: table.rows.length,
    models: byBank.size,
    byBank,
    byModelId,
    profile: bankId => profiles.get(bankId) || null,
    all: () => [...profiles.values()],
  };
}

/** 观测成本对某模型成本档案的似然（对数正态，只看形状，不用于绝对概率）。 */
export function costLikelihood(observedUsd, profile, sigma = null) {
  if (!positive(observedUsd) || !profile || !positive(profile.cost_p50)) return 0;
  const spread = positive(sigma) ? sigma : (profile.sigma || DEFAULT_SIGMA);
  const z = (Math.log(observedUsd) - Math.log(profile.cost_p50)) / spread;
  return Math.exp(-0.5 * z * z);
}

/** 观测成本是否与某模型「大致相符」。 */
export function costConsistency(observedUsd, profile) {
  if (!positive(observedUsd) || !profile || !positive(profile.cost_p50)) return {applicable: false};
  const sigma = profile.sigma || DEFAULT_SIGMA;
  const ratio = observedUsd / profile.cost_p50;
  const z = Math.log(ratio) / sigma;
  return {
    applicable: true,
    ratio: Number(ratio.toFixed(3)),
    z: Number(z.toFixed(2)),
    consistent: Math.abs(z) <= CONSISTENT_Z,
    note: Math.abs(z) <= CONSISTENT_Z ? '相符' : ratio > 1 ? '实测比该模型贵' : '实测比该模型便宜',
  };
}

/** 用观测成本给候选排序（权重归一化）。candidates: [{id, ...}]；返回按成本似然降序的数组。 */
export function rankByCost(observedUsd, candidates, table, limit = 5) {
  if (!positive(observedUsd) || !table || !Array.isArray(candidates)) return null;
  const scored = [];
  for (const candidate of candidates) {
    const id = typeof candidate === 'string' ? candidate : candidate?.id;
    if (!id) continue;
    const profile = table.profile(id);
    if (!profile) continue;
    scored.push({id, label: profile.label, tier: profile.tier, cost_p50: profile.cost_p50, likelihood: costLikelihood(observedUsd, profile)});
  }
  if (!scored.length) return null;
  const total = scored.reduce((sum, item) => sum + item.likelihood, 0);
  for (const item of scored) item.weight = total > 0 ? item.likelihood / total : 0;
  scored.sort((left, right) => right.likelihood - left.likelihood || left.cost_p50 - right.cost_p50);
  return scored.slice(0, Math.max(1, limit));
}

/** 把指纹候选（按 fit 排序）与成本排序对照，给出旁证结论。 */
export function crossCheckCost(observedUsd, candidates, table) {
  if (!positive(observedUsd) || !table || !Array.isArray(candidates) || !candidates.length) return null;
  const ranking = rankByCost(observedUsd, candidates, table, Math.max(3, Math.min(8, candidates.length)));
  if (!ranking) return null;
  const top = candidates[0];
  const topId = typeof top === 'string' ? top : top?.id;
  const profile = topId ? table.profile(topId) : null;
  const consistency = profile ? costConsistency(observedUsd, profile) : {applicable: false};
  const costBest = ranking[0];
  return {
    observed_usd: Number(observedUsd.toFixed(4)),
    observed_label: formatCost(observedUsd),
    nearest_cost: profile ? {id: topId, label: profile.label, cost_p50: profile.cost_p50, tier: profile.tier} : null,
    consistency,
    cost_ranking: ranking.map(item => ({id: item.id, label: item.label, cost_p50: item.cost_p50, weight: Number(item.weight.toFixed(3))})),
    cost_top: costBest ? {id: costBest.id, label: costBest.label, cost_p50: costBest.cost_p50} : null,
    agree: !!(topId && costBest && costBest.id === topId),
  };
}

/** 页面响应里可能出现的成本/用量字段（嗅探器抓，后台收）。
 *
 *  v2.13.1：补齐 Arena `/cost` 会话级聚合的**真实字段名**（从 bundle 的 zod schema 抄的，
 *  见 Arena成本接口实测.md §7）：`actualTotalUsd` / `chargedTotalUsd` / `costMultiplier` /
 *  `marginMultiplier` / `totalChargedCredits` / 9 个分项 `*CostUsd` —— 旧表全都没有。
 *  这是**正则兜底路径**的字段表（结构化解析走 `scanCostRoute`）；兜底路径拿不到实扣价与倍率，
 *  就没法还原截图里的 `base / charged / ×2`。
 *  字段表分四类：usd / credits / multiplier / tokens（见 unitOfCostField）。
 *  ⚠️ 这份表与 `network-sniffer.js` 里的同名常量必须保持一致（那边是 MAIN world IIFE，无法 import）。 */
const COST_FIELD_RE = /"(actualtotalusd|chargedtotalusd|totalcostusd|totalchargedusd|basepriceusd|totalcost|costusd|priceusd|spend|totalcharged|costpertaskusd|priceperimage|inputtokenscostusd|outputtokenscostusd|cachewritetokenscostusd|cachereadtokenscostusd|textoutputtokenscostusd|imageinputtokenscostusd|imageoutputtokenscostusd|imagegenerationcostusd|videogenerationcostusd|actual_total_usd|charged_total_usd|total_cost_usd|total_charged_usd|base_price_usd|cost_usd|price_usd|total_charged|totalchargedcredits|total_charged_credits|creditsused|credits_used|costmultiplier|marginmultiplier|discountpercent|discount_percent|cost|total_tokens|prompt_tokens|completion_tokens|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|reasoning_tokens|inputtokens|outputtokens)"\s*:\s*"?(-?[0-9]+(?:\.[0-9]+)?)"?/gi;

/** 成本字段的单位归类。顺序要紧：先判倍率/积分，再判美元，最后才是 token
 *  —— 否则 `inputTokensCostUsd` 会因为含 "tokens" 被误判成 token 数。 */
export function unitOfCostField(field) {
  const key = String(field || '').toLowerCase();
  if (/multiplier|discount/.test(key)) return 'multiplier';
  if (/credits/.test(key)) return 'credits';
  if (/usd$|cost|price|spend|charge/.test(key)) return 'usd';
  if (/tokens/.test(key)) return 'tokens';
  return 'other';
}

/** Arena 的积分换算：1 美元 = 1000 积分（实测常量，见 bundle `CREDITS_PER_USD`）。 */
export const CREDITS_PER_USD = 1e3;

/** 从一段响应文本里抽出成本/用量信号（只读、限量、不落地）。 */
export function extractCostSignals(text, where = '', url = '') {
  const source = String(text || '');
  if (!source || source.length > 400000) return [];
  /* v2.13.1：门禁词补上 charge/price/multiplier —— 否则 `totalChargedUsd` 所在的响应体
     会因为不含 cost/usd/spend 而被整包跳过。 */
  if (!/cost|usd|spend|credits|charge|price|multiplier|_tokens|usage/i.test(source)) return [];
  const out = [];
  const seen = new Set();
  let match;
  let guard = 0;
  COST_FIELD_RE.lastIndex = 0;
  while ((match = COST_FIELD_RE.exec(source)) && guard < 24) {
    guard += 1;
    const key = match[1].toLowerCase();
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0 || value > 1e7) continue;
    const token = `${key}=${value}`;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push({kind: 'cost', field: key, value, unit: unitOfCostField(key), where: String(where).slice(0, 60), url: String(url).slice(0, 200)});
  }
  return out;
}

/** 美元字段的优先级：**先取 base**（无加价，正好和 Σ token×单价 同口径），
 *  再取 total/actual，最后才是各种分项。 */
const COST_USD_PREFERENCE = [
  /^base ?_?price ?_?usd$/,
  /^total ?_?cost ?_?usd$/,
  /^actual ?_?total ?_?usd$/,
  /^total ?_?charged ?_?usd$/,
  /^total ?_?charged$/,
  /costusd|cost_usd|priceusd|price_usd|totalcost|total_cost|cost|spend/,
];

function usdSignals(signals) {
  return (Array.isArray(signals) ? signals : []).filter(item => item && item.unit === 'usd' && positive(item.value) && item.value < 1000);
}

/** 从嗅探器汇总来的成本信号里挑出「每次请求美元成本」。
 *  优先 base 价（= Σ token × 单价，未加价），这样能和公开单价表直接比。 */
export function observedCostFromSignals(signals) {
  const usd = usdSignals(signals);
  if (!usd.length) return null;
  for (const re of COST_USD_PREFERENCE) {
    const hit = usd.find(item => re.test(String(item.field)));
    if (hit) return hit.value;
  }
  return Math.max(...usd.map(item => item.value));
}

/** 把嗅探到的成本信号还原成 `/cost` 响应的结构（有就返回，没有返回 null）。
 *  这是「别人能拿到成本」的那份数据：Arena 只对**已开通计费**的账号下发。 */
export function observedCostDetail(signals) {
  const usd = usdSignals(signals);
  const pickUsd = (re) => {
    const hit = usd.find(item => re.test(String(item.field)));
    return hit ? hit.value : null;
  };
  const creditsHit = (Array.isArray(signals) ? signals : []).find(item => item && item.unit === 'credits' && positive(item.value));
  const multHit = (Array.isArray(signals) ? signals : []).find(item => item && item.unit === 'multiplier' && positive(item.value));
  const detail = {
    base_usd: pickUsd(/^base ?_?price ?_?usd$/),
    total_cost_usd: pickUsd(/^total ?_?cost ?_?usd$/),
    actual_usd: pickUsd(/^actual ?_?total ?_?usd$/),
    charged_usd: pickUsd(/^total ?_?charged ?_?usd$/) ?? pickUsd(/^total ?_?charged$/),
    credits: creditsHit ? creditsHit.value : null,
    multiplier: multHit ? multHit.value : null,
  };
  if (Object.values(detail).every(value => value == null)) return null;
  detail.credits_usd = detail.credits != null ? Number((detail.credits / CREDITS_PER_USD).toFixed(6)) : null;
  // 只给了 base 和 charged 时，顺手把倍率推出来
  if (detail.multiplier == null && positive(detail.base_usd) && positive(detail.charged_usd)) {
    detail.multiplier = Number((detail.charged_usd / detail.base_usd).toFixed(6));
  }
  detail.field_count = usd.length;
  return detail;
}

/** base 价 × 倍率 = 实际扣费。倍率缺失时按 1 处理（不加价）。 */
export function chargedFromBase(baseUsd, multiplier) {
  if (!positive(baseUsd)) return null;
  const m = positive(multiplier) ? Number(multiplier) : 1;
  return Number((baseUsd * m).toFixed(8));
}

/** v2.13.1：把 `/cost` 路由的 `session` 聚合对象转成与 `observedCostDetail` **同形**的结构，
 *  这样浮层/自检不必区分「正则抓到的字段」和「结构化路由拿到的聚合」两条来源。
 *  注意 `actualTotalUsd` 与 `basePriceUsd` 都归到 base 口径（实测二者同量级），
 *  `chargedTotalUsd` 才是加价后的实扣。
 *  v2.16.0：实测 200 响应里 base / 实扣积分挂在 `session.aggregate` 子对象下
 *  （顶层只有 actualTotalUsd / chargedTotalUsd / messageCount），这里补一层回退。 */
export function costDetailFromSession(session) {
  if (!session || typeof session !== 'object') return null;
  const num = (value) => (positive(Number(value)) ? Number(value) : null);
  const aggregate = session.aggregate && typeof session.aggregate === 'object' ? session.aggregate : null;
  const detail = {
    base_usd: num(session.basePriceUsd) ?? (aggregate ? num(aggregate.basePriceUsd) : null) ?? num(session.actualTotalUsd),
    total_cost_usd: num(session.actualTotalUsd),
    actual_usd: num(session.actualTotalUsd),
    charged_usd: num(session.chargedTotalUsd) ?? (aggregate ? num(aggregate.totalChargedUsd) : null),
    credits: aggregate ? num(aggregate.totalChargedCredits) : null,
    multiplier: num(session.marginMultiplier) ?? num(session.costMultiplier),
    source: 'cost-route/session',
  };
  /* 只判数值字段是否全空（`source` 是常量字符串，不能算进「有没有数据」）。 */
  const numeric = ['base_usd', 'total_cost_usd', 'actual_usd', 'charged_usd', 'credits', 'multiplier'];
  if (numeric.every(key => detail[key] == null)) return null;
  if (detail.multiplier == null && positive(detail.base_usd) && positive(detail.charged_usd)) {
    detail.multiplier = Number((detail.charged_usd / detail.base_usd).toFixed(6));
  }
  return detail;
}

/** v2.13.1：把成本明细压成一行可读文本（浮层与自检共用）。
 *  例：`base $1.063176 · 实扣 $2.126352 · ×2` */
export function describeCostDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const fmt = (value) => (positive(value) ? `$${Number(Number(value).toFixed(6))}` : null);
  const parts = [];
  const base = fmt(detail.base_usd);
  if (base) parts.push(`base ${base}`);
  const charged = fmt(detail.charged_usd) || fmt(detail.actual_usd) || fmt(detail.total_cost_usd);
  if (charged) parts.push(`${fmt(detail.charged_usd) ? '实扣' : 'actual'} ${charged}`);
  if (positive(detail.multiplier)) parts.push(`×${Number(Number(detail.multiplier).toFixed(4))}`);
  if (positive(detail.credits)) parts.push(`${Number(Number(detail.credits).toFixed(2))} 积分`);
  return parts.join(' · ');
}
