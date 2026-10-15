import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  COST_SCHEMA, DEFAULT_SIGMA, validateCostTable, normalizeCostTable, tierOf, formatCost,
  costLikelihood, costConsistency, rankByCost, crossCheckCost, extractCostSignals, observedCostFromSignals,
  unitOfCostField, observedCostDetail, costDetailFromSession, describeCostDetail, chargedFromBase, CREDITS_PER_USD,
} from '../price-channel.js';

const bundled = () => JSON.parse(readFileSync(new URL('../arena-cost-table.json', import.meta.url), 'utf8'));

test('随包价格表结构有效，并映射到指纹库模型 ID', () => {
  const table = normalizeCostTable(bundled());
  assert.equal(table.schema, COST_SCHEMA);
  assert.ok(table.models >= 8, '至少覆盖 8 个指纹库模型');
  for (const id of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
    const profile = table.profile(id);
    assert.ok(profile, `${id} 应有成本档案`);
    assert.ok(profile.cost_p50 > 0);
    assert.ok(profile.sigma >= DEFAULT_SIGMA);
  }
  // GPT-6 家族内部成本必须拉开档次（这正是指纹最容易混的地方）。
  assert.ok(table.profile('gpt-6-astra').cost_p50 > table.profile('gpt-6-sol').cost_p50);
  assert.ok(table.profile('gpt-6-sol').cost_p50 > table.profile('gpt-6-luna').cost_p50);
  // 同一模型的多档成本（Opus 5 Max/High）应归并成 min/max 区间。
  const opus5 = table.profile('claude-opus-5');
  assert.ok(opus5.variants.length >= 2);
  assert.ok(opus5.cost_max > opus5.cost_min);
});

test('validateCostTable 拒绝脏数据', () => {
  assert.throws(() => validateCostTable(null), /格式无效/);
  assert.throws(() => validateCostTable({schema: 'nope', rows: [{}]}), /schema 无效/);
  assert.throws(() => validateCostTable({schema: COST_SCHEMA, rows: []}), /行数无效/);
  assert.throws(() => validateCostTable({schema: COST_SCHEMA, rows: [{label: 'x', cost_usd: 0}]}), /成本无效/);
  assert.throws(() => validateCostTable({schema: COST_SCHEMA, rows: [{label: 'x', cost_usd: 1, bank_id: 'bad id!'}]}), /bank_id 无效/);
  assert.equal(validateCostTable({schema: COST_SCHEMA, rows: [{label: 'x', cost_usd: 1, bank_id: 'gpt-6-sol'}]}).rows.length, 1);
});

test('tierOf / formatCost 分档与显示', () => {
  assert.equal(tierOf(6.54), 'premium');
  assert.equal(tierOf(1.0), 'high');
  assert.equal(tierOf(0.4), 'mid');
  assert.equal(tierOf(0.07), 'low');
  assert.equal(tierOf(0), null);
  assert.equal(formatCost(1.79), '$1.79/task');
  assert.equal(formatCost(0.07), '$0.07/task');
  assert.equal(formatCost(0), '—');
});

test('costLikelihood / costConsistency 对观测成本给出一致性', () => {
  const profile = {cost_p50: 0.78, sigma: 0.7};
  assert.ok(costLikelihood(0.78, profile) > costLikelihood(3.47, profile));
  assert.equal(costConsistency(0.8, profile).consistent, true);
  const far = costConsistency(6.5, profile);
  assert.equal(far.consistent, false);
  assert.equal(far.note, '实测比该模型贵');
  assert.equal(costConsistency(0.78, null).applicable, false);
});

test('rankByCost / crossCheckCost 用观测成本重排候选', () => {
  const table = normalizeCostTable(bundled());
  const candidates = [{id: 'gpt-6-luna'}, {id: 'gpt-6-sol'}, {id: 'gpt-6-astra'}];
  // 观测到一次很便宜的任务 → 成本排序应把 luna 放第一。
  const cheap = rankByCost(0.07, candidates, table);
  assert.equal(cheap[0].id, 'gpt-6-luna');
  const weights = cheap.reduce((sum, item) => sum + item.weight, 0);
  assert.ok(Math.abs(weights - 1) < 1e-9, '权重归一化');

  const expensive = crossCheckCost(3.4, candidates, table);
  assert.equal(expensive.cost_top.id, 'gpt-6-astra');
  // 指纹给的第一名是 luna，但现场成本像 astra → 应当报「不一致」。
  assert.equal(expensive.agree, false);
  assert.equal(expensive.consistency.consistent, false);

  // 指纹第一名与成本第一名一致时 agree = true。
  const agree = crossCheckCost(0.07, candidates, table);
  assert.equal(agree.agree, true);
  assert.equal(agree.consistency.consistent, true);
});

test('extractCostSignals / observedCostFromSignals 只读抽取成本与用量字段', () => {
  const signals = extractCostSignals('{"usage":{"prompt_tokens":1200,"completion_tokens":340},"totalCost":0.0173}', 'fetch.body', 'https://arena.ai/api/chat');
  assert.equal(signals.length, 3);
  assert.deepEqual(signals.find(item => item.field === 'totalcost'), {kind: 'cost', field: 'totalcost', value: 0.0173, unit: 'usd', where: 'fetch.body', url: 'https://arena.ai/api/chat'});
  assert.equal(signals.find(item => item.field === 'prompt_tokens').unit, 'tokens');
  assert.equal(observedCostFromSignals(signals), 0.0173);
  assert.equal(observedCostFromSignals([]), null);
  assert.equal(extractCostSignals('no numbers here').length, 0);
  // 超大文本直接放弃，避免把整包正文当解析对象。
  assert.equal(extractCostSignals('cost:1,'.repeat(60000)).length, 0);
});

/* ---------- v2.13.1：Arena `/cost` 的真实字段 ---------- */

test('unitOfCostField 单位归类：倍率/积分优先于 token（inputTokensCostUsd 不能当 token 数）', () => {
  assert.equal(unitOfCostField('basePriceUsd'), 'usd');
  assert.equal(unitOfCostField('actualTotalUsd'), 'usd');
  assert.equal(unitOfCostField('chargedTotalUsd'), 'usd');
  assert.equal(unitOfCostField('totalCharged'), 'usd');
  assert.equal(unitOfCostField('inputTokensCostUsd'), 'usd');
  assert.equal(unitOfCostField('cacheReadTokensCostUsd'), 'usd');
  assert.equal(unitOfCostField('totalChargedCredits'), 'credits');
  assert.equal(unitOfCostField('creditsUsed'), 'credits');
  assert.equal(unitOfCostField('costMultiplier'), 'multiplier');
  assert.equal(unitOfCostField('marginMultiplier'), 'multiplier');
  assert.equal(unitOfCostField('discountPercent'), 'multiplier');
  assert.equal(unitOfCostField('inputTokens'), 'tokens');
  assert.equal(unitOfCostField('cacheWriteTokens'), 'tokens');
  assert.equal(CREDITS_PER_USD, 1e3);
});

/* 回归：会话级聚合字段必须都在字段表里。
   旧表只有 `totalCostUsd` / `basePriceUsd` / `totalChargedUsd` 一类，**没有**下面这些 ——
   于是 JSON 解析失败走正则兜底时，实扣价与倍率永远拿不到。 */
test('回归：会话级聚合字段（actualTotalUsd / chargedTotalUsd / costMultiplier …）必须在字段表里', () => {
  const probe = JSON.stringify({
    actualTotalUsd: 1, chargedTotalUsd: 2, basePriceUsd: 3, costMultiplier: 4,
    marginMultiplier: 5, discountPercent: 6, totalChargedCredits: 7, creditsUsed: 8,
    inputTokensCostUsd: 9, cacheWriteTokensCostUsd: 10, videoGenerationCostUsd: 11,
    totalCharged: 12, costPerTaskUsd: 13,
  });
  const fields = new Set(extractCostSignals(probe, 'x', 'y').map(item => item.field));
  for (const field of ['actualtotalusd', 'chargedtotalusd', 'basepriceusd', 'costmultiplier', 'marginmultiplier',
    'discountpercent', 'totalchargedcredits', 'creditsused', 'inputtokenscostusd', 'cachewritetokenscostusd',
    'videogenerationcostusd', 'totalcharged', 'costpertaskusd']) {
    assert.ok(fields.has(field), `${field} 不在字段表里`);
  }
  // 单位也要对：creditsUsed 是积分（旧代码判成美元），倍率类不是 token。
  const unit = (field) => extractCostSignals(probe, 'x', 'y').find(item => item.field === field)?.unit;
  assert.equal(unit('creditsused'), 'credits');
  assert.equal(unit('costmultiplier'), 'multiplier');
  assert.equal(unit('discountpercent'), 'multiplier');
  assert.equal(unit('inputtokenscostusd'), 'usd');
});

/* 与用户截图同形的 `/cost` 响应（字段名抄自 bundle 的 zod schema，数值抄自截图）。
   截图原文：`$23.18767300 cost | $1.06317612 base | $2.12635223 charged` */
const COST_PAYLOAD = JSON.stringify({
  session: {
    actualTotalUsd: 1.06317612,
    chargedTotalUsd: 2.12635223,
    basePriceUsd: 1.06317612,
    totalChargedCredits: 2126.35223,
    costMultiplier: 2,
    marginMultiplier: 2,
    messageCount: 30,
  },
  messages: {
    'msg-1': {actual: {totalCostUsd: 1.06317612, basePriceUsd: 1.06317612, totalChargedUsd: 2.12635223}},
  },
});

test('真实 /cost 响应能抽全字段，并还原 base / 实扣 / 倍率', () => {
  const signals = extractCostSignals(COST_PAYLOAD, 'fetch.body', 'https://arena.ai/api/chat/abc/cost');
  const byField = Object.fromEntries(signals.map(item => [item.field, item]));
  for (const field of ['actualtotalusd', 'chargedtotalusd', 'basepriceusd', 'totalchargedcredits', 'costmultiplier', 'marginmultiplier']) {
    assert.ok(byField[field], `${field} 必须被抽到（旧字段表漏的就是这些会话级聚合字段）`);
  }
  assert.equal(byField.basepriceusd.unit, 'usd');
  assert.equal(byField.basepriceusd.value, 1.06317612);
  assert.equal(byField.chargedtotalusd.unit, 'usd');
  assert.equal(byField.costmultiplier.unit, 'multiplier');
  assert.equal(byField.totalchargedcredits.unit, 'credits');
  // 观测成本必须取 base —— 只有 base 与「Σ token × 公开单价」同口径，才能用来反推模型。
  assert.equal(observedCostFromSignals(signals), 1.06317612);
  const detail = observedCostDetail(signals);
  assert.equal(detail.base_usd, 1.06317612);
  assert.equal(detail.charged_usd, 2.12635223);
  assert.equal(detail.credits, 2126.35223);
  assert.equal(detail.multiplier, 2);
  // 积分反算美元应与实扣价一致（1 美元 = 1000 积分）—— 独立佐证实扣价。
  assert.equal(detail.credits_usd, 2.126352);
  assert.equal(chargedFromBase(detail.base_usd, detail.multiplier), 2.12635224);
  assert.ok(Number.isFinite(detail.field_count));
});

test('只给 base 与 charged 时自动推出倍率；截图实测恰好 ×2', () => {
  const signals = extractCostSignals('{"basePriceUsd":1.06317612,"totalChargedUsd":2.12635223}', 'fetch.body', 'https://arena.ai/api/chat/x/cost');
  const detail = observedCostDetail(signals);
  assert.equal(detail.base_usd, 1.06317612);
  assert.equal(detail.charged_usd, 2.12635223);
  assert.equal(detail.multiplier, 2, `2.12635223 / 1.06317612 应为 2，实际 ${detail.multiplier}`);
  assert.equal(describeCostDetail(detail), 'base $1.063176 · 实扣 $2.126352 · ×2');
  assert.equal(describeCostDetail(null), '');
  assert.equal(observedCostDetail([]), null);
});

test('costDetailFromSession 把 /cost 的 session 聚合同形化（base 口径）', () => {
  const detail = costDetailFromSession({actualTotalUsd: 2.12635223, chargedTotalUsd: 2.12635223, basePriceUsd: 1.06317612, marginMultiplier: 2, messageCount: 30});
  assert.equal(detail.base_usd, 1.06317612);
  assert.equal(detail.actual_usd, 2.12635223, 'actual 单独保留，不冒充 base');
  assert.equal(detail.charged_usd, 2.12635223);
  assert.equal(detail.multiplier, 2);
  assert.equal(detail.source, 'cost-route/session');
  // 没给倍率时用 charged/base 推。
  assert.equal(costDetailFromSession({basePriceUsd: 1, chargedTotalUsd: 2}).multiplier, 2);
  // 只有 actualTotalUsd 时不能假装成 base（拿不到 charged 就不编）。
  assert.equal(costDetailFromSession({actualTotalUsd: 0.5}).base_usd, null);
  assert.equal(costDetailFromSession({actualTotalUsd: 0.5}).actual_usd, 0.5);
  assert.equal(costDetailFromSession({actualTotalUsd: 0.5}).charged_usd, null);
  assert.equal(costDetailFromSession(null), null);
  assert.equal(costDetailFromSession({messageCount: 3}), null);
});

test('chargedFromBase 边界：倍率缺失按 1 处理', () => {
  assert.equal(chargedFromBase(1.5, null), 1.5);
  assert.equal(chargedFromBase(1.5, undefined), 1.5);
  assert.equal(chargedFromBase(2, 2), 4);
  assert.equal(chargedFromBase(0, 2), null);
  assert.equal(chargedFromBase(null, 2), null);
});
