import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  PRICING_SCHEMA, validatePricingTable, normalizePricingTable, describePrice,
  expectedCostUsd, costMatch, rankByObservedCost, discrimination, pricingSummary,
  bankAliases, resolvePricingKeys, bankPricing,
} from '../pricing-channel.js';

const bundled = () => JSON.parse(readFileSync(new URL('../arena-pricing-table.json', import.meta.url), 'utf8'));

// 2026-10-11 实测 payload（usage-channel 归一化后的形状）
const USAGE_A = {inputTokens: 4, outputTokens: 326, cacheReadTokens: 3500, cacheWriteTokens: 3845, totalTokens: 7675};
const USAGE_B = {inputTokens: 6, outputTokens: 4142, cacheWriteTokens: 11143, totalTokens: 15291};

test('随包单价表结构有效且覆盖足够多模型', () => {
  const raw = bundled();
  const table = normalizePricingTable(raw);
  assert.equal(table.schema, PRICING_SCHEMA);
  assert.equal(table.unit, 'usd_per_million_tokens');
  assert.ok(table.models >= 150, `至少 150 个模型有价，实际 ${table.models}`);
  // 实测存在的几档
  const astra = table.profile('gpt-6-astra-max-agent');
  assert.ok(astra, 'gpt-6-astra-max-agent 应有单价');
  assert.equal(astra.input_usd_per_mtok, 10);
  assert.equal(astra.output_usd_per_mtok, 50);
  assert.equal(astra.org, 'OpenAI');
  const deepseek = table.profile('deepseek-v4.1-flash-max-20260910-agent');
  assert.equal(deepseek.input_usd_per_mtok, 0.3);
  assert.equal(deepseek.output_usd_per_mtok, 1.2);
  assert.equal(deepseek.org, 'DeepSeek');
  // 文本模型：单价为正，且输出价不低于输入价
  const text = table.text();
  assert.ok(text.length >= 150, `至少 150 个文本模型，实际 ${text.length}`);
  const bad = text.filter(r => !(r.input_usd_per_mtok > 0) || !(r.output_usd_per_mtok >= r.input_usd_per_mtok));
  assert.equal(bad.length, 0, `异常单价行：${bad.map(r => r.model_key).join(', ')}`);
});

test('非 token 计价模型（图像/视频）被标为 media 并排除出反推', () => {
  const table = normalizePricingTable(bundled());
  assert.equal(table.text_models + table.media_models, table.models);
  assert.ok(table.media_models >= 10, `应识别出图像/视频模型，实际 ${table.media_models}`);
  // 典型样本：gpt-image 只有输入价、sora/veo 只有输出价
  for (const key of ['gpt-image-1-mini', 'sora-2', 'veo-3', 'imagen-4.0-generate-001']) {
    const p = table.profile(key);
    assert.ok(p, `${key} 应在表中`);
    assert.equal(p.kind, 'media', `${key} 应判为 media`);
  }
  // media 模型不参与成本反推
  const usage = {inputTokens: 1000, outputTokens: 1000};
  assert.equal(costMatch(0.06, usage, table.profile('gpt-image-1-mini')).applicable, false);
  const ranked = rankByObservedCost(0.06, usage, ['gpt-image-1-mini', 'sora-2'], table);
  assert.equal(ranked, null, '候选全是 media 时应返回 null');
  const mixed = rankByObservedCost(0.06, usage, ['gpt-image-1-mini', 'gpt-6-astra-max-agent'], table);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].model_key, 'gpt-6-astra-max-agent');
});

test('validatePricingTable 拒绝脏数据', () => {
  assert.throws(() => validatePricingTable(null), /格式无效/);
  assert.throws(() => validatePricingTable({schema: 'x', rows: []}), /schema 无效/);
  assert.throws(() => validatePricingTable({schema: PRICING_SCHEMA, rows: []}), /行数无效/);
  assert.throws(() => validatePricingTable({schema: PRICING_SCHEMA, rows: [{model_key: 'a'}]}), /价格无效/);
  assert.equal(validatePricingTable({schema: PRICING_SCHEMA, rows: [{model_key: 'a', input_usd_per_mtok: 1}]}).rows.length, 1);
});

test('describePrice 展示单价', () => {
  assert.equal(describePrice({input_usd_per_mtok: 10, output_usd_per_mtok: 50}), '$10/$50 每 Mtok');
  assert.equal(describePrice({input_usd_per_mtok: 0.3, output_usd_per_mtok: 15}), '$0.3/$15 每 Mtok');
  assert.equal(describePrice({input_usd_per_mtok: 5, output_usd_per_mtok: 0, kind: 'media'}), '$5/$0 每 Mtok（按张/秒计，不可按 token 反推）');
  assert.equal(describePrice(null), '—');
});

test('expectedCostUsd 按 token 数折算', () => {
  const profile = {input_usd_per_mtok: 10, output_usd_per_mtok: 50, cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null};
  const r = expectedCostUsd({inputTokens: 1000, outputTokens: 1000}, profile);
  assert.equal(r.usd, 0.06); // 0.001*10 + 0.001*50
  assert.equal(r.complete, true);

  // 缓存 token 没有单价 → 期望值只是下界，complete=false
  const withCache = expectedCostUsd(USAGE_B, profile);
  assert.equal(withCache.complete, false);
  assert.equal(withCache.uncovered_tokens, 11143);
  assert.ok(withCache.usd > 0);

  // 给了缓存单价就完整
  const full = expectedCostUsd(USAGE_B, profile, {cacheWriteUsdPerMtok: 12.5});
  assert.equal(full.complete, true);
  assert.ok(full.usd > withCache.usd);

  assert.equal(expectedCostUsd(null, profile), null);
  assert.equal(expectedCostUsd(USAGE_B, null), null);
});

test('costMatch 判定实测成本与候选模型是否相符', () => {
  const astra = {input_usd_per_mtok: 10, output_usd_per_mtok: 50, cache_read_usd_per_mtok: 1, cache_write_usd_per_mtok: 12.5};
  const luna = {input_usd_per_mtok: 0.14, output_usd_per_mtok: 0.28, cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null};
  const usage = {inputTokens: 1000, outputTokens: 1000};

  const hit = costMatch(0.06, usage, astra);
  assert.equal(hit.consistent, true);
  assert.equal(hit.ratio, 1);

  const miss = costMatch(0.06, usage, luna);
  assert.equal(miss.consistent, false);
  assert.equal(miss.note, '实测比该模型贵');

  assert.equal(costMatch(0, usage, astra).applicable, false);
  assert.equal(costMatch(0.06, null, astra).applicable, false);
});

test('rankByObservedCost 用实测成本给候选排序', () => {
  const table = normalizePricingTable(bundled());
  const candidates = ['gpt-6-astra-max-agent', 'claude-opus-5.5-high-vertex-agent', 'deepseek-v4.1-flash-max-20260910-agent'];
  const usage = {inputTokens: 10000, outputTokens: 2000};

  // 先算 astra 的期望成本，再喂回去 → astra 必须排第一
  const astraExpected = expectedCostUsd(usage, table.profile('gpt-6-astra-max-agent')).usd;
  const ranked = rankByObservedCost(astraExpected, usage, candidates, table);
  assert.equal(ranked[0].model_key, 'gpt-6-astra-max-agent');
  assert.ok(Math.abs(ranked.reduce((s, x) => s + x.weight, 0) - 1) < 1e-3, '权重归一化');

  // 便宜的用量配便宜的价格 → deepseek 应该赢
  const cheap = rankByObservedCost(expectedCostUsd(usage, table.profile('deepseek-v4.1-flash-max-20260910-agent')).usd, usage, candidates, table);
  assert.equal(cheap[0].model_key, 'deepseek-v4.1-flash-max-20260910-agent');

  assert.equal(rankByObservedCost(0, usage, candidates, table), null);
  assert.equal(rankByObservedCost(0.01, usage, [], table), null);
});

test('discrimination 报告价格区分度', () => {
  const table = normalizePricingTable(bundled());
  const candidates = ['gpt-6-astra-max-agent', 'deepseek-v4.1-flash-max-20260910-agent'];
  const usage = {inputTokens: 10000, outputTokens: 2000};
  const d = discrimination(usage, candidates, table);
  assert.ok(d.span > 5, `astra 与 deepseek 的期望成本应差 5 倍以上，实际 ${d.span}`);
  assert.equal(d.min.model_key, 'deepseek-v4.1-flash-max-20260910-agent');
  assert.equal(d.max.model_key, 'gpt-6-astra-max-agent');
  assert.equal(discrimination(usage, ['gpt-6-astra-max-agent'], table), null);
});

test('pricingSummary 给表摘要', () => {
  const table = normalizePricingTable(bundled());
  const s = pricingSummary(table);
  assert.equal(s.unit, 'usd_per_million_tokens');
  assert.ok(s.models >= 150);
  assert.ok(s.text_models >= 150, `文本模型数 ${s.text_models}`);
  assert.equal(s.text_models + s.media_models, s.models);
  assert.ok(s.input_range[0] > 0 && s.input_range[1] >= s.input_range[0]);
  assert.ok(s.output_range[1] >= s.output_range[0]);
  assert.equal(pricingSummary(null), null);
});

/* 归一化映射：指纹库 id（基础名）→ Arena 单价 key（变体名）。
   这 17 个 id 取自随包 modeltrace-bank.json，是实测的真实值。 */
test('bankAliases 处理版本号分隔符差异', () => {
  assert.deepEqual(bankAliases('claude-opus-5-5'), ['claude-opus-5-5', 'claude-opus-5.5']);
  assert.deepEqual(bankAliases('claude-sonnet-5-5'), ['claude-sonnet-5-5', 'claude-sonnet-5.5']);
  assert.deepEqual(bankAliases('gpt-6-astra'), ['gpt-6-astra']);
  assert.deepEqual(bankAliases('claude-haiku-4-5-20251001'), ['claude-haiku-4-5-20251001']);
  assert.deepEqual(bankAliases(' GPT-6-Astra '), ['gpt-6-astra']);
  assert.deepEqual(bankAliases(''), []);
  assert.deepEqual(bankAliases(null), []);
});

test('resolvePricingKeys 把基础 id 展开到 Arena 变体', () => {
  const table = normalizePricingTable(bundled());

  // gpt-6-astra → agent + codex-harness 两档
  const astra = resolvePricingKeys('gpt-6-astra', table);
  assert.deepEqual(astra.sort(), ['gpt-6-astra-max-agent', 'gpt-6-astra-max-code-codex-harness']);

  // 关键歧义：claude-sonnet-5 不得吞掉 claude-sonnet-5-5-*
  const sonnet5 = resolvePricingKeys('claude-sonnet-5', table);
  assert.ok(sonnet5.includes('claude-sonnet-5-agent'));
  assert.ok(!sonnet5.some(k => k.startsWith('claude-sonnet-5-5-')), `sonnet-5 误吞：${sonnet5.join(', ')}`);

  // 反向：claude-sonnet-5-5 只拿自己的两档
  const sonnet55 = resolvePricingKeys('claude-sonnet-5-5', table);
  assert.deepEqual(sonnet55.sort(), ['claude-sonnet-5-5-high', 'claude-sonnet-5-5-xhigh']);

  // 点号别名：claude-opus-5-5（库） → claude-opus-5.5-*（Arena）
  const opus55 = resolvePricingKeys('claude-opus-5-5', table);
  assert.equal(opus55.length, 3);
  assert.ok(opus55.every(k => k.startsWith('claude-opus-5.5-')), opus55.join(', '));

  // 关键歧义：claude-opus-5 不得吞掉 claude-opus-5.5-*
  const opus5 = resolvePricingKeys('claude-opus-5', table);
  assert.ok(opus5.length >= 5);
  assert.ok(!opus5.some(k => k.startsWith('claude-opus-5.5-')), `opus-5 误吞：${opus5.join(', ')}`);

  // 直接给 Arena key 也应精确命中自身
  assert.deepEqual(resolvePricingKeys('gpt-6-astra-max-agent', table), ['gpt-6-astra-max-agent']);

  // 库里没有定价的模型 / 无效输入
  assert.deepEqual(resolvePricingKeys('claude-haiku-4-5-20251001', table), []);
  assert.deepEqual(resolvePricingKeys('nope-1', table), []);
  assert.deepEqual(resolvePricingKeys(null, table), []);
  assert.deepEqual(resolvePricingKeys('gpt-6-astra', null), []);
});

test('bankPricing 给出基础 id 的价格档位区间', () => {
  const table = normalizePricingTable(bundled());
  const p = bankPricing('gpt-6-astra', table);
  assert.equal(p.priced, true);
  assert.equal(p.variants.length, 2);
  assert.deepEqual(p.input_range, [10, 10]);
  assert.deepEqual(p.output_range, [50, 50]);
  assert.equal(p.variants[0].text, '$10/$50 每 Mtok');

  const missing = bankPricing('claude-haiku-4-5-20251001', table);
  assert.equal(missing.priced, false);
  assert.deepEqual(missing.variants, []);
  assert.equal(bankPricing('gpt-6-astra', null), null);
});

test('基础 id 可直接参与成本反推与区分度', () => {
  const table = normalizePricingTable(bundled());
  const usage = {inputTokens: 10000, outputTokens: 2000};
  const candidates = ['gpt-6-astra', 'claude-opus-5-5', 'claude-opus-4-6'];

  // 用 astra 的期望成本回喂 → astra 必须排第一
  const astraExpected = expectedCostUsd(usage, table.profile('gpt-6-astra-max-agent')).usd;
  const ranked = rankByObservedCost(astraExpected, usage, candidates, table);
  assert.equal(ranked[0].model_key, 'gpt-6-astra');
  assert.ok(ranked[0].variants >= 2, '应记录展开的变体数');

  const d = discrimination(usage, candidates, table);
  assert.ok(d.rows.every(r => r.min_usd > 0 && r.max_usd >= r.min_usd));
  assert.equal(typeof d.separable, 'boolean');
  // 单点区间且互不重叠 → 价格可唯一区分
  assert.equal(d.separable, true);
});
