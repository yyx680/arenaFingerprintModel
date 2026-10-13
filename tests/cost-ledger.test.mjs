import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEDGER_SCHEMA, formatUsd, formatUsdFixed, extractMessageUsage, baseCostFor,
  buildLedgerRow, ledgerTotals, buildLedger, tokenRatioText, samePriceGroups, describeTotals,
  ledgerRowsFromCostMessages,
} from '../cost-ledger.js';
import {normalizePricingTable} from '../pricing-channel.js';

/* 合成单价表：两个不同基础模型**同价**（10/50）用于测「同价分组」，
   另有一个便宜模型（0.2/1.2）用于测价格区分。 */
const TABLE = normalizePricingTable({
  schema: 'arena-model-pricing',
  source: 'test',
  fetched_at: '2026-10-12T00:00:00.000Z',
  unit: 'usd_per_million_tokens',
  rows: [
    {model_key: 'gpt-6-astra-max-agent', display: 'GPT-6 Astra Max', org: 'OpenAI', input_usd_per_mtok: 10, output_usd_per_mtok: 50},
    {model_key: 'gpt-6-astra-high-agent', display: 'GPT-6 Astra High', org: 'OpenAI', input_usd_per_mtok: 10, output_usd_per_mtok: 50},
    {model_key: 'gpt-6-sol-max-agent', display: 'GPT-6 Sol Max', org: 'OpenAI', input_usd_per_mtok: 10, output_usd_per_mtok: 50},
    {model_key: 'gpt-5.6-luna-xhigh-agent', display: 'GPT-5.6 Luna', org: 'OpenAI', input_usd_per_mtok: 0.2, output_usd_per_mtok: 1.2},
  ],
});

// 2026-10-11 CDP 实测用量（与 usage-channel 测试同源）。
const MEASURED_A = {type: 'language_model', inputTokens: 4, totalTokens: 7675, usageSource: 'provider', outputTokens: 326, cacheReadTokens: 3500, cacheWriteTokens: 3845};
const MEASURED_B = {type: 'language_model', inputTokens: 6, totalTokens: 15291, usageSource: 'provider', outputTokens: 4142, cacheReadTokens: 0, cacheWriteTokens: 11143};
const MEASURED_OLD = {type: 'language_model', inputTokens: 23937, totalTokens: 52473, usageSource: 'provider', outputTokens: 24184, cacheReadTokens: 4352, reasoningTokens: 14735};

const EVAL_BODY = JSON.stringify({
  id: '01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1',
  messages: [
    {id: '01a12bb5-0001', role: 'user', participantPosition: null, modelId: null, metadata: {}},
    {id: '01a12bb5-0002', role: 'assistant', participantPosition: 'a', modelId: null, metadata: {usage: MEASURED_A, workflowRunId: 'run_x'}},
    {id: '01a12bb5-0003', role: 'assistant', participantPosition: 'b', modelId: 'gpt-6-astra-max-agent', metadata: {usage: MEASURED_B, workflowRunId: 'run_y'}},
  ],
});

test('formatUsd / formatUsdFixed 金额显示', () => {
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(1.06317612), '$1.0632');
  assert.equal(formatUsd(0.206319), '$0.206319');
  assert.equal(formatUsd(0.00001234), '$1.23e-5');
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsdFixed(1.06317612), '$1.0632');
  assert.equal(formatUsdFixed(0.206319, 6), '$0.206319');
  assert.equal(formatUsdFixed(null), '—');
});

test('extractMessageUsage 结构化抽出逐条用量（带消息身份）', () => {
  const entries = extractMessageUsage(EVAL_BODY);
  assert.equal(entries.length, 2, '用户消息没有 usage，应被跳过');
  assert.equal(entries[0].message_id, '01a12bb5-0002');
  assert.equal(entries[0].role, 'assistant');
  assert.equal(entries[0].position, 'a');
  assert.equal(entries[0].model_id, null);
  assert.equal(entries[0].usage.totalTokens, 7675);
  assert.equal(entries[1].message_id, '01a12bb5-0003');
  assert.equal(entries[1].model_id, 'gpt-6-astra-max-agent');
  assert.equal(entries[1].usage.cacheWriteTokens, 11143);
});

test('extractMessageUsage 对脏输入一律返回空数组', () => {
  assert.deepEqual(extractMessageUsage(null), []);
  assert.deepEqual(extractMessageUsage(''), []);
  assert.deepEqual(extractMessageUsage('not json'), []);
  assert.deepEqual(extractMessageUsage('{"messages":"nope"}'), []);
  assert.deepEqual(extractMessageUsage('{"usage":{"inputTokens":1}}'), [], '没有 messages 数组');
  assert.deepEqual(extractMessageUsage('x'.repeat(400001)), [], '超长直接放弃');
  // 消息里没有 usage 时跳过，不当成 0。
  assert.deepEqual(extractMessageUsage('{"messages":[{"id":"a","metadata":{}}]}'), []);
});

test('baseCostFor 用公开单价折算基准价（缓存无价时标下界）', () => {
  const usage = {inputTokens: 4, outputTokens: 326, cacheReadTokens: 3500, cacheWriteTokens: 3845, totalTokens: 7675};
  const cost = baseCostFor(usage, 'gpt-6-astra', TABLE);
  assert.equal(cost.priced, true);
  // 10/50 两档同价 → 4/1e6*10 + 326/1e6*50 = 0.00004 + 0.0163
  assert.ok(Math.abs(cost.usd - 0.01634) < 1e-9);
  assert.equal(cost.variants, 2);
  assert.equal(cost.complete, false, '缓存单价未下发 → 只是下界');

  // 便宜模型应与贵模型拉开量级
  const cheap = baseCostFor(usage, 'gpt-5.6-luna', TABLE);
  assert.ok(cheap.usd < cost.usd / 10);
});

test('baseCostFor 缺模型或缺价时绝不猜价', () => {
  assert.equal(baseCostFor(MEASURED_A, null, TABLE).priced, false);
  assert.equal(baseCostFor(MEASURED_A, 'gpt-6-astra', null).priced, false);
  assert.equal(baseCostFor(null, 'gpt-6-astra', TABLE).priced, false);
  const unknown = baseCostFor(MEASURED_A, 'no-such-model', TABLE);
  assert.equal(unknown.priced, false);
  assert.equal(unknown.reason, 'no-price');
});

test('buildLedgerRow 把真实成本与基准价拼在一行', () => {
  const entries = extractMessageUsage(EVAL_BODY);
  const row = buildLedgerRow(entries[1], TABLE, {actual_usd: 1.06317612, charged_usd: 2.12635223, credits: 2126.35223, multiplier: 2});
  assert.equal(row.message_id, '01a12bb5-0003');
  assert.equal(row.model, 'gpt-6-astra-max-agent');
  assert.equal(row.tokens, 15291);
  assert.ok(row.base_usd > 0);
  assert.equal(row.actual_usd, 1.06317612);
  assert.equal(row.charged_usd, 2.12635223);
  assert.equal(row.credits, 2126.35223);
  assert.equal(row.multiplier, 2);
  assert.equal(row.source, 'cost-route+pricing-table');

  // 没有真实成本时只给基准价，标 pricing-table，绝不编实扣。
  const plain = buildLedgerRow(entries[0], TABLE);
  assert.equal(plain.charged_usd, null);
  assert.equal(plain.source, plain.base_usd === null ? null : 'pricing-table');
});

test('ledgerTotals 只累加有价的行，缺价计入 unpriced', () => {
  const entries = extractMessageUsage(EVAL_BODY);
  // 第二条把 modelId 去掉 → 无价
  const rows = [
    buildLedgerRow(entries[1], TABLE),
    buildLedgerRow({...entries[0], model_id: null}, TABLE),
  ];
  const totals = ledgerTotals(rows);
  assert.equal(totals.schema, LEDGER_SCHEMA);
  assert.equal(totals.messages, 2);
  assert.equal(totals.priced, 1);
  assert.equal(totals.unpriced, 1);
  assert.equal(totals.tokens, 7675 + 15291);
  assert.ok(totals.base_usd > 0);
  assert.equal(totals.charged_usd, null, '没有真实成本就不该有实扣');
});

test('ledgerTotals 从 charged/base 推出倍率（实测 = 2）', () => {
  const entries = extractMessageUsage(EVAL_BODY);
  const row = buildLedgerRow(entries[1], TABLE);
  row.charged_usd = Number((row.base_usd * 2).toFixed(6));
  const totals = ledgerTotals([row]);
  assert.equal(totals.multiplier, 2);
  assert.equal(totals.charged_usd, Number((totals.base_usd * 2).toFixed(6)));
});

test('buildLedger 出整表并编号', () => {
  const entries = extractMessageUsage(EVAL_BODY);
  const ledger = buildLedger(entries, TABLE, {'01a12bb5-0003': {charged_usd: 0.5}});
  assert.equal(ledger.rows.length, 2);
  assert.equal(ledger.rows[0].index, 1);
  assert.equal(ledger.rows[1].index, 2);
  assert.equal(ledger.rows[1].charged_usd, 0.5);
  assert.equal(ledger.totals.messages, 2);
  // 空输入不炸
  assert.equal(buildLedger([], TABLE).rows.length, 0);
  assert.equal(buildLedger(null, TABLE).totals.messages, 0);
});

test('tokenRatioText 归一到最小项 = 1', () => {
  // 输出 1000 / 缓存写 250 / 缓存读 10 → 100 : 25 : 1
  assert.equal(tokenRatioText({outputTokens: 1000, cacheWriteTokens: 250, cacheReadTokens: 10}), '输出:缓存写:缓存读 = 100.0 : 25.0 : 1');
  // 有一项为 0 → 显示 0
  assert.equal(tokenRatioText({outputTokens: 4142, cacheWriteTokens: 11143, cacheReadTokens: 0}), '输出:缓存写:缓存读 = 1 : 2.7 : 0');
  // 只有一项 → 无法比，给原始计数
  assert.equal(tokenRatioText({outputTokens: 500}), '输出 500 / 缓存写 0 / 缓存读 0（不足两项，无法比）');
  assert.equal(tokenRatioText(null), null);
});

test('samePriceGroups 把同价模型归到一组（价格区分不开）', () => {
  const groups = samePriceGroups(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-luna'], TABLE);
  assert.equal(groups.length, 2, 'astra 与 sol 同价应合并成一组');
  assert.deepEqual(groups[0].ids.sort(), ['gpt-6-astra', 'gpt-6-sol']);
  assert.equal(groups[0].input_usd_per_mtok, 10);
  assert.equal(groups[0].output_usd_per_mtok, 50);
  assert.deepEqual(groups[1].ids, ['gpt-5.6-luna']);
  // 无价模型不进任何组
  assert.equal(samePriceGroups(['no-such-model'], TABLE).length, 0);
  assert.deepEqual(samePriceGroups([], TABLE), []);
  assert.deepEqual(samePriceGroups(null, TABLE), []);
});

test('describeTotals 一行摘要', () => {
  const entries = extractMessageUsage(EVAL_BODY);
  const ledger = buildLedger(entries, TABLE, {'01a12bb5-0003': {charged_usd: 0.5, credits: 500}});
  const text = describeTotals(ledger.totals);
  assert.ok(text.includes('2 条'));
  assert.ok(text.includes('基准价合计'));
  assert.ok(text.includes('实扣合计'));
  assert.ok(text.includes('500 积分'));
  assert.equal(describeTotals(null), '尚无用量记录（发一条消息后才有）');
  assert.equal(describeTotals({messages: 0}), '尚无用量记录（发一条消息后才有）');
});

test('真实榜单快照能算出一条实测用量的基准价（集成）', async () => {
  const {readFileSync} = await import('node:fs');
  const doc = JSON.parse(readFileSync(new URL('../arena-pricing-table.json', import.meta.url), 'utf8'));
  const table = normalizePricingTable(doc);
  const usage = {inputTokens: 6, outputTokens: 4142, cacheReadTokens: 0, cacheWriteTokens: 11143, totalTokens: 15291};
  const astra = baseCostFor(usage, 'gpt-6-astra', table);
  const luna = baseCostFor(usage, 'gpt-5.6-luna', table);
  assert.equal(astra.priced, true);
  assert.equal(luna.priced, true);
  // astra（10/50）应显著贵于 luna（0.2/1.2）
  assert.ok(astra.usd > luna.usd * 10, `astra ${astra.usd} 应远贵于 luna ${luna.usd}`);
  // 与文档 §4.3 的量级一致：luna ≈ $0.005、astra ≈ $0.21
  assert.ok(luna.usd > 0.001 && luna.usd < 0.02, `luna ${luna.usd} 应在 $0.001~0.02`);
  assert.ok(astra.usd > 0.1 && astra.usd < 0.5, `astra ${astra.usd} 应在 $0.1~0.5`);
  // MEASURED_OLD 的推理 token 也走一遍，确认不炸
  assert.equal(baseCostFor(MEASURED_OLD, 'gpt-6-astra', table).priced, true);
});

/* ---------- v2.13.4：/cost 路由 → 账本行（Agent 模式唯一可能的金额来源） ---------- */

test('ledgerRowsFromCostMessages 把 /cost 的 messages 映射摊成账本行', () => {
  const messages = {
    m1: {actual: {totalCostUsd: 0.0123, basePriceUsd: 0.0061, totalChargedUsd: 0.0123, totalChargedCredits: 12.3}, marginMultiplier: 2},
    m2: {actual: {basePriceUsd: 0.002, totalChargedUsd: 0.004}},
    m3: {},                       // 无任何数值 → 跳过
    m4: {actual: {totalCostUsd: 0}}, // 0 不算有效金额 → 跳过
  };
  const rows = ledgerRowsFromCostMessages(messages);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].schema, LEDGER_SCHEMA);
  assert.equal(rows[0].message_id, 'm1');
  assert.equal(rows[0].index, 1);
  assert.equal(rows[0].base_usd, 0.0061);
  assert.equal(rows[0].charged_usd, 0.0123);
  assert.equal(rows[0].credits, 12.3);
  assert.equal(rows[0].multiplier, 2);
  assert.equal(rows[0].source, 'cost-route');
  // 没有 token 用量：tokens / usage 必须是 null，不能假装有
  assert.equal(rows[0].tokens, null);
  assert.equal(rows[0].usage, null);
  // m2 没有 marginMultiplier，倍率应可由 base/charged 推或为 null（这里由 ledgerTotals 统一处理）
  assert.equal(rows[1].message_id, 'm2');
  assert.equal(rows[1].base_usd, 0.002);
});

test('ledgerRowsFromCostMessages 对空/非法输入返回空数组（不炸、不猜）', () => {
  assert.deepEqual(ledgerRowsFromCostMessages(null), []);
  assert.deepEqual(ledgerRowsFromCostMessages(undefined), []);
  assert.deepEqual(ledgerRowsFromCostMessages([]), []);
  assert.deepEqual(ledgerRowsFromCostMessages('nope'), []);
  assert.deepEqual(ledgerRowsFromCostMessages({}), []);
});

test('ledgerRowsFromCostMessages 的产出能直接喂给 ledgerTotals 汇总', () => {
  const rows = ledgerRowsFromCostMessages({
    a: {actual: {basePriceUsd: 0.01, totalChargedUsd: 0.02, totalChargedCredits: 20}, marginMultiplier: 2},
    b: {actual: {basePriceUsd: 0.03, totalChargedUsd: 0.06, totalChargedCredits: 60}, marginMultiplier: 2},
  });
  const totals = ledgerTotals(rows);
  assert.equal(totals.messages, 2);
  assert.equal(totals.priced, 2);
  assert.equal(Number(totals.base_usd.toFixed(6)), 0.04);
  assert.equal(Number(totals.charged_usd.toFixed(6)), 0.08);
  assert.equal(Number(totals.credits.toFixed(6)), 80);
  assert.equal(totals.multiplier, 2);
});
