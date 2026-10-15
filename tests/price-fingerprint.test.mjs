import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as ledgerMod from '../cost-ledger.js';
import * as priceMod from '../price-channel.js';
import * as pricingMod from '../pricing-channel.js';
import * as usageMod from '../usage-channel.js';

/* ---------- v2.17.0 价格指纹通道（候选集内价格能否唯一切开）----------
   与 v2.16.1 的 costReverseBlock（全库排序、只作旁证）的区别：本通道只在**识别候选集**内
   裁决，且允许单独定名 —— 但必须先满足「唯一命中 + 比值贴合 + 无同价歧义」三条。
   测试逐条盯住这个「宁可不定名也不猜」的闸门。 */

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

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

function makeBgApi(probeBank = null, {cacheRates = null, pricing = null, openRouter = null, battleRates = null} = {}) {
  const pricingDoc = Object.assign(JSON.parse(read('arena-pricing-table.json')), {fetched_at: new Date().toISOString()});
  if (pricing) Object.assign(pricingDoc, pricing);
  const stored = {'amp.pricing.live.v1': pricingDoc};
  /* v2.19.0：cache 费率补充表的注入。
     loadCacheRates() 走 fetch(chrome.runtime.getURL('arena-cache-rates.json'))，测试沙箱里没有扩展运行时，
     默认返回 {ok:false}（=读不到，价格通道退回纯软判据）。要测合并效果就显式喂一份。 */
  const ratesDoc = cacheRates === 'real' ? JSON.parse(read('arena-cache-rates.json'))
    : cacheRates && typeof cacheRates === 'object' ? cacheRates : null;
  const battleDoc = battleRates === 'real' ? JSON.parse(read('arena-battle-price-rates.json'))
    : battleRates && typeof battleRates === 'object' ? battleRates : null;
  /* v2.19.6：OpenRouter 公开价目补充表（模型本体）同理。 */
  const orDoc = openRouter === 'real' ? JSON.parse(read('openrouter-prices.json'))
    : openRouter && typeof openRouter === 'object' ? openRouter : null;
  const fetchImpl = async (url) => {
    if (ratesDoc && String(url).includes('arena-cache-rates.json')) {
      return {ok: true, status: 200, json: async () => ratesDoc, text: async () => JSON.stringify(ratesDoc)};
    }
    if (battleDoc && String(url).includes('arena-battle-price-rates.json')) {
      return {ok: true, status: 200, json: async () => battleDoc, text: async () => JSON.stringify(battleDoc)};
    }
    if (orDoc && String(url).includes('openrouter-prices.json')) {
      return {ok: true, status: 200, json: async () => orDoc, text: async () => JSON.stringify(orDoc)};
    }
    return {ok: false, status: 0, text: async () => '', json: async () => null};
  };
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
    createBalanceReader: () => ({}),
    fetch: fetchImpl,
    ...ledgerMod, ...priceMod, ...pricingMod, ...usageMod,
    identifyPrepared: () => ({}), prepareOutputs: () => ({}),
    loadProbeBank: async () => probeBank,
    countNumbers: () => 0, parseNumbers: () => [],
    queryRunTrace: async () => null,
    rhythmProfile: () => ({}), rhythmVote: () => null, rhythmAccumulate: () => ({}),
    normalizeCostTable: () => null, crossCheckCost: () => null,
    observedCostFromSignals: () => null, observedCostDetail: () => null,
    describeCostDetail: () => '', chargedFromBase: () => null, TIER_LABEL: {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('background.js').replace(/^import .*;\r?\n/gm, '')
    + '\nglobalThis.api={priceFingerprintBlock, costReverseBlock, netState, loadPricingTable};', ctx);
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

test('价格指纹：候选内唯一贴合 → separable，可单独定名', async () => {
  const bg = makeBgApi();
  /* 4000 个精确 token × $6/Mtok(grok-4.5-agent 出价) = $0.024。估算故意冲突，必须优先用 exact usage。 */
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.012}, m2: {basePriceUsd: 0.012}}},
    estimates: [est('m1', 1, 0), est('m2', 50000, 0)],
    messageUsage: [exact('m1', 2000), exact('m2', 2000)],
  });
  const fp = await bg.priceFingerprintBlock(['grok-4.5-agent', 'claude-sonnet-5-agent', 'gpt-6-luna-max-agent']);
  assert.equal(fp.separable, true);
  assert.equal(fp.reason, 'unique');
  assert.equal(fp.hit.model_key, 'grok-4.5-agent');
  assert.equal(fp.hit.ratio, 1);
  assert.equal(fp.candidates, 3);
  assert.equal(fp.n_pairs, 2);
  assert.equal(fp.token_count, 4000);
  assert.equal(fp.estimated_tokens, null, '精确用量不标成估算');
  assert.equal(fp.exact_usage, true);
  assert.equal(fp.usage_source, 'message-usage');
  assert.equal(fp.implied_usd_per_mtok, 6);
  assert.match(fp.text, /^价格指纹: /);
  assert.match(fp.text, /唯一命中/);
  assert.match(fp.note, /同价等价类/);
});

test('价格指纹：chars-v1 估算即使唯一贴合也不能独立定名', async () => {
  const bg = makeBgApi();
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.006}}},
    estimates: [est('m1', 1000, 0)],
  });
  const fp = await bg.priceFingerprintBlock(['grok-4.5-agent']);
  assert.equal(fp.hit.ratio, 1, '估算比值本身恰好唯一命中');
  assert.equal(fp.separable, false, '弱估算不能独立触发唯一模型命名');
  assert.equal(fp.reason, 'not-separable');
  assert.equal(fp.exact_usage, false);
  assert.equal(fp.usage_source, 'chars-v1');
  assert.match(fp.text, /chars-v1.*弱证据/);
  assert.match(fp.note, /不能独立触发模型定名/);
});

test('价格指纹：命中与别的候选同价 → 不可定名（同价区分不开）', async () => {
  const bg = makeBgApi();
  /* glm-5.2 / glm-5.3 都是 1.4/4.4：只给这俩候选，价格切不开。 */
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.0066}}},
    estimates: [est('m1', 1500, 0)],
  });
  const fp = await bg.priceFingerprintBlock(['glm-5.2-agent', 'glm-5.3-agent']);
  assert.equal(fp.separable, false);
  assert.equal(fp.reason, 'not-separable');
  assert.match(fp.text, /同价/);
  assert.match(fp.text, /不能唯一定名/);
});

test('价格指纹：命中比值超出贴合窗口 → 不定名', async () => {
  const bg = makeBgApi();
  /* 1000t × grok-4.5 的 $6/Mtok = $0.006，账单却写 $0.2 → 隐含 $200/Mtok，差 33×。
     v2.19.5 后窗口是 ±10%（比值 [0.909, 1.100]）—— 33× 当然被拒。 */
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.2}}},
    estimates: [est('m1', 1000, 0)],
  });
  const fp = await bg.priceFingerprintBlock(['grok-4.5-agent']);
  assert.equal(fp.separable, false);
  assert.match(fp.text, /超出贴合窗口/);
});

test('价格指纹：与第二名拉不开距离 → 不定名', async () => {
  const bg = makeBgApi();
  /* 隐含 $5/Mtok（2000t × $0.01）：gpt-5.1-high 出价 $5（比值 1 · z=0）、
     grok-4.5 最低档出价 $6（比值 0.833 · z=0.263）。两者都 within(≤0.8)，
     且 z 差 0.263 < 0.35 ⇒ 拉不开距离，禁止定名。 */
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.01}}},
    estimates: [est('m1', 2000, 0)],
  });
  const fp = await bg.priceFingerprintBlock(['gpt-5.1', 'grok-4.5']);
  assert.equal(fp.separable, false, '价格没能把两个候选真正切开');
  assert.match(fp.text, /拉不开距离/);
});

test('价格指纹：没有官方账单 / 没有候选 → 如实待命，不硬出排序', async () => {
  const bg = makeBgApi();
  resetBg(bg, {official: null, estimates: [est('m1')]});
  const noCost = await bg.priceFingerprintBlock(['grok-4.5-agent']);
  assert.equal(noCost.separable, false);
  assert.equal(noCost.reason, 'no-official-cost');

  resetBg(bg, {official: {session: null, messages: {m1: {basePriceUsd: 0.02}}}, estimates: [est('m1')]});
  const noCand = await bg.priceFingerprintBlock([]);
  assert.equal(noCand.separable, false);
  assert.equal(noCand.reason, 'no-candidates');
});

test('价格指纹：账单与估算对不上 → 待命并带原因', async () => {
  const bg = makeBgApi();
  resetBg(bg, {
    official: {session: null, messages: {mA: {basePriceUsd: 0.02}}},
    estimates: [est('mB')],
  });
  const fp = await bg.priceFingerprintBlock(['grok-4.5-agent']);
  assert.equal(fp.separable, false);
  assert.equal(fp.reason, 'no-pairs');
});

test('价格指纹：候选全无价 → no-priced', async () => {
  const bg = makeBgApi();
  resetBg(bg, {official: {session: null, messages: {m1: {basePriceUsd: 0.003}}}, estimates: [est('m1')]});
  const fp = await bg.priceFingerprintBlock(['no-such-model-xyz']);
  assert.equal(fp.separable, false);
  assert.equal(fp.reason, 'no-priced');
});

test('价格指纹：单候选也走同一闸门（唯一命中才 separable）', async () => {
  const bg = makeBgApi();
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.012}}},
    messageUsage: [exact('m1', 2000)],
  });
  const fp = await bg.priceFingerprintBlock(['grok-4.5-agent']);
  assert.equal(fp.separable, true);
  assert.equal(fp.hit.ratio, 1);
  assert.equal(fp.runner_up, null);
});

/* 真机（2026-10-12，CDP 9222 会话 01a12c2a）暴露的边界：候选只有一个时**没有第二名**，
   判据不能因此无条件放行 —— 比值不贴合照样降级。否则「只有一个候选」会变成伪置信：
   数字通道只给出一个候选 + 价格明显不符，仍被定名。 */
test('价格指纹：单候选但比值不贴合 → 仍降级（无第二名不等于可定名）', async () => {
  const bg = makeBgApi();
  resetBg(bg, {
    /* grok-4.5 出价 $6/Mtok；观测 $0.004 ÷ 2000tok = $2/Mtok（比值 1/3）→
       远超 v2.19.5 的 ±10% 窗口，必须拒绝定名。 */
    official: {session: null, messages: {m1: {basePriceUsd: 0.004}}},
    estimates: [est('m1', 2000, 0)],
  });
  const fp = await bg.priceFingerprintBlock(['grok-4.5-agent']);
  assert.equal(fp.separable, false);
  assert.equal(fp.reason, 'not-separable');
  assert.equal(fp.runner_up, null);
  assert.match(fp.text, /超出贴合窗口/);
});

/* ★ 真机回归（2026-10-13）：用户截图里本插件把**比值 0.841（偏差 16%）**的 claude-sonnet-4-6
   报成「唯一命中 · 全库 208 个模型里只此一个贴合」，而用户指出 Arena 基本没这个模型。
   根因：`z` 的除数误用 ln2（pricing-channel 用 ln(CONSISTENT_RATIO)=ln1.6），
   使 PRICE_FINGERPRINT_Z=0.8 实际等效 1.18，贴合窗口被放宽到 [0.574, 1.741]。
   本测试钉死：16% 偏差必须被拒。 */
test('价格指纹：比值 0.841（偏差 16%）→ 拒绝定名（真机 claude-sonnet-4-6 误报回归）', async () => {
  const bg = makeBgApi();
  /* claude-sonnet-4-6 的 out 价 $7.5/Mtok：1000 输出 token → 期望 $0.0075；
     账单给 $0.0063075 → 比值恰为 0.841（就是真机截图里那个数）。 */
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.0063075}}},
    estimates: [est('m1', 1000, 0)],
  });
  const fp = await bg.priceFingerprintBlock(['claude-sonnet-4-6']);
  assert.equal(fp.hit.model_key, 'claude-sonnet-4-6', '最贴近的确实是它');
  assert.equal(fp.hit.ratio, 0.841, '比值就是真机那个 0.841');
  assert.equal(fp.separable, false, '★ 16% 偏差不足以定名');
  assert.equal(fp.reason, 'not-separable');
  assert.match(fp.text, /超出贴合窗口/);
});

test('价格指纹：贴合窗口就是 ±10%（比值 1.09 通过 / 1.11 拒绝）', async () => {
  const bg = makeBgApi(null, {pricing: {source: 'live', rows: [
    {model_key: 'gamma-one', display: 'Gamma One', org: 'gamma', input_usd_per_mtok: 10, output_usd_per_mtok: 10, cache_write_usd_per_mtok: 12.5, cache_read_usd_per_mtok: 1},
  ]}});
  const run = async base => {
    resetBg(bg, {official: {session: null, messages: {m1: {basePriceUsd: base}}}, messageUsage: [exact('m1', 1000)]});
    return bg.priceFingerprintBlock(['gamma-one']);
  };
  const ok = await run(0.0109);   /* 1000t × $10/Mtok = $0.01 → 比值 1.09 */
  assert.equal(ok.separable, true, '比值 1.09 落在 ±10% 窗口内');
  const bad = await run(0.0111);  /* 比值 1.11 */
  assert.equal(bad.separable, false, '比值 1.11 超出 ±10% 窗口');
  assert.match(bad.text, /超出贴合窗口（±10%）/);
});

test('background.js：贴合判据必须真的数一遍窗口内的模型（源码级）', () => {
  const bgSrc = read('background.js');
  /* v2.19.5：注释写的是「只有一个模型落进阈值」，实现此前只比 top1/top2 的 z 差。 */
  assert.match(bgSrc, /const withinHits = hits\.filter\(hit => zOf\(hit\) <= PRICE_FINGERPRINT_Z\)/, '统计窗口内命中');
  assert.match(bgSrc, /const uniqueInWindow = withinHits\.length === 1/, '窗口内必须恰好一个');
  assert.match(bgSrc, /const exactUsage = base\.exact_usage === true/, '唯一定名必须知道 token 是否为同消息精确用量');
  assert.match(bgSrc, /const softSeparable = exactUsage && within && separated && uniqueInWindow && !ambiguousGroup/, 'exact usage 与 uniqueInWindow 都参与闸门');
  /* 刻度：除数必须是 ln(CONSISTENT_RATIO)，不能是 ln2。 */
  assert.match(bgSrc, /Math\.log\(CONSISTENT_RATIO\)/, 'z 用 ln(CONSISTENT_RATIO) 刻度');
  assert.ok(!/Math\.log\(Number\(hit\.ratio\) \|\| 1\)\) \/ Math\.log\(2\)/.test(bgSrc), '不得再用 ln2 做除数');
  /* 窗口/间距用比值表达再换算，避免再次写错刻度。 */
  assert.match(bgSrc, /const PRICE_FINGERPRINT_RATIO = 1\.10;/, '窗口 ±10%');
  assert.match(bgSrc, /const PRICE_FINGERPRINT_Z = Math\.log\(PRICE_FINGERPRINT_RATIO\) \/ Math\.log\(CONSISTENT_RATIO\)/, '由比值换算 z');
});

/* ---------- content.js 侧：价格回退的 separable 闸门必须要求精确 usage ---------- */

test('content.js：价格回退只有 exact usage 才能 separable（源码级）', () => {
  const content = read('content.js');
  assert.match(content, /const exactUsage=fp\.exact_usage===true;\s*const ok=exactUsage&&within&&separated&&uniqueInWindow&&!ambiguous;/, 'chars-v1 回退不能独立触发唯一命名');
  /* 价格指纹默认关闭：DEFAULTS 里必须为 false，sanitize 里必须 === true。 */
  assert.match(content, /priceChannel:false\}/, '默认关闭');
  assert.match(content, /priceChannel:value\?\.priceChannel===true/, '只有显式 true 才开启');
  /* 阈值判据在 content 侧要与 background 一致。v2.19.5：窗口 ±10% + 间距 25%，
     且**都用 ln(1.6) 刻度**（此前两处都误用 ln2，导致阈值实际放大约 1.47 倍）。
     这段是 background.js priceFingerprintBlock 判据的镜像，两边必须同步。 */
  assert.match(content, /FP_WINDOW=1\.10,FP_GAP_RATIO=1\.25,FP_LN_CONSISTENT=Math\.log\(1\.6\)/, '窗口/间距/刻度常量');
  assert.match(content, /const fpZ=Math\.log\(FP_WINDOW\)\/FP_LN_CONSISTENT/, 'z 换算必须用 ln1.6，不是 ln2');
  assert.match(content, /uniqueInWindow=fp\.hits\.filter\(hit=>zOf\(hit\)<=fpZ\)\.length===1/, '真的数一遍窗口里有几个模型');
});

/* ---------- v2.18.0：价格指纹升级为**独立识别模式**（全库裁决，不借数字候选集）----------
   与候选集路径的唯一区别是候选来源：候选为空 + fullBank:true 时用 Arena 官方单价表里的文本模型。
   判据（贴合阈值 / 拉不开距离 / 同价歧义）一条不松 —— 全库贴合概率更高，更要守住这条线。 */

const bank = opts => ({bank: {models: opts}, info: {source: 'test'}});

test('价格指纹（全库）：fullBank 让空候选走全库（整张单价表）→ 命中唯一 → separable + scope=full-bank', async () => {
  /* v2.19.6：全库池子改成**整张单价表**（不再是指纹库 —— 指纹库只有 21 个模型且只有 3 个
     能对上单价表）。这里喂一份 3 行的小表，池子才可控。 */
  const bg = makeBgApi(null, {pricing: {source: 'live', rows: [
    {model_key: 'grok-4.5-agent', display: 'Grok 4.5', org: 'xai', input_usd_per_mtok: 6, output_usd_per_mtok: 6, cache_write_usd_per_mtok: 7.5, cache_read_usd_per_mtok: 0.6},
    {model_key: 'claude-sonnet-5-agent', display: 'Claude Sonnet 5', org: 'anthropic', input_usd_per_mtok: 3, output_usd_per_mtok: 15, cache_write_usd_per_mtok: 3.75, cache_read_usd_per_mtok: 0.3},
    {model_key: 'gpt-6-luna-max-agent', display: 'GPT 6 Luna', org: 'openai', input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, cache_write_usd_per_mtok: 0.125, cache_read_usd_per_mtok: 0.01},
  ]}});
  /* 4000 个精确 token × $6/Mtok = $0.024（grok-4.5-agent 出价 6）；其余两个出价远，全库内只有它贴合。 */
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.012}, m2: {basePriceUsd: 0.012}}},
    messageUsage: [exact('m1', 2000), exact('m2', 2000)],
  });
  const fp = await bg.priceFingerprintBlock([], {fullBank: true});
  assert.equal(fp.separable, true);
  assert.equal(fp.reason, 'unique');
  assert.equal(fp.scope, 'full-bank');
  assert.equal(fp.hit.model_key, 'grok-4.5-agent');
  assert.equal(fp.candidates, 3);
  assert.match(fp.text, /Arena 官方模型池 3 个模型里只有它落进 ±10% 窗口/);
  assert.match(fp.note, /只在 Arena 官方价目列出的模型里比价/);
});

test('价格指纹：Gemini 3.8 与 GPT 6.1 按各自单价比较并返回费率明细', async () => {
  const bg = makeBgApi();
  /* 1000 in + 1000 out：Gemini 3.8 为 $0.0045，GPT 6.1 为 $0.012。 */
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.0045}}},
    messageUsage: [exact('m1', 1000, 1000)],
  });
  const fp = await bg.priceFingerprintBlock(['skimaki-kwc6-agent', 'gpt-6.1-sol-max-agent']);
  assert.equal(fp.separable, true);
  assert.equal(fp.hit.model_key, 'skimaki-kwc6-agent');
  assert.equal(fp.hit.expected_usd, 0.0045);
  assert.equal(fp.hit.rates.input_usd_per_mtok, 0.75);
  assert.equal(fp.hit.rates.output_usd_per_mtok, 3.75);
  assert.equal(fp.runner_up.model_key, 'gpt-6.1-sol-max-agent');
  assert.equal(fp.runner_up.rates.input_usd_per_mtok, 2);
  assert.equal(fp.runner_up.rates.output_usd_per_mtok, 10);
  assert.equal(fp.price_window_hits.length, 1);
  assert.equal(fp.price_window_hits[0].rates.output_usd_per_mtok, 3.75);
});

test('价格指纹：窗口内唯一性检查完整排名，不被 top-8 截断', async () => {
  /* 7 个完整费率模型的比值为 1.3（贴合窗外但排名靠前）；第 9 名费率不全，
     比值 1.08 仍在 ±10% 窗口。旧逻辑只看前 8 名，会把 best-match 误报成唯一。 */
  const farExpected = 10.05 / 1.3;
  const farInput = farExpected - 0.001; // 100k cache-read × $0.01/Mtok = $0.001
  const nearInput = 10.05 / 1.08;
  const rows = [
    {model_key: 'best-match', display: 'Best Match', org: 'test', input_usd_per_mtok: 10, output_usd_per_mtok: 10, cache_read_usd_per_mtok: 0.5},
    ...Array.from({length: 7}, (_, index) => ({model_key: `outside-window-${index + 1}`, display: `Outside ${index + 1}`, org: 'test', input_usd_per_mtok: farInput, output_usd_per_mtok: 10, cache_read_usd_per_mtok: 0.01})),
    {model_key: 'within-window-partial', display: 'Within Window Partial', org: 'test', input_usd_per_mtok: nearInput, output_usd_per_mtok: 10, cache_read_usd_per_mtok: null},
  ];
  const bg = makeBgApi(null, {pricing: {source: 'test', rows}});
  const usage = exact('m1', 0, 1_000_000);
  usage.usage.cacheReadTokens = 100_000;
  usage.usage.totalTokens = 1_100_000;
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 10.05}}},
    messageUsage: [usage],
  });
  const fp = await bg.priceFingerprintBlock([], {fullBank: true});
  assert.equal(fp.scope, 'full-bank');
  assert.equal(fp.hit.model_key, 'best-match');
  assert.equal(fp.exact_usage, true);
  assert.equal(fp.price_ranked_models, 9);
  assert.equal(fp.price_window_matches, 2);
  assert.deepEqual(Array.from(fp.price_window_hits, hit => hit.model_key), ['best-match', 'within-window-partial']);
  assert.equal(fp.separable, false, '第 9 名仍落在价格窗口，不能唯一定名');
  assert.match(fp.text, /贴合窗口内有 2 个模型/);
});

test('价格指纹（全库）：不给 fullBank 时空候选仍报 no-candidates（语义不混）', async () => {
  const bg = makeBgApi(bank([{id: 'grok-4.5-agent'}]));
  resetBg(bg, {official: {session: null, messages: {m1: {basePriceUsd: 0.012}}}, estimates: [est('m1')]});
  const fp = await bg.priceFingerprintBlock([]);
  assert.equal(fp.separable, false);
  assert.equal(fp.reason, 'no-candidates');
});

test('价格指纹（全库）：池子来自单价表，与指纹库无关（v2.19.6）', async () => {
  /* 指纹库为空也照样能全库裁决 —— 池子是整张单价表，不再依赖指纹库。 */
  const bg = makeBgApi(bank([]), {pricing: {source: 'live', rows: [
    {model_key: 'grok-4.5-agent', display: 'Grok 4.5', org: 'xai', input_usd_per_mtok: 6, output_usd_per_mtok: 6, cache_write_usd_per_mtok: 7.5, cache_read_usd_per_mtok: 0.6},
  ]}});
  resetBg(bg, {official: {session: null, messages: {m1: {basePriceUsd: 0.012}}}, estimates: [est('m1')]});
  const fp = await bg.priceFingerprintBlock([], {fullBank: true});
  assert.notEqual(fp.reason, 'no-candidates', '指纹库为空不再导致 no-candidates');
  assert.equal(fp.candidates, 1, '池子来自单价表（1 行）');
  assert.equal(fp.scope, 'full-bank');
});

/* ---------- v2.19.6：OpenRouter 公开价目补充（模型本体） ---------- */

test('mergeOpenRouterPrices：只加 Arena 没有的 key，Arena 优先不覆盖，非双正剔掉', () => {
  const doc = {rows: [{model_key: 'a', display: 'A', input_usd_per_mtok: 1, output_usd_per_mtok: 2}]};
  const prices = {source: 'https://openrouter.ai/api/v1/models', fetched_at: '2026-10-13', rows: [
    {model_key: 'a', display: 'A(OR)', input_usd_per_mtok: 99, output_usd_per_mtok: 99},
    {model_key: 'b/x', display: 'B', org: 'b', input_usd_per_mtok: 3, output_usd_per_mtok: 4, cache_read_usd_per_mtok: 0.5},
    {model_key: 'free/y', display: 'Free', input_usd_per_mtok: 0, output_usd_per_mtok: 0},
    {model_key: 'media/z', display: 'Media', input_usd_per_mtok: 0, output_usd_per_mtok: 5},
  ]};
  const merged = pricingMod.mergeOpenRouterPrices(doc, prices);
  assert.equal(merged.rows.length, 2, '只加 b/x（a 已有；free 与 media 不是双正，会污染整数反推）');
  assert.equal(merged.rows[0].input_usd_per_mtok, 1, '★ Arena 行绝不被 OpenRouter 覆盖');
  assert.equal(merged.rows[1].model_key, 'b/x');
  assert.equal(merged.rows[1].source, 'openrouter-public');
  assert.equal(merged.rows[1].cache_read_usd_per_mtok, 0.5);
  assert.equal(merged.openrouter_supplement.added, 1);
  assert.equal(doc.rows.length, 1, '不改动入参');
});

test('mergeOpenRouterPrices：补充表缺失/空表 → 原样返回', () => {
  const doc = {rows: [{model_key: 'a', display: 'A', input_usd_per_mtok: 1, output_usd_per_mtok: 2}]};
  assert.equal(pricingMod.mergeOpenRouterPrices(doc, null), doc);
  assert.equal(pricingMod.mergeOpenRouterPrices(doc, {rows: []}), doc);
  assert.equal(pricingMod.mergeOpenRouterPrices(doc, {rows: [{model_key: 'a', input_usd_per_mtok: 1, output_usd_per_mtok: 2}]}), doc, '无新增时原样返回');
});

/* ---------- Battle 训练集实测费率补充 ---------- */

test('mergeBattleObservedPrices：Battle 实测覆盖同 key 官方主值，同时保留官方参考', () => {
  const doc = {rows: [{model_key: 'official-a', display: 'A', input_usd_per_mtok: 1, output_usd_per_mtok: 2}]};
  const observed = {
    schema: 'arena-battle-price-rates-v1', source: 'training', generated_at: '2026-10-15', rows: [
      {model_key: 'official-a', input_usd_per_mtok: 99, output_usd_per_mtok: 99, confidence: 'unanimous-positive-rates'},
      {model_key: 'observed-b', input_usd_per_mtok: 3, output_usd_per_mtok: 4, cache_read_usd_per_mtok: 0.3, confidence: 'unanimous-positive-rates', observed_samples: {messages: 3}},
      {model_key: 'missing-c', input_usd_per_mtok: 3, output_usd_per_mtok: null, confidence: 'unanimous-positive-rates'},
      {model_key: 'conflicted-d', input_usd_per_mtok: 3, output_usd_per_mtok: 4, confidence: 'conflicted'},
    ],
  };
  const merged = pricingMod.mergeBattleObservedPrices(doc, observed);
  assert.equal(merged.rows.length, 2, '只新增稳定且 input/output 双正的 observed-b');
  assert.equal(merged.rows[0].input_usd_per_mtok, 99, '★ 同 key 时 Battle 实测是主值');
  assert.equal(merged.rows[0].arena_official_reference.input_usd_per_mtok, 1, '官方价保留为辅助参考');
  assert.equal(merged.rows[1].model_key, 'observed-b');
  assert.equal(merged.rows[1].source, 'arena-battle-observed');
  assert.equal(merged.rows[1].observed_samples.messages, 3);
  assert.equal(merged.battle_observed_supplement.added, 1);
  assert.equal(merged.battle_observed_supplement.overridden, 1);
  assert.equal(merged.battle_observed_supplement.applied, 2);
  assert.equal(doc.rows.length, 1, '不改动入参');
});

test('价格指纹：训练集稳定实测模型进入 Arena 候选池并披露来源', async () => {
  const bg = makeBgApi(null, {
    pricing: {source: 'live', rows: [
      {model_key: 'observed-only', display: 'Observed Only', input_usd_per_mtok: 20, output_usd_per_mtok: 40},
    ]},
    battleRates: {
      schema: 'arena-battle-price-rates-v1', source: 'training', generated_at: '2026-10-15', rows: [
        {model_key: 'observed-only', display: 'Observed Only', input_usd_per_mtok: 2, output_usd_per_mtok: 5,
          cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null, confidence: 'unanimous-positive-rates',
          observed_samples: {messages: 4, input: 4, output: 4, cache_read: 0, cache_write: 0}},
      ],
    },
  });
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.007}}},
    messageUsage: [exact('m1', 1000, 1000)],
  });
  const fp = await bg.priceFingerprintBlock(['observed-only']);
  assert.equal(fp.separable, true);
  assert.equal(fp.hit.model_key, 'observed-only');
  assert.equal(fp.hit.price_source, 'arena-battle-observed');
  assert.equal(fp.hit.observed_samples.messages, 4);
  assert.equal(fp.hit.official_reference_rates.input_usd_per_mtok, 20, '官方价仍作为辅助参考返回');
  assert.equal(fp.pricing_policy, 'battle-observed-then-arena-official-then-openrouter');
  assert.equal(fp.battle_observed_rates.overridden, 1);
});

test('价格指纹：费率组代表优先 Battle 实测，但仍保持不可唯一定名', async () => {
  const bill = {basePriceUsd: 0.014, actual: {
    inputTokensCostUsd: 0.004, outputTokensCostUsd: 0.01,
    cacheWriteTokensCostUsd: 0, cacheReadTokensCostUsd: 0, totalCostUsd: 0.014,
  }};
  const bg = makeBgApi(null, {
    pricing: {source: 'live', rows: [
      {model_key: 'official-first', display: 'Official First', input_usd_per_mtok: 2, output_usd_per_mtok: 5},
      {model_key: 'official-second', display: 'Official Second', input_usd_per_mtok: 2, output_usd_per_mtok: 5},
    ]},
    battleRates: {schema: 'arena-battle-price-rates-v1', source: 'training', rows: [
      {model_key: 'battle-second', display: 'Battle Second', input_usd_per_mtok: 4, output_usd_per_mtok: 10,
        cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null, confidence: 'unanimous-positive-rates',
        observed_samples: {messages: 4, input: 4, output: 4, cache_read: 0, cache_write: 0}},
    ]},
  });
  resetBg(bg, {official: {session: null, messages: {mZ: bill}}});
  const fp = await bg.priceFingerprintBlock([], {fullBank: true, costPayload: {messages: {mZ: bill}}});
  assert.equal(fp.separable, false, '仍有多个合法费率组，不能定名');
  assert.equal(fp.rate_family.models.length, 1, 'Battle 是独立费率组');
  assert.equal(fp.rate_family.members, 3, '其他两个官方候选仍保留，未假装唯一');
  assert.equal(fp.rate_family.groups, 2);
  assert.equal(fp.rate_family.models[0].model_key, 'battle-second', '★ Battle 组即使人数更少也优先展示');
  assert.equal(fp.rate_family.models[0].price_source, 'arena-battle-observed');
  assert.equal(fp.rate_family.price_source, 'arena-battle-observed');
  assert.equal(fp.hard_filter.candidates[0].model_key, 'battle-second', '硬筛选并列列表也按来源优先级');
  assert.match(fp.text, /Battle 实测优先旁证/);
  assert.match(fp.text, /不能唯一定名/);
});

/* ★ 真机回归（2026-10-13）：用户截图那条账单 —— 参考扩展 cost-browser-extension 报
   `deepseek/deepseek-v4-flash-vision-exp`（条件推算 输出 20 / 缓存读 8192，上游成本 $0.00006913312）。
   该模型**既不在 Arena 榜单（208 行）也不在指纹库（21 个）**里，所以此前我们只能报「不能唯一定名」。
   v2.19.6 补上 OpenRouter 公开价目（模型本体）后必须能反推出同一个答案。 */
test('价格指纹（全库）：补 OpenRouter 价目后能反推出 deepseek-v4-flash-vision-exp（真机回归）', async () => {
  const bg = makeBgApi(null, {openRouter: 'real', cacheRates: 'real'});
  /* 账单取精确值：20 tok × $0.6468/Mtok 与 8192 tok × $0.00686/Mtok
     —— 合计 $0.00006913312，正是参考扩展显示的「上游成本」。 */
  const outUsd = (20 * 0.6468) / 1e6;
  const readUsd = (8192 * 0.00686) / 1e6;
  resetBg(bg, {
    official: {session: null, messages: {m1: {
      basePriceUsd: outUsd + readUsd,
      actual: {
        inputTokensCostUsd: 0, outputTokensCostUsd: outUsd, cacheWriteTokensCostUsd: 0,
        cacheReadTokensCostUsd: readUsd, totalCostUsd: outUsd + readUsd, isFallback: false,
      },
    }}},
    estimates: [est('m1', 20, 0)],
  });
  const fp = await bg.priceFingerprintBlock([], {fullBank: true});
  assert.ok(fp.hard_filter, '硬筛选腿应跑起来');
  assert.equal(fp.hard_filter.state, 'unique', '整张单价表里只有它费率结构吻合');
  assert.equal(fp.hard_filter.candidates[0].model_key, 'deepseek/deepseek-v4-flash-vision-exp');
  assert.deepEqual(fp.hard_filter.candidates[0].counts, {I: 0, O: 20, W: 0, R: 8192}, '反推 token 数与参考扩展逐项一致');
  assert.ok(fp.hard_filter.checked_models >= 500, `池子应是整张单价表（实测 ${fp.hard_filter.checked_models}）`);
});

/* ★ 真机回归（2026-10-13 第三轮）：用户截图里两条腿给了**互相矛盾**的答案 ——
   比值腿说 `claude-opus-4-1-...`（out $75/Mtok），费率腿说 Claude Haiku 5.5 / GPT Luna（out $0.5/Mtok），
   差 150 倍；参考扩展支持后者。用户拍板「以费率结构为准」。
   本组钉住：① 软判据的命中不在费率族里 → 判为**分歧**、绝不定名；② 软判据切不开时报到**费率族**这一级。 */
const FAMILY_ROWS = [
  {model_key: 'claude-haiku-x', display: 'Claude Haiku X', org: 'anthropic', input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, cache_write_usd_per_mtok: 0.125, cache_read_usd_per_mtok: 0.01},
  {model_key: 'gpt-luna-x', display: 'GPT Luna X', org: 'openai', input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, cache_write_usd_per_mtok: 0.125, cache_read_usd_per_mtok: 0.01},
  {model_key: 'claude-opus-x', display: 'Claude Opus X', org: 'anthropic', input_usd_per_mtok: 15, output_usd_per_mtok: 75, cache_write_usd_per_mtok: 18.75, cache_read_usd_per_mtok: 1.5},
];
/* 账单按**便宜族**的费率构造：输出 5 tok + 缓存读 6647 tok → $2.5e-6 + $6.647e-5 = $6.897e-5。 */
const familyBill = () => billFor(
  {input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, cache_write_usd_per_mtok: 0.125, cache_read_usd_per_mtok: 0.01},
  {I: 0, O: 5, W: 0, R: 6647},
);

test('价格指纹：软判据命中不在费率族里 → 判为分歧、绝不定名（v2.19.7 真机回归）', async () => {
  const bg = makeBgApi(null, {pricing: {source: 'live', rows: FAMILY_ROWS}});
  /* 1 个精确 output token：opus（$75/Mtok）期望 $7.5e-5，与账单 $6.897e-5 比值 0.9196 → 落在 ±10% 窗口；
     两个便宜模型期望 $5e-7 → 比值 137.9，远在窗外。故精确软判据唯一命中 opus；138-token 的冲突估算会落在便宜族，必须被 exact usage 压过。 */
  resetBg(bg, {
    official: {session: null, messages: {m2: familyBill()}},
    estimates: [est('m2', 138, 0)],
    messageUsage: [exact('m2', 1)],
  });
  const fp = await bg.priceFingerprintBlock(['claude-haiku-x', 'gpt-luna-x', 'claude-opus-x'], {costPayload: {messages: {m2: familyBill()}}});
  assert.equal(fp.hard_filter.state, 'multiple', '两个便宜模型费率相同 → 都能整除');
  assert.equal(fp.evidence, 'conflict', '★ 软判据指向族外 → 分歧');
  assert.equal(fp.separable, false, '★ 分歧一律不定名');
  assert.equal(fp.reason, 'conflict');
  assert.match(fp.text, /分歧/);
  assert.match(fp.note, /与费率结构冲突，已忽略/);
  assert.equal(fp.rate_family.models.length, 2, '费率族两个成员');
});

test('价格指纹：软判据切不开时报到费率族（v2.19.7）', async () => {
  const bg = makeBgApi(null, {pricing: {source: 'live', rows: FAMILY_ROWS}});
  /* 138 个估算 token → 两个便宜模型期望都是 $6.9e-5、比值≈1，但**两个都落进窗口** → 切不开；
     opus 期望 $0.01035 → 比值 0.0067，远在窗外。 */
  resetBg(bg, {
    official: {session: null, messages: {m2: familyBill()}},
    estimates: [est('m2', 138, 0)],
  });
  const fp = await bg.priceFingerprintBlock(['claude-haiku-x', 'gpt-luna-x', 'claude-opus-x'], {costPayload: {messages: {m2: familyBill()}}});
  assert.equal(fp.evidence, 'rate-family');
  assert.equal(fp.separable, false, '费率族 ≠ 定名');
  assert.equal(fp.rate_family.models.length, 2);
  assert.match(fp.text, /费率结构指向/);
  assert.match(fp.text, /2 个模型费率完全相同/);
  assert.match(fp.text, /Claude Haiku X/);
});

/* ★ 真机回归（2026-10-13 第四轮）：用户反馈「直接不显示了呢」——
   那次账单与转录估算**没配上对**（官方账单 2 条 / 估算 3 条，两侧都落单），
   此前 `costReverseBlock` 返回 blocked 就整条 return，面板只剩一句「没法配对」、候选列表全空。
   但硬筛选腿**只依赖账单的分项费用**，跟配对无关 —— 所以配对失败也必须把费率族报出来。 */
test('价格指纹：账单/估算没配上对时，仍要报出费率族（v2.19.8 真机回归）', async () => {
  const bg = makeBgApi(null, {pricing: {source: 'live', rows: FAMILY_ROWS}});
  /* 账单消息 id 与估算消息 id 完全不重叠 → pairCostWithEstimates 配不上对。 */
  resetBg(bg, {
    official: {session: null, messages: {mZ: familyBill()}},
    estimates: [est('mQ', 10, 0)],
  });
  const fp = await bg.priceFingerprintBlock(['claude-haiku-x', 'gpt-luna-x', 'claude-opus-x'], {costPayload: {messages: {mZ: familyBill()}}});
  assert.equal(fp.reason, 'no-pairs', '确实没配上对');
  assert.ok(fp.hard_filter, '★ 配对失败也要跑硬筛选');
  assert.equal(fp.hard_filter.state, 'multiple');
  assert.equal(fp.evidence, 'rate-family', '★ 报到费率族，而不是什么都不显示');
  assert.ok(fp.rate_family && fp.rate_family.models.length === 2, '费率族两个成员');
  assert.match(fp.text, /费率结构指向/, '头行给出费率结构结论');
  assert.match(fp.text, /本次未参与/, '并说明比值判据本次没参与');
  assert.match(fp.note, /本次跑不了/);
});

/* ★ 真机回归（2026-10-13）：花费明细表的「合计」列此前优先取 `row.base_usd`（**Arena 基础价**），
   跟左边四列（**上游 actual 分项费用**）不是同一口径 —— 截图里出现「合计 $0.005981 却远小于四项之和
   $0.073684」。一列叫「合计」却不等于同排四项之和，本身就是错的。 */
test('content.js：花费明细表的「合计」列必须等于同排四项之和（源码级）', () => {
  const content = read('content.js');
  assert.match(content, /const totalText=costCell\(lineTotal\);/, '合计用四项之和');
  assert.match(content, /sum\.total\+=lineTotal;/, '合计行也累加四项之和');
  assert.ok(!/costCell\(row\.base_usd!==null&&row\.base_usd!==undefined\?row\.base_usd:lineTotal\)/.test(content), '不得再用 base_usd 当合计');
});

/* ★ 真机回归（2026-10-13 第五轮）：面板渲染的其实是账本的 `cost_reverse`（`state.price_fingerprint`
   为空时 `view = cr`），而 `costReverseBlock` 同样在 no-pairs 时整条返回 —— 面板只剩一句「没法配对」，
   用户反馈「还是获取不到模型」。现在它也带上费率族。 */
test('costReverseBlock：没配上对时也带上费率族（v2.19.9 真机回归）', async () => {
  const bg = makeBgApi(null, {pricing: {source: 'live', rows: FAMILY_ROWS}});
  resetBg(bg, {
    official: {session: null, messages: {mZ: familyBill()}},
    estimates: [est('mQ', 10, 0)],
  });
  const blk = await bg.costReverseBlock({costPayload: {messages: {mZ: familyBill()}}});
  assert.equal(blk.blocked, 'no-pairs', '确实没配上对');
  assert.ok(blk.rate_family, '★ blocked 时也必须带费率族');
  assert.equal(blk.rate_family.models.length, 2);
  assert.equal(blk.evidence, 'rate-family');
  assert.equal(blk.hard_filter.state, 'multiple');
  assert.match(blk.text, /费率结构指向/);
});

test('background.js：全库池子接入 Battle 实测价 + 依赖闭包含两张补充表（源码级）', () => {
  const bgSrc = read('background.js');
  assert.match(bgSrc, /ids = table\.all\(\)\.filter\(profile => profile\.kind !== 'media'\)\.map\(profile => profile\.model_key\);/, '全库池子来自整张单价表');
  assert.match(bgSrc, /const BATTLE_PRICE_RATES_FILE = 'arena-battle-price-rates\.json';/, 'Battle 实测费率文件名常量');
  assert.match(bgSrc, /void chrome\.runtime\.getURL\('arena-battle-price-rates\.json'\);/, '★ Battle 实测费率打包闭包锚点');
  assert.match(bgSrc, /const OPENROUTER_PRICES_FILE = 'openrouter-prices\.json';/, '补充表文件名常量');
  assert.match(bgSrc, /void chrome\.runtime\.getURL\('openrouter-prices\.json'\);/, '★ 打包闭包锚点（变量文件名扫不到）');
  assert.match(bgSrc, /mergeBattleObservedPrices\(rawDoc, battleRates\)/, '先合并 Battle 实测费率');
  assert.match(bgSrc, /mergeOpenRouterPrices\(observed, prices\)/, '再用 OpenRouter 兜底');
});

test('价格指纹（全库）：第二名拉不开距离 → 降级（全库更容易撞价，判据必须守住）', async () => {
  const bg = makeBgApi(bank([{id: 'gpt-5.1'}, {id: 'grok-4.5'}]));
  /* gpt-5.1 出价 5/Mtok、grok-4.5 出价 6/Mtok：隐含 $5/Mtok 时两者 z 差 < 0.35。 */
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.02}}},
    estimates: [est('m1', 4000, 0)],
  });
  const fp = await bg.priceFingerprintBlock([], {fullBank: true});
  assert.equal(fp.separable, false);
  assert.equal(fp.reason, 'not-separable');
  assert.match(fp.text, /拉不开距离/);
});

/* ---------- content.js 侧：独立价格模式 ---------- */

test('content.js：识别模式含 price，且 sanitize 接受 price', () => {
  const content = read('content.js');
  assert.match(content, /\[\['price','价格指纹'\],\['quick','数字指纹'\]/, '下拉含价格指纹模式');
  assert.match(content, /const mode=\['price','quick','combined'\]\.includes\(value\?\.mode\)\?value\.mode:/, 'sanitize 接受 price');
  assert.match(content, /const priceMode=prefs\.mode==='price';/, '抽卡有价格模式分支');
  assert.match(content, /if\(priceMode\)break;/, '价格模式只发 1 题');
});

test('content.js：价格模式走全库裁决，冲突拒绝候选且弱结论只作建议、不作标签', () => {
  const content = read('content.js');
  assert.match(content, /type:'AMP_PRICE_FULL'/, '价格模式请后台做全库裁决');
  assert.match(content, /if\(mode==='price'\|\|!numeric\)\{\s*const pm=await priceModeFor\(active\);/, '价格模式独立调用全库裁决');
  assert.match(content, /if\(conflicted&&!prefs\.forceBest\)return null;/, '默认模式下冲突仍不返回定名候选');
  assert.match(content, /note:fp\.separable\?'价格唯一定名':'估算比值最接近（非确定识别）'/, '弱估算候选明确标为非确定识别');
  assert.match(content, /if\(pm\?\.fingerprint&&pm\.fingerprint\.separable!==true&&!pm\.fingerprint\.forced_best\)\{/, '默认模式下非唯一价格结论不回传为识别标签');
  assert.match(content, /kind:'price-inconclusive'/, '弱价格结果仅保留为不确定状态');
  assert.match(content, /label:fp\.separable===true&&fp\.hit\?/, '价格模式只有 separable 才提供模型标签');
  assert.match(content, /view\?\.price_window_hits/, '价格卡展示完整贴合窗口候选');
  assert.match(content, /observed_usd:fp\.observed_usd/, '旁证回退保留观察账单金额');
  assert.match(content, /hit:best,runner_up:runner/, '旁证回退保留前两名费率明细');
  assert.match(content, /if\(choice\?\.label&&active&&prefs\.renameAnyway&&!cancelled\)/, '改名仍需用户显式开启');
});

test('content.js：价格探针结束后等待逐条账单就绪，不把首次空账单直接报成无候选', () => {
  const content = read('content.js');
  assert.match(content, /const COST_READY_ATTEMPTS=6,COST_READY_DELAY_MS=900;/, '账单就绪重试有明确上限');
  assert.match(content, /records\.get\(active\)\?\.priceProbe\?\.completedAt/, '只对刚完成的价格探针启用短时重试');
  assert.match(content, /await sleep\(COST_READY_DELAY_MS\)/, '重试间隔不会忙轮询');
  assert.match(content, /账单尚未就绪；正在重试/, '等待过程对用户可见');
  assert.match(content, /messages 为空/, '最终失败保留可诊断原因');
});

test('content.js：只取最接近是默认关闭的显式 opt-in，强制结果仍披露原证据歧义', () => {
  const content = read('content.js');
  assert.match(content, /renameAnyway:false,forceBest:false/, '强制单选默认关闭');
  assert.match(content, /forceBest:value\?\.forceBest===true/, '仅显式 true 才开启');
  assert.match(content, /savePrefs\(\{forceBest:!!drawForceBest\.checked\}\)/, '设置可持久化');
  assert.match(content, /按 Battle 实测 > Arena 官方 > OpenRouter 与当前\$\{channel\}贴合排序/, '强制选择沿用来源优先和当前贴合排序');
  assert.match(content, /fp\.forced_best=true/, '强制结果有独立标记，不伪造自然唯一');
  assert.match(content, /原始证据仍有歧义/, '界面披露原证据歧义');
  assert.match(content, /renderPriceCandidates\(view,separable\)/, '强制单选只改顶部名称，不隐藏下方原有候选证据');
  assert.match(content, /下方候选与证据照常保留/, '强制单选的展示边界写清楚');
  assert.match(content, /if\(choice\?\.label&&active&&prefs\.renameAnyway&&!cancelled\)/, '实际改名仍由原改名开关独立控制');
});

test('content.js：数字模式尊重统计置信门，不用价格目录替换最近模型', () => {
  const content = read('content.js');
  assert.match(content, /if\(mode==='combined'&&raw\.length\)\{/, '只有组合模式用价格目录筛选候选');
  assert.match(content, /const numericOnly=mode!=='price'&&mode!=='combined';/, '数字独立模式与价格/组合模式分开');
  assert.match(content, /const nearest=result\?\.nearest;/, '数字独立模式使用统计引擎的原始最近模型');
  assert.match(content, /const confident=result\?\.status==='clear'&&decision\?\.set_size===1&&!decision\?\.off_reference;/, '单模型标签要求 clear、单候选、非混合/漂移');
  assert.match(content, /return prefs\.renameAnyway\?candidate:null;/, '弱结论只有用户显式开启时才可作为改名候选');
  assert.match(content, /record\.recognition=numericOnly\?null:/, '数字模式不以最近候选覆盖 clear/close/weak 判决');
  assert.match(content, /keepClassifierVerdict=numericOnly&&!choice;/, '弱数字结果回显原统计判决');
});

test('content.js：价格不唯一时折叠摘要不突出单一候选名', () => {
  const content = read('content.js');
  assert.match(content, /组合候选（启发式，非确定）/);
  assert.match(content, /价格唯一 · \$\{suggestion\.label\}/);
  assert.match(content, /价格未定 · \$\{count\} 个候选/);
  assert.match(content, /价格未定 · 候选见详情/);
});

test('content.js：披露数字指纹库对 Gemini 的版本覆盖限制', () => {
  const content = read('content.js');
  assert.match(content, /ModelTrace d4131b3/);
  assert.match(content, /离线库仅 GPT\/Claude，不含 Gemini/);
  assert.match(content, /WhatsMyLLM v2026\.09\.5/);
  assert.match(content, /指纹库只含 Gemini 3\.8 Flash 参考，其他 Gemini 版本未覆盖/);
});

test('content.js：单次识别的价格按钮与 run(price) 分支存在', () => {
  const content = read('content.js');
  assert.match(content, /runPriceButton=el\('button','all','价格识别 · 1题按价'\)/, '价格识别按钮');
  assert.match(content, /runPriceButton\.addEventListener\('click',\(\)=>void run\('price'\)\)/, '按钮触发 run(price)');
  assert.match(content, /const priceMode=mode==='price',combinedMode=mode==='combined';/, 'run() 识别 price 模式');
});

test('background.js：AMP_PRICE_FULL handler 存在且来源校验与 AMP_COST_REVERSE 同源', () => {
  const bg = read('background.js');
  assert.match(bg, /message\?\.type === 'AMP_PRICE_FULL'/, 'handler 存在');
  assert.match(bg, /priceFingerprintBlock\(\[\], \{costPayload, fullBank: true\}\)/, '走 fullBank 全库');
  assert.match(bg, /价格指纹请求来源无效/, '有来源校验');
});

/* ---------- v2.18.0 浮层高度约束（截图暴露的真问题：内容多时浮层无限长，顶出屏幕）----------
   参考扩展的做法：容器 flex 列 + max-height，内容区独立滚动，头尾固定。
   这里做源码级断言，防止以后改样式时把 max-height 或 body 滚动改回去。 */

test('content.js：浮层容器有 max-height 与 flex 列布局（防内容撑高）', () => {
  const content = read('content.js');
  /* .box 必须有高度上限 + flex 列，否则内容多时浮层会一直长出去。 */
  assert.match(content, /\.box\{[^}]*max-height:min\(84vh,760px\)/, '.box 必须有 max-height');
  assert.match(content, /\.box\{[^}]*display:flex;flex-direction:column/, '.box 必须是 flex 列');
  /* 头尾固定不滚，内容区独立滚动（min-height:0 是 flex 子项正确收缩的前提）。 */
  assert.match(content, /\.head\{flex:none;/, '.head 固定不滚');
  assert.match(content, /\.compact\{flex:none;/, '.compact 固定不滚');
  assert.match(content, /\.body\{flex:1 1 auto;min-height:0;overflow-y:auto/, '.body 独立滚动且有 min-height:0');
});

/* ---------- v2.19.0 缓存费率补充 + 四项整数反推硬筛选 + 交叉验证 ----------
   借鉴参考扩展 cost-browser-extension 的 constrainByPrices：把 /cost 账单的**四项分项费用**
   （input/output/cacheWrite/cacheRead）按各模型单价反推 token 数，要求正整数 —— 能整除才留。

   实测结论（dev-scratch/_verify-constraint-strength.mjs）：整除是**真实约束**（把 read 费用随机
   扰动 ±20% 跑 200 次 → 候选恒为 0），但**极度脆弱**（费用稍有偏差就全灭，且费率口径一旦不符就误判）。
   因此本组测试盯住两件事：
     ① 硬筛选自身五态语义（unique / multiple / none / partial-only / missing-cost / off-integer-grid）；
     ② 硬筛选**只能当旁证**：与软判据分歧时必须 separable:false（宁可不定名也不猜）。 */

/* 合成一份最小单价表：三个文本模型，cache 费率先留空（模拟 Arena 榜单的 null），
   再由 applyCacheRates 从「补充表」补进来。 */
function tinyTable() {
  return {
    schema: 'arena-model-pricing',
    rows: [
      {model_key: 'alpha-pro', display: 'Alpha Pro', org: 'alpha', input_usd_per_mtok: 1, output_usd_per_mtok: 4, cache_write_usd_per_mtok: null, cache_read_usd_per_mtok: null},
      {model_key: 'beta-lite', display: 'Beta Lite', org: 'beta', input_usd_per_mtok: 2, output_usd_per_mtok: 8, cache_write_usd_per_mtok: null, cache_read_usd_per_mtok: null},
      {model_key: 'gamma-media', display: 'Gamma Image', org: 'gamma', input_usd_per_mtok: 0, output_usd_per_mtok: 30, kind: 'media'},
    ],
  };
}

test('applyCacheRates：只补不覆盖（官方优先），并标注来源与 :batch', () => {
  const table = pricingMod.normalizePricingTable(tinyTable());
  /* 官方已给 alpha 的 cacheRead=0.1 —— 补充表给了不同值，也不许覆盖。 */
  table.profile('alpha-pro').cache_read_usd_per_mtok = 0.1;
  const doc = {
    schema: 'arena-cache-rates',
    source: 'https://openrouter.ai/api/v1/models',
    fetched_at: '2026-10-13',
    caveat: '非官方口径',
    rates: {
      'alpha-pro': {cache_read_usd_per_mtok: 0.2, cache_write_usd_per_mtok: 5, or_id: 'alpha/pro', consistent: true, batch: false},
      'beta-lite': {cache_read_usd_per_mtok: 0.4, cache_write_usd_per_mtok: 10, or_id: 'beta/lite', consistent: true, batch: true},
      'gamma-media': {cache_read_usd_per_mtok: 9, cache_write_usd_per_mtok: 9, or_id: 'gamma/img'},   // 媒体模型必须被跳过
      'nonexistent': {cache_read_usd_per_mtok: 9, cache_write_usd_per_mtok: 9},
    },
  };
  const out = pricingMod.applyCacheRates(table, doc);
  assert.equal(out, table, '原地返回同一张表');
  assert.equal(table.profile('alpha-pro').cache_read_usd_per_mtok, 0.1, '官方已有值不被覆盖');
  assert.equal(table.profile('alpha-pro').cache_write_usd_per_mtok, 5, '官方缺失的那一项才补');
  assert.equal(table.profile('beta-lite').cache_read_usd_per_mtok, 0.4, 'null 项被补上');
  assert.equal(table.profile('beta-lite').cache_rate_source, 'openrouter-public', '标注来源');
  assert.equal(table.profile('beta-lite').cache_rate_batch, true, ':batch 条目被标注');
  assert.equal(table.profile('alpha-pro').cache_rate_batch, false, '非 batch 不误标');
  assert.equal(table.profile('gamma-media').cache_read_usd_per_mtok, null, '媒体模型跳过（按张计价不参与反推）');
  assert.equal(table.profile('nonexistent'), null, '表里没有的 key 直接忽略');
  assert.equal(table.cache_rates.applied, 2, '只统计真正补上的条数（alpha + beta）');
  assert.equal(table.cache_rates.source, 'https://openrouter.ai/api/v1/models', '披露来源');
});

test('baseModelName：剥 harness/effort 后缀与日期戳，剥完为空则退回原名', () => {
  assert.equal(pricingMod.baseModelName('qwen3.7-plus-agent'), 'qwen3.7-plus');
  assert.equal(pricingMod.baseModelName('claude-opus-4-7-thinking-webdev'), 'claude-opus-4-7');
  assert.equal(pricingMod.baseModelName('gpt-5.1-max'), 'gpt-5.1');
  assert.equal(pricingMod.baseModelName('model-x-20260910'), 'model-x');
  assert.equal(pricingMod.baseModelName('Alpha-Pro'), 'alpha-pro', '统一小写');
  assert.equal(pricingMod.baseModelName('agent'), 'agent', '全剥空 → 退回原 key，绝不出空串');
  assert.equal(pricingMod.baseModelName(''), '');
});

/* 合成一份「能整除」的账单：四项费用都由整数 token × 单价算出来，保证 raw 精确整除。
   注意 basePriceUsd 必须挂在顶层 —— pairCostWithEstimates 读 `entry.basePriceUsd ?? entry.actual.basePriceUsd`，
   软判据那条腿靠它配对，缺了会直接 blocked:'no-pairs'，硬筛选腿也就无从比对。 */
function billFor(profile, {I, O, W, R}) {
  const usd = (n, rate) => (rate === null ? 0 : (n * rate) / 1e6);
  const input = usd(I, profile.input_usd_per_mtok);
  const output = usd(O, profile.output_usd_per_mtok);
  const write = usd(W, profile.cache_write_usd_per_mtok);
  const read = usd(R, profile.cache_read_usd_per_mtok);
  const total = input + output + write + read;
  return {
    basePriceUsd: total,
    actual: {
      inputTokensCostUsd: input,
      outputTokensCostUsd: output,
      cacheWriteTokensCostUsd: write,
      cacheReadTokensCostUsd: read,
      totalCostUsd: total,
      isFallback: false,
    },
    pricingStrategy: 'agent_p50',
  };
}

test('normalizeCostBreakdown：四项分项 + 自洽校验（和不等于总额 → total_consistent=false）', () => {
  const ok = pricingMod.normalizeCostBreakdown({actual: {inputTokensCostUsd: 0.001, outputTokensCostUsd: 0.002, cacheWriteTokensCostUsd: 0, cacheReadTokensCostUsd: 0, totalCostUsd: 0.003}});
  assert.equal(ok.input_usd, 0.001);
  assert.equal(ok.output_usd, 0.002);
  assert.equal(ok.total_consistent, true);
  assert.equal(ok.any_cache, false);
  /* 四项之和 0.003 ≠ total 0.02 → 这份账单不可信。 */
  const bad = pricingMod.normalizeCostBreakdown({actual: {inputTokensCostUsd: 0.001, outputTokensCostUsd: 0.002, cacheWriteTokensCostUsd: 0, cacheReadTokensCostUsd: 0, totalCostUsd: 0.02}});
  assert.equal(bad.total_consistent, false);
  assert.equal(pricingMod.normalizeCostBreakdown({}), null, '没有任何分项 → null');
  assert.equal(pricingMod.normalizeCostBreakdown({actual: {inputTokensCostUsd: 0.001, outputTokensCostUsd: 0.002, cacheWriteTokensCostUsd: 0, cacheReadTokensCostUsd: 0, totalCostUsd: 0.003, isFallback: true}}).is_fallback, true);
  const media = pricingMod.normalizeCostBreakdown({actual: {imageGenerationCostUsd: 0.02, totalCostUsd: 0.02}});
  assert.equal(media.has_non_token_media_cost, true, '保留图像生成费用标记');
  assert.equal(pricingMod.hardFilterByCosts(media, pricingMod.normalizePricingTable(tinyTable())).state, 'non-token-media-cost');
});

test('priceFingerprintBlock：图像生成费用没有对应 modality usage 时 fail closed', async () => {
  const bg = makeBgApi();
  const costPayload = {session: null, messages: {m1: {basePriceUsd: 0.024, actual: {
    inputTokensCostUsd: 0.001, outputTokensCostUsd: 0.003, imageGenerationCostUsd: 0.02, totalCostUsd: 0.024,
  }}}};
  const fp = await bg.priceFingerprintBlock([], {fullBank: true, costPayload});
  assert.equal(fp.blocked, 'non-token-media-cost');
  assert.equal(fp.separable, false);
  assert.equal(fp.hit, undefined, '不能把图像费用折成 GPT 等纯 token 候选');
  assert.match(fp.text, /图像/);
});

test('hardFilterByCosts：能整除的模型才留，unique 态给出唯一定名', () => {
  const table = pricingMod.normalizePricingTable(tinyTable());
  pricingMod.applyCacheRates(table, {schema: 'arena-cache-rates', rates: {
    'alpha-pro': {cache_read_usd_per_mtok: 0.1, cache_write_usd_per_mtok: 1.25},
    'beta-lite': {cache_read_usd_per_mtok: 0.5, cache_write_usd_per_mtok: 2.5},
  }});
  /* 构造一份只有 alpha 能整除的账单：alpha 的费率是 (1,4,1.25,0.1)。
     关键点：beta 的费率恰好是 alpha 的 (2,2,2,5) 倍，所以**必须**让至少一项在 beta 下除不尽。
     取 R=2001（奇数）→ alpha 下 2001 tok 整除；beta 下 cache_read 费率 0.5 → 2001/5=400.2 → 淘汰。 */
  const bill = pricingMod.normalizeCostBreakdown(billFor(table.profile('alpha-pro'), {I: 1000, O: 250, W: 800, R: 2001}));
  const res = pricingMod.hardFilterByCosts(bill, table);
  assert.equal(res.state, 'unique', '唯一解');
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].model_key, 'alpha-pro');
  assert.deepEqual(res.candidates[0].counts, {I: 1000, O: 250, W: 800, R: 2001}, '反推出的 token 数精确等于构造值');
  assert.equal(res.excluded_media, 1, '媒体模型被剔除并计数');
  assert.equal(res.checked_models, 3, '三个模型都检查过');
  assert.match(res.note, /唯一整数解/);
});

test('hardFilterByCosts：多个模型费率同构 → multiple（切不开，不得定名）', () => {
  const table = pricingMod.normalizePricingTable(tinyTable());
  /* 让两个模型四项费率完全一致 —— 账单必然同时整除两者。 */
  const a = table.profile('alpha-pro'), b = table.profile('beta-lite');
  b.input_usd_per_mtok = a.input_usd_per_mtok;
  b.output_usd_per_mtok = a.output_usd_per_mtok;
  pricingMod.applyCacheRates(table, {schema: 'arena-cache-rates', rates: {
    'alpha-pro': {cache_read_usd_per_mtok: 0.1, cache_write_usd_per_mtok: 1.25},
    'beta-lite': {cache_read_usd_per_mtok: 0.1, cache_write_usd_per_mtok: 1.25},
  }});
  const bill = pricingMod.normalizeCostBreakdown(billFor(a, {I: 1000, O: 250, W: 800, R: 2000}));
  const res = pricingMod.hardFilterByCosts(bill, table);
  assert.equal(res.state, 'multiple');
  assert.equal(res.candidates.length, 2);
  assert.equal(res.same_price_groups.some(g => g.ambiguous && g.ids.length === 2), true, '四项同价被归入同价组');
  assert.match(res.note, /都能整除/);
});

test('hardFilterByCosts：变体 key（同模型不同档）只算一个候选，不把唯一解误降为多解', () => {
  const base = tinyTable();
  base.rows.push({model_key: 'alpha-pro-agent', display: 'Alpha Pro (Agent)', org: 'alpha', input_usd_per_mtok: 1, output_usd_per_mtok: 4, cache_write_usd_per_mtok: null, cache_read_usd_per_mtok: null});
  const table = pricingMod.normalizePricingTable(base);
  pricingMod.applyCacheRates(table, {schema: 'arena-cache-rates', rates: {
    'alpha-pro': {cache_read_usd_per_mtok: 0.1, cache_write_usd_per_mtok: 1.25},
    'alpha-pro-agent': {cache_read_usd_per_mtok: 0.1, cache_write_usd_per_mtok: 1.25},
  }});
  const bill = pricingMod.normalizeCostBreakdown(billFor(table.profile('alpha-pro'), {I: 1000, O: 250, W: 800, R: 2000}));
  const res = pricingMod.hardFilterByCosts(bill, table);
  assert.equal(res.state, 'unique', '变体折叠后仍是唯一解');
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].base_name, 'alpha-pro');
});

test('hardFilterByCosts：凑不出整数 → none；缺 cache 费率 → partial-only', () => {
  const table = pricingMod.normalizePricingTable(tinyTable());
  /* 不补 cache 费率 + 账单里带 cache 费用 → cache 项无法反推，只能进 partial。 */
  const withCache = pricingMod.normalizeCostBreakdown({
    actual: {inputTokensCostUsd: 0.001, outputTokensCostUsd: 0.001, cacheWriteTokensCostUsd: 0.0005, cacheReadTokensCostUsd: 0, totalCostUsd: 0.0025},
  });
  const partial = pricingMod.hardFilterByCosts(withCache, table);
  assert.equal(partial.candidates.length, 0);
  assert.equal(partial.state, 'partial-only', '费率不全 → partial-only');
  assert.ok(partial.partial.length >= 2, '多个模型进待定');
  /* 一份「怎么都对不上」的账单：alpha 费率 (1,4)，beta 费率 (2,8) —— 两者都是 2 的整数倍关系，
     所以 input 能同时整除（x 与 x/2），但把 output 取成一个奇数偏移的值即可让两边都凑不出整数。
     这里用 alpha 的 input=1 单价构造 input = 0.000003（=3 tok，alpha 整除），
     output 取 0.0000005（alpha: 0.125 tok / beta: 0.0625 tok —— 两边都不是整数）。 */
  const table2 = pricingMod.normalizePricingTable(tinyTable());
  const weird = pricingMod.normalizeCostBreakdown({
    actual: {inputTokensCostUsd: 0.000003, outputTokensCostUsd: 0.0000005, cacheWriteTokensCostUsd: 0, cacheReadTokensCostUsd: 0, totalCostUsd: 0.0000035},
  });
  const none = pricingMod.hardFilterByCosts(weird, table2);
  assert.equal(none.state, 'none');
  assert.equal(none.candidates.length, 0);
});

test('hardFilterByCosts：账单分项不自洽 → off-integer-grid（拒绝反推）', () => {
  const table = pricingMod.normalizePricingTable(tinyTable());
  const bill = pricingMod.normalizeCostBreakdown({
    actual: {inputTokensCostUsd: 0.001, outputTokensCostUsd: 0.001, cacheWriteTokensCostUsd: 0, cacheReadTokensCostUsd: 0, totalCostUsd: 9},
  });
  assert.equal(bill.total_consistent, false);
  const res = pricingMod.hardFilterByCosts(bill, table);
  assert.equal(res.state, 'off-integer-grid');
  assert.match(res.note, /不自洽/);
});

test('hardFilterByCosts：估算费用 / 空账单 → missing-cost', () => {
  const table = pricingMod.normalizePricingTable(tinyTable());
  assert.equal(pricingMod.hardFilterByCosts(null, table).state, 'missing-cost');
  const fallback = pricingMod.normalizeCostBreakdown({actual: {inputTokensCostUsd: 0.001, outputTokensCostUsd: 0.001, cacheWriteTokensCostUsd: 0, cacheReadTokensCostUsd: 0, totalCostUsd: 0.002, isFallback: true}});
  assert.equal(pricingMod.hardFilterByCosts(fallback, table).state, 'missing-cost');
});

test('priceFingerprintBlock：硬筛选唯一解 + 软判据同指 → evidence=both 且 separable', async () => {
  const bg = makeBgApi(null, {pricing: {
    source: 'live',
    rows: [
      {model_key: 'alpha-pro', display: 'Alpha Pro', org: 'alpha', input_usd_per_mtok: 1, output_usd_per_mtok: 4, cache_write_usd_per_mtok: 1.25, cache_read_usd_per_mtok: 0.1},
      {model_key: 'beta-lite', display: 'Beta Lite', org: 'beta', input_usd_per_mtok: 20, output_usd_per_mtok: 80, cache_write_usd_per_mtok: 25, cache_read_usd_per_mtok: 2},
    ],
  }});
  /* 软判据：带 costPayload 时**以它为准**（只含 m2），所以配对数与 token 数都按 m2 算。
     账单（下面 costPayload 的 m2）总额 $0.0032001 ÷ 800t = $4/Mtok —— 正是 alpha 的 out 价，
     比值 1（落在 v2.19.5 的 ±10% 窗口内）；beta 的 out 价 $80 → 比值 0.05，远在窗口外。
     ★ 注意：v2.19.5 前这里写的是 1000t，得到比值 0.8（偏差 20%）—— 旧阈值（等效 1.18）放行，
     新窗口（±10%）正确拒绝。测试数据必须真的满足判据，否则测的是阈值不是交叉验证。 */
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.004}, m2: {basePriceUsd: 0.004}}},
    estimates: [est('m1', 1000, 0), est('m2', 90000, 0)],
    messageUsage: [exact('m2', 800)],
  });
  /* 硬筛选账单：按 alpha 费率构造，R=2001 让 beta（费率 2/2/2/5 倍）除不尽 → 唯一解。 */
  const costPayload = {messages: {m2: billFor({input_usd_per_mtok: 1, output_usd_per_mtok: 4, cache_write_usd_per_mtok: 1.25, cache_read_usd_per_mtok: 0.1}, {I: 1000, O: 250, W: 800, R: 2001})}};
  const fp = await bg.priceFingerprintBlock(['alpha-pro', 'beta-lite'], {costPayload});
  assert.equal(fp.evidence, 'both', '硬筛选与软判据同指 alpha');
  assert.equal(fp.separable, true, '两条独立证据一致 → 可定名');
  assert.equal(fp.reason, 'unique');
  assert.equal(fp.hard_filter.state, 'unique');
  assert.equal(fp.conflict, null);
  assert.match(fp.text, /硬筛选一致/);
});

test('priceFingerprintBlock：两条证据分歧 → evidence=conflict 且 separable:false（绝不凭硬筛选定名）', async () => {
  /* 造分歧要费率「互质」：软判据指向 alpha，硬筛选指向 beta。
     费率设计（关键：alpha 与 beta 的费率**不能成整数倍**，否则账单必然同时整除两者）：
       alpha: in 1,   out 4,   write 1.25, read 0.1
       beta : in 0.3, out 0.6, write 0.5,  read 0.05
     账单按 beta 费率构造，bills: I=1000,O=500,W=2000,R=20001。
       → beta 下：1000 * 0.3/1e6 等 —— 全部整除。
       → alpha 下：out 500×0.6=0.0003 美元 → /4 → 75 tok（整数！）
     所以还要让至少一项在 alpha 下非整数：取 out = 501（beta 0.6 → 0.0003006 美元，
     alpha 4 → 75.15 → 淘汰）。 */
  const bg = makeBgApi(null, {pricing: {
    source: 'live',
    rows: [
      {model_key: 'alpha-pro', display: 'Alpha Pro', org: 'alpha', input_usd_per_mtok: 1, output_usd_per_mtok: 4, cache_write_usd_per_mtok: 1.25, cache_read_usd_per_mtok: 0.1},
      {model_key: 'beta-lite', display: 'Beta Lite', org: 'beta', input_usd_per_mtok: 0.3, output_usd_per_mtok: 0.6, cache_write_usd_per_mtok: 0.5, cache_read_usd_per_mtok: 0.05},
    ],
  }});
  /* 软判据：带 costPayload 时以它为准（只含 m2）。账单（下面按 beta 费率构造的 m2）总额
     $0.00260065 ÷ 650t = $4.0005/Mtok —— 正好是 alpha 的 out 价，比值 1.00025（窗口内）；
     beta 的 out 价 $0.6 → 比值 6.67，拉得开 → 软判据唯一定名 alpha。
     ★ v2.19.5 前这里写 1000t（比值 0.65、偏差 35%），靠旧阈值的宽松才勉强算「贴合」。 */
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.004}, m2: {basePriceUsd: 0.004}}},
    estimates: [est('m1', 1000, 0), est('m2', 90000, 0)],
    messageUsage: [exact('m2', 650)],
  });
  /* 硬筛选账单按 beta 费率构造，各项取奇数/非常数 → alpha 除不尽。 */
  const costPayload = {messages: {m2: billFor({input_usd_per_mtok: 0.3, output_usd_per_mtok: 0.6, cache_write_usd_per_mtok: 0.5, cache_read_usd_per_mtok: 0.05}, {I: 1000, O: 501, W: 2000, R: 20001})}};
  const fp = await bg.priceFingerprintBlock(['alpha-pro', 'beta-lite'], {costPayload});
  assert.ok(fp.hard_filter, '硬筛选腿应跑起来');
  assert.equal(fp.hard_filter.state, 'unique', '账单只有 beta 能整除');
  assert.equal(fp.evidence, 'conflict', '硬筛选唯一解与软判据分歧');
  assert.equal(fp.separable, false, '★ 分歧时一律不定名');
  assert.equal(fp.reason, 'conflict');
  assert.ok(fp.conflict && fp.conflict.soft !== fp.conflict.hard, '如实记录两个分歧模型');
  assert.match(fp.note + fp.text, /分歧/);
});

test('priceFingerprintBlock：软判据切不开但硬筛选唯一 → evidence=hard-hint，仍不 separable', async () => {
  /* 要让软判据**必然**切不开，最稳的办法是造一个「同价等价类」：
     alpha / twin 两项单价完全相同 → ambiguousGroup 命中 → softSeparable=false（与比值无关）。
     同时让硬筛选只对 alpha 成立：twin 的 cache 费率设成 alpha 的奇数倍关系，
     使账单在 twin 下除不尽。这样硬筛选唯一解 = alpha，与软判据的第一名同指，
     但软判据本身切不开 → evidence='hard-hint'（只作旁证），separable=false。 */
  const bg = makeBgApi(null, {pricing: {
    source: 'live',
    rows: [
      {model_key: 'alpha-pro', display: 'Alpha Pro', org: 'alpha', input_usd_per_mtok: 1, output_usd_per_mtok: 4, cache_write_usd_per_mtok: 1.25, cache_read_usd_per_mtok: 0.1},
      {model_key: 'twin-pro', display: 'Twin Pro', org: 'alpha', input_usd_per_mtok: 1, output_usd_per_mtok: 4, cache_write_usd_per_mtok: 1.25, cache_read_usd_per_mtok: 0.3},
    ],
  }});
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.004}, m2: {basePriceUsd: 0.004}}},
    estimates: [est('m1', 1000, 0), est('m2', 1000, 0)],
  });
  /* R=2001：alpha 的 read 费率 0.1 → 20010 tok（整数）✓；twin 的 0.3 → 2001×0.1/0.3 = 667（整数！）
     取 R 使 twin 除不尽：需要 0.1×R / 0.3 非整数，即 R 不是 3 的倍数：R=2001 → 2001/3=667 整除 ✗
     换 R=2002 → alpha 下 20020（整数）✓；twin 下 2002/3 = 667.33 → 非整数 ✓ */
  const costPayload = {messages: {m2: billFor({input_usd_per_mtok: 1, output_usd_per_mtok: 4, cache_write_usd_per_mtok: 1.25, cache_read_usd_per_mtok: 0.1}, {I: 1000, O: 250, W: 800, R: 2002})}};
  const fp = await bg.priceFingerprintBlock(['alpha-pro', 'twin-pro'], {costPayload});
  assert.equal(fp.separable, false, '软判据被同价等价类卡死 → 不 separable');
  assert.equal(fp.hard_filter.state, 'unique', '账单只有 alpha 能整除');
  assert.equal(fp.evidence, 'hard-hint', '硬筛选唯一解只作旁证，不改判 separable');
});

test('priceFingerprintBlock：读不到 cache 补充表也能跑（价格通道不被补充表缺失拖垮）', async () => {
  const bg = makeBgApi(null);   // 不喂 cacheRates → loadCacheRates 走 fetch → ok:false
  resetBg(bg, {
    official: {session: null, messages: {m1: {basePriceUsd: 0.012}, m2: {basePriceUsd: 0.012}}},
    estimates: [est('m1'), est('m2')],
  });
  const fp = await bg.priceFingerprintBlock(['grok-4.5-agent']);
  assert.equal(fp.hard_filter, null, '没有分项账单 → 硬筛选腿为 null');
  assert.equal(fp.cache_rates, null, '补充表读不到 → 不披露来源');
  assert.ok('separable' in fp, '函数正常返回');
});

test('content.js：价格指纹披露含「硬筛选结果 / 分歧 / 单次调用口径未验证」', () => {
  const content = read('content.js');
  assert.match(content, /function priceFingerprintCaveat\(fp\)/, '披露函数存在');
  assert.match(content, /硬筛选：\$\{hard\.checked_models\} 个模型里只此一个能整除分项账单/, '硬筛选唯一解措辞');
  assert.match(content, /两条证据分歧：整数反推指向/, '分歧明示两个模型');
  assert.match(content, /硬筛选给出唯一解，但软判据未确认，仅作旁证/, 'hard-hint 措辞');
  assert.match(content, /:batch 半价条目/, 'batch 警告');
  assert.match(content, /汇总成本可能包含多次调用，单次调用口径未验证/, '★ 借鉴参考扩展 pricingTierStatus 的口径提示');
  assert.match(content, /缓存费率补自 OpenRouter 公开价目/, 'cache 费率来源披露');
});

test('cost-ledger.js：同价组升级为四项签名的措辞（输入/输出/缓存写/缓存读）', () => {
  const ledger = read('cost-ledger.js');
  assert.match(ledger, /cache_write_usd_per_mtok/, '同价组带缓存写费率');
  assert.match(ledger, /cache_read_usd_per_mtok/, '同价组带缓存读费率');
  const content = read('content.js');
  assert.match(content, /缓存写 \$\{/, '浮层同价提示用四项签名');
});

test('background.js：cache 补充表只补不覆盖 + 读不到不阻塞 + 依赖闭包含 arena-cache-rates.json', () => {
  const bg = read('background.js');
  assert.match(bg, /CACHE_RATES_FILE = 'arena-cache-rates\.json'/, '常量指向补充表');
  assert.match(bg, /doc\.schema !== 'arena-cache-rates'/, '校验 schema');
  assert.match(bg, /补充表缺失不能让整条价格通道瘫痪/, '读不到就退回原表');
  assert.match(bg, /async function hardFilterLeg\(/, '硬筛选腿存在');
  assert.match(bg, /hardBase === softBase/, '按基础名交叉比对');
  assert.match(bg, /separable = softSeparable && evidence !== 'conflict'/, '★ 分歧时 separable 必为 false');
  /* 打包闭包锚点：tools/package.mjs 只扫 getURL('字面量') —— 文件名若改成变量拼接就会漏文件
     （v2.9.25 的旧包就是这么炸的）。这里断言锚点存在，防止以后重构时把字面量挪走。 */
  assert.match(bg, /getURL\('arena-cache-rates\.json'\)/, '★ 依赖闭包锚点：字面量 getURL 必须在（否则打包漏文件）');
});

test('打包闭包：tools/package.mjs 能发现 cache 与 Battle 实测费率文件（新增数据文件不漏打）', async () => {
  const {execFileSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out = execFileSync(process.execPath, ['tools/package.mjs', '--check-only'], {cwd: root, encoding: 'utf8'});
  assert.match(out, /arena-cache-rates\.json/, '补充表在运行时依赖清单里');
  assert.match(out, /arena-battle-price-rates\.json/, 'Battle 实测费率表在运行时依赖清单里');
  assert.match(out, /✅ 依赖完整/, '依赖完整校验通过');
});

