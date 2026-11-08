import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pairCostWithEstimates, pairCostWithUsage} from '../cost-ledger.js';
import * as ledgerMod from '../cost-ledger.js';
import * as priceMod from '../price-channel.js';
import * as pricingMod from '../pricing-channel.js';
import * as usageMod from '../usage-channel.js';

/* ---------- v2.16.1 花费反推（官方逐条 base ÷ 同消息 usage → 隐含单价排序） ----------
   地基：/cost messages 的 key 与会话包 assistant 消息 id 是同一套 UUID
   （CDP 实测 5/5 完全对齐，dev-scratch/_cdp-id-align.mjs）。
   金额是 Arena 计价真实口径；优先配精确 usage，没有时才弱回退转录估算 —— 结果始终是「可能性排序」，
   测试逐条盯住这个诚实口径，不让它漂移成定论。 */

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
/* vm 沙箱里产出的对象带沙箱 realm 的 prototype，deepStrictEqual 会误判 —— 序列化归一化再比。 */
const plain = value => JSON.parse(JSON.stringify(value));

/* 估算条目：纯 CJK 口径（1 token/字），reasoning 另算。
   text 1500 字 + reasoning 500 字 → outputTokens 2000 / reasoningTokens 500 / totalTokens 2000。 */
const est = (message_id, text = 1500, reasoning = 500) => ({
  message_id,
  chars: {
    text: {chars: text, cjk: text, other: 0},
    reasoning: {chars: reasoning, cjk: reasoning, other: 0},
  },
});

const exact = (message_id, outputTokens, inputTokens = 0) => ({
  message_id,
  usage: {
    type: 'language_model', usageSource: 'provider', inputTokens, outputTokens,
    totalTokens: inputTokens + outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  },
});

/* ==================== ① pairCostWithEstimates 纯函数 ==================== */

test('pairCostWithEstimates：id 对齐时全部配上，汇总口径自洽', () => {
  const messages = {m1: {basePriceUsd: 0.006}, m2: {basePriceUsd: 0.004}};
  const paired = pairCostWithEstimates(messages, [est('m1'), est('m2')]);
  assert.equal(paired.n_pairs, 2);
  assert.deepEqual(paired.pairs.map(p => p.message_id), ['m1', 'm2']);
  assert.deepEqual(paired.pairs.map(p => p.base_usd), [0.006, 0.004]);
  assert.deepEqual(paired.pairs.map(p => p.tokens), [2000, 2000]);
  assert.deepEqual(paired.cost_only, []);
  assert.deepEqual(paired.estimate_only, []);
  assert.equal(paired.total_base_usd, 0.01);
  assert.equal(paired.total_tokens, 4000);
  assert.equal(paired.usage.outputTokens, 4000);
  assert.equal(paired.usage.reasoningTokens, 1000);
  assert.equal(paired.usage.totalTokens, 4000);
  assert.equal(paired.usage.usage_source, 'chars-v1', 'token 一律标估算口径');
});

test('pairCostWithEstimates：两侧落单如实报告，不凑数', () => {
  const messages = {m1: {basePriceUsd: 0.006}, m3: {basePriceUsd: 0.001}};
  const paired = pairCostWithEstimates(messages, [est('m1'), est('m9', 100, 0)]);
  assert.equal(paired.n_pairs, 1);
  assert.deepEqual(paired.cost_only, ['m3'], '有账单没估算 → 落单在账单侧');
  assert.deepEqual(paired.estimate_only, ['m9'], '有估算没账单 → 落单在估算侧');
});

test('pairCostWithEstimates：完全对不上时零配对，usage 为 null', () => {
  const paired = pairCostWithEstimates({mA: {basePriceUsd: 0.01}}, [est('mB')]);
  assert.equal(paired.n_pairs, 0);
  assert.equal(paired.usage, null, '没有配对就不合成用量');
  assert.deepEqual(paired.cost_only, ['mA']);
  assert.deepEqual(paired.estimate_only, ['mB']);
});

test('pairCostWithEstimates：无效账单行直接跳过（不存在 ≠ 落单）', () => {
  const paired = pairCostWithEstimates(
    {m0: {}, mNeg: {basePriceUsd: -1}, mOk: {basePriceUsd: 0.002}},
    [est('mOk'), est('m0')],
  );
  assert.equal(paired.n_pairs, 1);
  assert.deepEqual(paired.cost_only, [], 'base 无效的行当作不存在，不占落单名额');
  assert.deepEqual(paired.estimate_only, ['m0'], '估算在、账单行无效 → 落单在估算侧');
  assert.ok(!paired.pairs.some(p => p.message_id === 'm0' || p.message_id === 'mNeg'));
});

test('pairCostWithEstimates：嵌套 actual.basePriceUsd 也认（双来源）', () => {
  const paired = pairCostWithEstimates({m1: {actual: {basePriceUsd: 0.008}}}, [est('m1', 1000, 0)]);
  assert.equal(paired.n_pairs, 1);
  assert.equal(paired.pairs[0].base_usd, 0.008);
});

test('pairCostWithEstimates：零 token 估算不配对（除零保护）', () => {
  const zero = {message_id: 'm1', chars: {text: {chars: 0, cjk: 0, other: 0}, reasoning: {chars: 0, cjk: 0, other: 0}}};
  const paired = pairCostWithEstimates({m1: {basePriceUsd: 0.008}}, [zero]);
  assert.equal(paired.n_pairs, 0);
  assert.deepEqual(paired.cost_only, ['m1'], '估算算不出 token → 账单侧落单，不进 pairs');
});

test('pairCostWithUsage：精确 usage 优先，且不混入其他消息的 chars-v1 估算', () => {
  const paired = pairCostWithUsage(
    {m1: {basePriceUsd: 0.006, totalCostUsd: 0.012}, m2: {basePriceUsd: 0.024, totalCostUsd: 0.048}},
    [exact('m1', 1000)],
    [est('m1', 90000, 0), est('m2', 4000, 0)],
  );
  assert.equal(paired.exact_usage, true);
  assert.equal(paired.usage_source, 'message-usage');
  assert.equal(paired.n_pairs, 1, '只有 exact usage 配上的 m1 进入精确子集');
  assert.deepEqual(paired.pairs.map(row => row.message_id), ['m1']);
  assert.equal(paired.total_base_usd, 0.006, '只用 Arena base，不用 totalCostUsd');
  assert.equal(paired.total_tokens, 1000, '不拿冲突的 chars-v1 估算覆盖精确 usage');
  assert.deepEqual(paired.cost_only, ['m2'], '精确子集外的账单不被估算凑配');
  assert.equal(paired.usage.totalTokens, 1000);
});

test('pairCostWithUsage：图像生成分项费用不参与纯 token 反推', () => {
  const paired = pairCostWithUsage(
    {m1: {basePriceUsd: 0.024, actual: {imageGenerationCostUsd: 0.02}}},
    [exact('m1', 1000)],
    [est('m1', 90000, 0)],
  );
  assert.equal(paired.n_pairs, 0);
  assert.equal(paired.exact_usage, false);
  assert.deepEqual(paired.non_token_media_cost, ['m1']);
  assert.equal(paired.n_non_token_media_cost, 1);
});

test('pairCostWithUsage：没有 explicit base 时拒绝 totalCostUsd / actualTotalUsd', () => {
  const paired = pairCostWithUsage({m1: {totalCostUsd: 0.01, actualTotalUsd: 0.01}}, [exact('m1', 1000)], [est('m1')]);
  assert.equal(paired.n_pairs, 0);
  assert.deepEqual(paired.cost_only, []);
});

/* ==================== ② costReverseBlock（background 沙箱） ====================
   work-compat / official-cost 同套路：剥掉 import 行后在 vm 里跑 background.js，
   注入真实模块实现（只有 chrome API 与指纹库是 stub）。 */

function makeBgApi({bank = null} = {}) {
  const pricingDoc = Object.assign(JSON.parse(read('arena-pricing-table.json')), {fetched_at: new Date().toISOString()});
  const stored = {'amp.pricing.live.v1': pricingDoc};
  const sandbox = {
    URL, console,
    chrome: {
      runtime: {id: 'test-extension', getURL: (p) => p, onMessage: {addListener() {}}, onConnect: {addListener() {}}},
      tabs: {onRemoved: {addListener() {}}},
      storage: {local: {
        get: async keys => { const out = {}; for (const key of (Array.isArray(keys) ? keys : [keys])) if (stored[key] !== undefined) out[key] = stored[key]; return out; },
        set: async () => {}, remove: async () => {},
      }},
    },
    registerRecaptchaAnchor: () => {}, createBalanceReader: () => ({}),
    fetch: async () => ({ok: false, status: 0, text: async () => '', json: async () => null}),
    ...ledgerMod, ...priceMod, ...pricingMod, ...usageMod,
    identifyPrepared: () => ({}), prepareOutputs: () => ({}),
    loadProbeBank: async () => bank,
    countNumbers: () => 0, parseNumbers: () => [],
    queryRunTrace: async () => null,
    rhythmProfile: () => ({}), rhythmVote: () => null, rhythmAccumulate: () => ({}),
    normalizeCostTable: () => null, crossCheckCost: () => null,
    observedCostFromSignals: () => null, observedCostDetail: () => null,
    describeCostDetail: () => '', chargedFromBase: () => null, TIER_LABEL: {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('background.js').replace(/^import .*;\r?\n/gm, '')
    + '\nglobalThis.api={costReverseBlock, ledgerBlock, cleanOfficialCost, netState};', ctx);
  return ctx.api;
}

function resetBg(bg, {official = null, estimates = [], messageUsage = [], gate = null} = {}) {
  bg.netState.officialCost = official;
  bg.netState.costRouteSignals = [];
  bg.netState.costSignals = [];
  bg.netState.messageUsage = messageUsage;
  bg.netState.transcriptEstimates = estimates;
  bg.netState.costGate = gate;
  bg.netState.identifiedModel = null;
}

test('costReverseBlock：隐含单价精确命中 → 该模型排第一（比值 1.000）', async () => {
  const bg = makeBgApi();
  /* Σbase $0.024 / Σtokens 4000 → 隐含 $6.00/Mtok，正好等于 grok-4.5-agent 的输出单价。 */
  const messages = {m1: {basePriceUsd: 0.012}, m2: {basePriceUsd: 0.012}};
  resetBg(bg, {official: {session: null, messages}, estimates: [est('m1'), est('m2')]});
  const block = await bg.costReverseBlock({candidates: ['claude-sonnet-5-agent', 'grok-4.5-agent', 'gpt-6-luna-max-agent']});
  assert.equal(block.blocked, undefined, '顺利出结果不该带 blocked');
  assert.equal(block.hits.length, 3, '三个候选都参与排序');
  assert.equal(block.hits[0].model_key, 'grok-4.5-agent', '比值最贴的排第一');
  assert.equal(block.hits[0].ratio, 1);
  assert.equal(block.hits[0].complete, true, '只用输出价折算也要标 complete（都覆盖到了）');
  assert.equal(block.observed_usd, 0.024);
  assert.equal(block.estimated_tokens, 4000);
  assert.equal(block.implied_usd_per_mtok, 6, '隐含单价 = Σbase ÷ Σtokens × 1e6');
  assert.equal(block.n_pairs, 2);
  assert.equal(block.n_cost_only, 0);
  assert.equal(block.n_estimate_only, 0);
  assert.equal(block.usage_source, 'chars-v1', '口径标注不丢：token 是估算');
  assert.match(block.text, /^花费反推: /);
  assert.ok(block.text.includes('Grok 4.5'), 'text 优先用展示名（有 label 就不用裸 key）');
  assert.ok(block.text.includes('比值 1'), '比值 1.000 → 文本里是 1');
  assert.match(block.note, /估算/);
  assert.match(block.note, /可能性排序/, 'honest 口径：排序不是定论');
  assert.match(block.note, /同价等价类/);
});

test('costReverseBlock：有精确用量时按同 message_id 的逐条 base 排序', async () => {
  const bg = makeBgApi();
  resetBg(bg, {
    official: {session: {actualTotalUsd: 0.072, aggregate: {basePriceUsd: 0.03}}, messages: {
      m1: {basePriceUsd: 0.006, totalCostUsd: 0.012}, m2: {basePriceUsd: 0.024, totalCostUsd: 0.048},
    }},
    estimates: [est('m1', 90000, 0), est('m2', 4000, 0)],
    messageUsage: [exact('m1', 1000)],
  });
  const block = await bg.costReverseBlock({candidates: ['grok-4.5-agent']});
  assert.equal(block.n_pairs, 1);
  assert.equal(block.observed_usd, 0.006, 'use the per-message base, not session aggregate or upstream actual');
  assert.equal(block.token_count, 1000);
  assert.equal(block.estimated_tokens, null);
  assert.equal(block.exact_usage, true);
  assert.equal(block.usage_source, 'message-usage');
  assert.equal(block.hits[0].model_key, 'grok-4.5-agent');
  assert.equal(block.hits[0].ratio, 1);
});

test('costReverseBlock：同价等价类如实标注 ambiguous', async () => {
  const bg = makeBgApi();
  /* glm-5.2 / glm-5.3 都是 1.4/4.4 —— 单靠花费区分不开，必须自己说。 */
  resetBg(bg, {official: {session: null, messages: {m1: {basePriceUsd: 0.0066}}}, estimates: [est('m1', 1500, 0)]});
  const block = await bg.costReverseBlock({candidates: ['glm-5.2-agent', 'glm-5.3-agent']});
  assert.equal(block.hits.length, 2);
  const ambiguous = block.same_price_groups.filter(group => group.ambiguous);
  assert.equal(ambiguous.length, 1, '两个同价候选归成一组');
  assert.deepEqual([...ambiguous[0].ids].sort(), ['glm-5.2-agent', 'glm-5.3-agent']);
});

test('costReverseBlock：没有官方账单 → 待命并说清怎么触发', async () => {
  const bg = makeBgApi();
  resetBg(bg, {official: null, estimates: [est('m1')]});
  const block = await bg.costReverseBlock({});
  assert.equal(block.blocked, 'no-official-cost');
  assert.match(block.note, /待命/);
  assert.match(block.note, /\/cost|API/);
});

test('costReverseBlock：灰度门拦着 → 待命文案带上门状态码', async () => {
  const bg = makeBgApi();
  resetBg(bg, {official: null, estimates: [est('m1')], gate: {status: 403, url: '/api/chat/x/cost'}});
  const block = await bg.costReverseBlock({});
  assert.equal(block.blocked, 'no-official-cost');
  assert.match(block.note, /403/, '门的状态要带出来，别让用户干等');
});

test('costReverseBlock：清洗后的 image 费用标记保留并阻止 token-only 定名', async () => {
  const bg = makeBgApi();
  const official = bg.cleanOfficialCost({session: null, messages: {m1: {basePriceUsd: 0.024, actual: {
    basePriceUsd: 0.024, inputTokensCostUsd: 0.001, outputTokensCostUsd: 0.003,
    imageGenerationCostUsd: 0.02, totalCostUsd: 0.024,
  }}}});
  assert.equal(official.messages.m1.non_token_media_cost, true, '后台白名单只保存安全标记');
  resetBg(bg, {official, messageUsage: [exact('m1', 1000)]});
  const block = await bg.costReverseBlock({});
  assert.equal(block.blocked, 'non-token-media-cost');
  assert.match(block.note, /图像/);
});

test('costReverseBlock：账单与估算对不上 → no-pairs 带两侧落单数', async () => {
  const bg = makeBgApi();
  resetBg(bg, {
    official: {session: null, messages: {mA: {basePriceUsd: 0.01}, mB: {basePriceUsd: 0.02}}},
    estimates: [est('mC'), est('mD')],
  });
  const block = await bg.costReverseBlock({});
  assert.equal(block.blocked, 'no-pairs');
  assert.equal(block.n_cost_only, 2);
  assert.equal(block.n_estimate_only, 2);
  assert.match(block.note, /消息 id/, '说清对不上的原因（不是同一会话）');
});

test('costReverseBlock：无价候选报 no-priced；缺省候选走 Arena 价表全量池', async () => {
  const bg = makeBgApi({bank: null});
  resetBg(bg, {official: {session: null, messages: {m1: {basePriceUsd: 0.003}}}, estimates: [est('m1')]});
  assert.equal((await bg.costReverseBlock({candidates: ['no-such-model-xyz']})).blocked, 'no-priced', '表里没价的候选');
  const fullTable = await bg.costReverseBlock({});
  assert.equal(fullTable.blocked, undefined, '缺省候选池来自 Arena 价表，与指纹库是否加载无关');
  assert.ok(fullTable.hits.length, '价表有模型时可进行全量可能性排序');
});

test('costReverseBlock：浮层传入的原始账单（嵌套 actual）同样能反推', async () => {
  const bg = makeBgApi();
  resetBg(bg, {official: null, estimates: [est('m1', 2000, 0)]});
  /* costPayload 走原始形态：base 在 entry.actual 里，双来源取值要认。
     2000t × $6/Mtok = $0.012 → 与 grok-4.5-agent 比值 1。 */
  const block = await bg.costReverseBlock({
    candidates: ['grok-4.5-agent'],
    costPayload: {session: null, messages: {m1: {actual: {basePriceUsd: 0.012}}}},
  });
  assert.equal(block.blocked, undefined);
  assert.equal(block.n_pairs, 1);
  assert.equal(block.hits[0].model_key, 'grok-4.5-agent', '2000t × $6/Mtok = $0.012 → 比值 1');
  assert.equal(block.hits[0].ratio, 1);
});

test('ledgerBlock 集成：官方账单 + 转录估算 → cost_reverse 自动出排序（Agent 模式）', async () => {
  const bg = makeBgApi({bank: {bank: {models: [{id: 'gpt-6-luna'}, {id: 'claude-sonnet-5'}]}}});
  const LIVE = JSON.parse(JSON.parse(read('dev-scratch/amp_livecost3.json')).r2.body);
  const official = bg.cleanOfficialCost({route: 'cost-api', path: '/api/chat/x/cost', session: LIVE.session, messages: LIVE.messages, at: 1770000000000});
  const estimates = Object.keys(LIVE.messages).map(id => est(id, 1000, 0));
  resetBg(bg, {official, estimates});
  const block = await bg.ledgerBlock();
  assert.equal(block.mode, 'cost-route');
  assert.equal(block.cost_rows, 5);
  assert.ok(block.cost_reverse?.hits?.length, '估算 token 在位 → 反推自动启用，无需额外消息');
  assert.equal(block.cost_reverse.n_pairs, 5, '5 条官方账单全部配上估算');
  assert.equal(block.cost_reverse.n_cost_only, 0);
  assert.equal(block.cost_reverse.n_estimate_only, 0);
  assert.equal(block.cost_reverse.estimated_tokens, 5000);
  assert.equal(block.cost_reverse.usage_source, 'chars-v1');
  assert.ok(Math.abs(block.cost_reverse.implied_usd_per_mtok - 0.3387464) < 0.0001, 'Σbase 0.0016937324 ÷ 5000t = $0.3387/Mtok');
  assert.match(block.cost_reverse.text, /^花费反推: /);
  /* 与 v2.13.3 的 reverse 共存：那个仍报 no-usage（Agent 没有服务端用量），两个口径不互相顶替。 */
  assert.equal(block.reverse.blocked, 'no-usage');
});

test('ledgerBlock 集成：没有官方账单时 cost_reverse 待命，不影响账本其余部分', async () => {
  const bg = makeBgApi();
  resetBg(bg, {official: null, estimates: []});
  const block = await bg.ledgerBlock();
  assert.equal(block.mode, 'blocked');
  assert.equal(block.cost_reverse.blocked, 'no-official-cost');
  assert.equal(block.reverse.blocked, 'no-observed-cost');
});

test('ledgerBlock reverse：用逐条 base 与同 message_id 的精确 usage，不用 session aggregate', async () => {
  const bg = makeBgApi({bank: {bank: {models: [{id: 'grok-4.5-agent'}]}}});
  resetBg(bg, {
    official: {session: {actualTotalUsd: 0.048, aggregate: {basePriceUsd: 0.024}}, messages: {
      m1: {basePriceUsd: 0.006, totalCostUsd: 0.012}, m2: {basePriceUsd: 0.018, totalCostUsd: 0.036},
    }},
    messageUsage: [exact('m1', 1000)],
  });
  const block = await bg.ledgerBlock();
  assert.equal(block.reverse.observed_usd, 0.006);
  assert.equal(block.reverse.message_id, 'm1');
  assert.equal(block.reverse.usage_source, 'message-usage');
  assert.equal(block.reverse.hits[0].model_key, 'grok-4.5-agent');
});

test('costReverseBlock：估算为空数组 / messages 非对象都不炸', async () => {
  const bg = makeBgApi();
  resetBg(bg, {official: {session: null, messages: {m1: {basePriceUsd: 0.003}}}});
  const a = await bg.costReverseBlock({});
  assert.equal(a.blocked, 'no-pairs');
  const b = pairCostWithEstimates(null, null);
  assert.equal(b.n_pairs, 0);
  assert.deepEqual(b.cost_only, []);
  const c = pairCostWithEstimates({m1: {basePriceUsd: 0.003}}, 'not-an-array');
  assert.equal(c.n_pairs, 0);
  assert.deepEqual(c.cost_only, ['m1']);
});
