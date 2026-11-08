import {identifyPrepared, prepareOutputs} from './model-probe-engine.js';
import {loadProbeBank} from './model-probe-bank.js';
import {analyzeLmfpdOutputs, loadLmfpdChannel, lmfpdSummary} from './lmfpd-channel.js';
import {createBalanceReader} from './billing.js';
import {countNumbers, parseNumbers} from './modeltrace-core.js';
import {queryRunTrace} from './model-trace.js';
import {rhythmProfile, rhythmVote, rhythmAccumulate} from './rhythm-channel.js';
import {normalizeCostTable, crossCheckCost, observedCostFromSignals, observedCostDetail, costDetailFromSession, describeCostDetail, chargedFromBase, TIER_LABEL} from './price-channel.js';
import {normalizePricingTable, applyCacheRates, mergeBattleObservedPrices, mergeOpenRouterPrices, pricingSummary, bankPricing, discrimination, rankByObservedCost, expectedCostUsd, hardFilterByCosts, normalizeCostBreakdown, baseModelName, canonicalModelSlug, pricingSourcePriority, CONSISTENT_RATIO, hasNonTokenMediaCost} from './pricing-channel.js';
import {parseUsage, usageShape, describeUsage, sumUsage, latestUsage, normalizeEstimateBucket, estimateUsageFromStats, USAGE_SCHEMA} from './usage-channel.js';
import {buildLedger, ledgerRowsFromCostMessages, ledgerRowsFromEstimates, ledgerTotals, pairCostWithUsage, LEDGER_SCHEMA, samePriceGroups, tokenRatioText, describeTotals, formatUsd} from './cost-ledger.js';
import './text-channel.js';
// Embedded manual reCAPTCHA audio assistance (GPL-3.0-only), separate from AMP routing.
import './buster/src/background/script.js';
import {registerRecaptchaAnchor} from './recaptcha-anchor-background.js';

registerRecaptchaAnchor();

const EXPECTED = [297, 315, 331];
/* v2.9.3 文本词频通道存储键（已知模型建档的第二条腿：BoW 词频参考库）。 */
const TEXT_BANK_KEY = 'amp.textbank.v1';
const NAMES = Object.freeze({
  'gpt-5.4':'GPT-5.4','gpt-5.5':'GPT-5.5','gpt-5.6-sol':'GPT-5.6 Sol','gpt-5.6-terra':'GPT-5.6 Terra','gpt-5.6-luna':'GPT-5.6 Luna','gpt-6-astra':'GPT-6 Astra','gpt-6-sol':'GPT-6 Sol','gpt-6-luna':'GPT-6 Luna',
  'claude-haiku-4-5-20251001':'Claude Haiku 4.5','claude-sonnet-4-6':'Claude Sonnet 4.6','claude-sonnet-5':'Claude Sonnet 5','claude-sonnet-5-5':'Claude Sonnet 5.5','claude-opus-4-6':'Claude Opus 4.6','claude-opus-4-7':'Claude Opus 4.7','claude-opus-4-8':'Claude Opus 4.8','claude-opus-5':'Claude Opus 5','claude-opus-5-5':'Claude Opus 5.5','claude-fable-5-1':'Claude Fable 5.1',
  'kimi-k2.6':'Kimi K2.6','gemini-3.8-flash':'Gemini 3.8 Flash','deepseek-v4-pro-0813':'DeepSeek V4 Pro 0813','qwen3.8-max-0902':'Qwen3.8 Max 0902',
});

// 每日额度：内存缓存至少 60 秒；Service Worker 被回收后缓存消失，下次读取会重新请求。
const balance = createBalanceReader({fetch: (...args) => fetch(...args)});

/* Arena 站点源：生产 arena.ai 与预发布 canary.arena.ai（同一产品；登录态/新功能常先在 canary）。 */
const ARENA_ORIGIN_RE = /^https:\/\/(?:canary\.)?arena\.ai$/;

function isAgentUrl(value) {
  try { const url = new URL(value); return ARENA_ORIGIN_RE.test(url.origin); } // 与 content.js agentPage() 一致：v2.9.15 起各模式（Battle/Code/Text 等）都会探测，不再限定 /agent、/work 路径
  catch { return false; }
}

function isExtensionPage(value) {
  return typeof value === 'string' && value.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function cleanOutputs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw Error('探针数量无效');
  const seen = new Set();
  return value.map(item => {
    const expected = Number(item?.expected_count);
    const probeIndex = EXPECTED.indexOf(expected);
    const challengeId = `plain-${probeIndex + 1}`;
    const text = typeof item?.text === 'string' ? item.text : '';
    if (probeIndex < 0 || seen.has(expected) ||
        (item?.challenge_id !== undefined && item.challenge_id !== challengeId) ||
        text.length < 1 || text.length > 12000 || !/^[\d,\s]+$/.test(text)) throw Error('自动捕获的数字序列无效');
    seen.add(expected);
    return {text, expected_count: expected, challenge_id: challengeId};
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;

  // 额度查询：只接受扩展页面（工具栏弹窗）或 arena.ai Agent 页顶层框架的请求。
  if (message?.type === 'AMP_BALANCE') {
    (async () => {
      const fromExtensionPage = !sender.tab && isExtensionPage(sender.url);
      if (!fromExtensionPage && (sender.frameId !== 0 || !isAgentUrl(sender.url))) throw Error('额度请求来源无效');
      return balance.read({force: message.force === true});
    })().then(reply, error => reply({balance: null, cached: false, error: error?.message || '额度读取失败'}));
    return true;
  }

  /* v2.13.0 手动刷新单价表：实时抓榜单 RSC（force=true 绕过冷却），返回表摘要。 */
  if (message?.type === 'AMP_PRICING_REFRESH') {
    (async () => {
      const fromExtensionPage = !sender.tab && isExtensionPage(sender.url);
      if (!fromExtensionPage && (sender.frameId !== 0 || !isAgentUrl(sender.url))) throw Error('单价表刷新请求来源无效');
      const table = await fetchLivePricingTable(true);
      if (!table) throw Error('单价表刷新失败');
      return {ok: true, info: pricingSummary(table)};
    })().then(reply, error => reply({ok: false, error: String(error?.message || error)}));
    return true;
  }

  if (message?.type !== 'AMP_SCORE') return;
  (async () => {
    if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !isAgentUrl(sender.url) || !isAgentUrl(message.pageUrl)) throw Error('评分请求来源无效');
    const outputs = cleanOutputs(message.outputs);
    const prepared = prepareOutputs(outputs);
    if (!prepared.usable.length) return {checks: prepared.checks, result: null};
    const loaded = await loadProbeBank();
    // v2.9.2 平衡配置：家族层级收缩默认 0.1（可传 shrinkage:0 显式关闭），同时保留 LR 唯一候选集门。
    const requestedShrinkage = Number(message?.shrinkage);
    const shrinkage = Number.isFinite(requestedShrinkage) ? Math.min(0.9, Math.max(0, requestedShrinkage)) : DEFAULT_SHRINKAGE;
    const result = identifyPrepared(prepared, loaded.bank, {shrinkage});
    const nearest = result.nearest;
    /* v2.19.11 lmfpd 对照通道：同一批有效回答再过一遍 lm.ikale.io 的 66 模型库，
       只做旁证展示，不参与 status/改名判定；数据随包内置，失败静默降级为 null。 */
    const lmfpd = await lmfpdScoreBlock(prepared, result);
    const price = await priceBlockFor(result);
    const bankIds = (loaded.bank?.models || []).map(m => m?.id).filter(id => typeof id === 'string');
    const pricing = await pricingBlockFor(result, {bankIds});
    /* v2.17.0 价格指纹：指纹识别的候选集（nearest + top3）内，价格能否唯一切开。
       候选来自识别结果 —— 价格只在识别划定的范围里做裁决，不做全库盲猜。 */
    const candidateIds = [nearest.id, ...(result.top3 || []).map(item => item.id)].filter((id, index, list) => typeof id === 'string' && list.indexOf(id) === index);
    const priceFingerprint = await priceFingerprintBlock(candidateIds, {pageUrl: sender.url});
    return {
      checks: prepared.checks,
      result: {
        status: result.status,
        reason: result.reason,
        nearest: {
          id: nearest.id,
          display_name: NAMES[nearest.id] || nearest.display_name || nearest.id,
          family: nearest.family,
          family_name: nearest.family_name,
          fit: nearest.fit,
          probability: nearest.probability,
        },
        top3: result.top3,
        candidates: result.candidates,
        decision: result.decision,
        signals: result.signals,
        used_outputs: result.used_outputs,
        bank_models: result.bank_models,
        bank_source: loaded.info.source,
        price,
        pricing,
        price_fingerprint: priceFingerprint,
        lmfpd,
        lmfpd_bank: lmfpd ? 'Fingerpoint Detector（lm.ikale.io）' : null,
      },
    };
  })().then(reply, error => reply({error: error?.message || '模型指纹评分失败'}));
  return true;
});

/* v2.19.11 lmfpd 对照通道：把主指纹已判定有效的回答再喂给 Fingerpoint Detector
   （lm.ikale.io，66 模型库）的 shared-detector-v2 排名器。只产出对照摘要，
   任何一步失败都返回 null，绝不影响主评分。 */
async function lmfpdScoreBlock(prepared, primaryResult) {
  try {
    if (!prepared?.usable?.length) return null;
    const channel = await loadLmfpdChannel();
    const outputs = prepared.usable.map(({text, expected_count}) => ({text, expected_count}));
    const analysis = analyzeLmfpdOutputs(outputs, channel.bank, channel.detector);
    const summary = lmfpdSummary(analysis, primaryResult?.nearest || null);
    return {...summary, built_at: channel.builtAt || null, bank_models: channel.bank?.models?.length || 0};
  } catch (e) {
    /* 数据缺失/解码失败时仍回报一行，让浮层能区分“没跑”和“库没加载”，主指纹不受影响。 */
    return {decision: 'unavailable', error: String(e?.message || e || 'unknown')};
  }
}

/* ---------------------------------------------------------------------------
   v2.9.0 网络层直读（D）+ 节奏通道（F）+ 建档层（B）
   · AMP_NET          收 MAIN world 嗅探到的模型字段 / public-access-token / 流式节奏，
                      拿到 token 就自动查一次运行轨迹，并把 codename→真名 写进本机缓存。
   · AMP_TRACE_QUERY  手动再查一次（force=true 忽略缓存与冷却）。
   · AMP_EVIDENCE_SAVE 本机保存数字计数向量；只把 trace-verified 标签计入建档，按环境分桶，目标 120 条/模型。
   · AMP_RHYTHM_*     节奏特征的归并 / 投票（第二票，只提示不改名）。
   原则：轨迹查不到就原样说查不到（endpoints 里逐条列出 401/403/404），绝不猜模型名。
   --------------------------------------------------------------------------- */

const TRACE_KEY = 'amp.trace.cache.v1';
const EVIDENCE_KEY = 'amp.evidence.v2';
const RHYTHM_KEY = 'amp.rhythm.profiles.v1';
const EVIDENCE_CAP = 600;
const BANK_TARGET_RESPONSES = 120;
const STREAM_CAP = 40;
const TRACE_COOLDOWN_MS = 45000;
const DEFAULT_SHRINKAGE = 0.1;

// 受信任输入调试轨迹改为内存环形缓冲（原实现每步都读写 chrome.storage.local，在点击/键入热路径上产生 10+ 次存储往返）。
const BTRACE_CAP = 40;
const btraceLog = [];
globalThis.__ampBtrace = btraceLog;

// v2.9.19：清掉已下线功能遗留的本机数据（单 token 电池 / 手工标签）。
void chrome.storage.local.remove(['amp.token.evidence.v1', 'amp.manualLabels.v1']).catch(() => {});

const netState = {token: '', tokenAt: 0, models: [], currentModels: [], streams: [], pendingStreams: [], lastTraceAt: 0, recentRequests: [], pageSnifferAliveAt: 0, pageScanStats: null, costSignals: [], costRouteSignals: [], costGate: null, officialCost: null, usageSignals: [], messageUsage: [], transcriptEstimates: [], agentPriceOutputs: [], identifiedModel: null};
const traceState = {status: 'idle', text: '等待 public-access-token（页面自身请求的响应头）', runId: null, name: null, environment: null, rhythm: null, endpoints: [], error: null, at: null};

/* v2.10.0 价格通道：Arena 在 Agent Pareto 榜公开每个模型的「任务中位成本」（见 Arena价格接口调研.md）。
   这里把随包的价格表加载进来，给评分结果附上「候选成本档位」，并在页面真的下发成本时按成本做一致性核对。
   只读本地 JSON，不联网、不写盘；失败只记录原因，绝不影响指纹评分。 */
let costTableCache = null;
let costTableInfo = {source: null, models: 0, rows: 0, fetched_at: null, error: null};
async function loadCostTable() {
  if (costTableCache) return costTableCache;
  try {
    const response = await fetch(chrome.runtime.getURL('arena-cost-table.json'), {cache: 'no-cache'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const table = normalizeCostTable(await response.json());
    costTableCache = table;
    costTableInfo = {source: table.source, models: table.models, rows: table.rows, fetched_at: table.fetched_at, error: null};
    return table;
  } catch (error) {
    costTableInfo = {...costTableInfo, error: String(error?.message || error)};
    throw error;
  }
}

/** 给指纹结果附上成本旁证块（nearest/top3 的成本档位 + 现场成本一致性）。 */
async function priceBlockFor(result) {
  try {
    const table = await loadCostTable();
    const observed = observedCostFromSignals(netState.costSignals);
    const profileOf = id => {
      const profile = table.profile(id);
      return profile ? {cost_p50: profile.cost_p50, tier: profile.tier, tier_label: TIER_LABEL[profile.tier] || null, label: profile.label, variants: profile.variants} : null;
    };
    const nearestProfile = profileOf(result.nearest.id);
    const candidates = [{id: result.nearest.id}, ...(result.top3 || []).map(item => ({id: item.id}))];
    return {
      table: {source: table.source, fetched_at: table.fetched_at, metric: table.metric, models: table.models},
      nearest: nearestProfile ? {id: result.nearest.id, ...nearestProfile} : null,
      top3: (result.top3 || []).map(item => ({id: item.id, display_name: item.display_name, ...(profileOf(item.id) || {})})),
      observed_usd: observed,
      cross_check: observed ? crossCheckCost(observed, candidates, table) : null,
    };
  } catch (error) {
    return {error: String(error?.message || error), table: costTableInfo};
  }
}

/* v2.12.0 单价通道：Arena 在榜单 RSC 里**公开**每个模型的 token 单价
   （inputPricePerMillion / outputPricePerMillion，单位 USD/百万 token）。
   于是「按价格反推模型」有了可算的一半：
       期望成本(模型) = Σ tokensᵢ/1e6 × priceᵢ(模型)
   v2.13.0 单价表从「只读随包快照」升级为「实时抓取」：
   GET https://arena.ai/leaderboard 带 RSC:1 头，flight 载荷每行带
   inputPricePerMillion / outputPricePerMillion（+ cacheRead/cacheWritePricePerMillion，
   实测全 null），解析后持久化到 chrome.storage.local（amp.pricing.live.v1）。
   加载优先级：内存缓存 → 24h 内的持久化实时表 → 实时抓取（30 分钟冷却）→ 随包快照兜底。
   失败只记原因，绝不影响指纹评分。 */
// v1 曾把缺失的缓存价格解析成 0；换缓存键，不继续消费已污染的文档。
const PRICING_LIVE_KEY = 'amp.pricing.live.v2';
const PRICING_LIVE_TTL_MS = 24 * 3600e3;
const PRICING_LIVE_COOLDOWN_MS = 30 * 60e3;
/* v2.19.0 cache 费率补充表（arena-cache-rates.json，来源 OpenRouter 公开价目）。
   Arena 榜单的 cacheRead/cacheWritePricePerMillion 实测恒 null（见下），而 /cost 账单里
   cacheReadTokensCostUsd 常是金额大头 —— 没有 cache 费率，四项整数反推必然 0 候选。
   补充表由 tools/build-cache-rates.mjs 生成（126/208 命中，逐条校验过 input/output 一致）。
   **只补不覆盖**：官方若将来下发 cache 费率，以官方为准。

   注意：文件名是**字面量常量**，这样 tools/package.mjs 的依赖闭包扫描才能发现它；
   不要改成变量拼接，否则打包会漏文件。 */
const CACHE_RATES_FILE = 'arena-cache-rates.json';
void chrome.runtime.getURL('arena-cache-rates.json');   // 依赖闭包锚点：须与上面的常量一致
let cacheRatesDoc = null;
let cacheRatesLoadState = {tried: false, error: null};

/* 已揭示 Battle 训练集的脱敏费率摘要。原始训练集含 prompt/response，不进入运行时包；
   tools/build-battle-price-rates.mjs 只输出稳定的同消息实测费率和样本数。
   同 key 时 Battle 实测作主值，Arena 官方价保留为辅助参考。 */
const BATTLE_PRICE_RATES_FILE = 'arena-battle-price-rates.json';
void chrome.runtime.getURL('arena-battle-price-rates.json');   // 依赖闭包锚点：须与上面的常量一致
let battlePriceRatesDoc = null;
let battlePriceRatesLoadState = {tried: false, error: null};

/* v2.19.6：OpenRouter 公开价目补充表 —— 补的是**模型本体**（Arena 榜单没有的整行加进来）。
   Arena 榜单只覆盖它自己上架的 208 个模型；实测真实账单可能只能被榜单之外的模型解释
   （deepseek/deepseek-v4-flash-vision-exp）。表由 tools/build-openrouter-prices.mjs 生成。
   **只加不覆盖**：Arena 已有的 model_key 一律以 Arena 为准。
   同样：文件名是字面量常量 + 一行 getURL 锚点，否则打包会静默漏文件。 */
const OPENROUTER_PRICES_FILE = 'openrouter-prices.json';
void chrome.runtime.getURL('openrouter-prices.json');   // 依赖闭包锚点：须与上面的常量一致
let openRouterDoc = null;
let openRouterLoadState = {tried: false, error: null};
let pricingTableCache = null;
let pricingTableInfo = {source: null, models: 0, text_models: 0, fetched_at: null, error: null};
let lastLiveFetchAt = 0;

/* 从 start（指向 '{'）开始切平衡的 {...}（含字符串/转义处理）。 */
function sliceBalancedObject(text, start, maxLen = 8000) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const end = Math.min(text.length, start + maxLen);
  for (let i = start; i < end; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/* 解析榜单 RSC 的 flight 文本成单价行。榜单行是嵌在 flight 行里的 JSON 对象：
   定位 "inputPricePerMillion" 出现处，向前找包裹它的 '{' 切平衡对象解析。
   flight 载荷可能是转义的（self.__next_f.push 字符串）——首遍 0 命中时解转义再扫。 */
function parseLeaderboardFlight(text) {
  const rows = [];
  const priceOrNull = value => {
    if (value === null || value === undefined || typeof value === 'boolean' ||
        (typeof value === 'string' && !value.trim())) return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const scan = (source) => {
    const marker = '"inputPricePerMillion"';
    let idx = 0;
    let guard = 0;
    const seen = new Set();
    while (guard < 400) {
      const at = source.indexOf(marker, idx);
      if (at < 0) break;
      guard += 1;
      idx = at + marker.length;
      // 向前收集至多 4 个候选 '{'（最近的优先），逐个尝试切平衡对象。
      const tryBraces = [];
      for (let i = at - 1; i >= Math.max(0, at - 3000) && tryBraces.length < 4; i -= 1) {
        if (source[i] === '{') tryBraces.push(i);
      }
      for (const brace of tryBraces) {
        const slice = sliceBalancedObject(source, brace);
        if (!slice) continue;
        let parsed = null;
        try { parsed = JSON.parse(slice); } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object' || typeof parsed.modelKey !== 'string') continue;
        const key = parsed.modelKey.trim();
        const input = priceOrNull(parsed.inputPricePerMillion);
        const output = priceOrNull(parsed.outputPricePerMillion);
        if (!key || key.length > 160 || seen.has(key)) break;
        if (input === null && output === null) break;
        seen.add(key);
        const cacheRead = priceOrNull(parsed.cacheReadPricePerMillion);
        const cacheWrite = priceOrNull(parsed.cacheWritePricePerMillion);
        rows.push({
          model_key: key,
          display: typeof parsed.modelDisplayName === 'string' ? parsed.modelDisplayName : key,
          org: typeof parsed.modelOrganization === 'string' ? parsed.modelOrganization : null,
          input_usd_per_mtok: Number.isFinite(input) && input >= 0 ? input : null,
          output_usd_per_mtok: Number.isFinite(output) && output >= 0 ? output : null,
          cache_read_usd_per_mtok: Number.isFinite(cacheRead) && cacheRead >= 0 ? cacheRead : null,
          cache_write_usd_per_mtok: Number.isFinite(cacheWrite) && cacheWrite >= 0 ? cacheWrite : null,
        });
        break;
      }
    }
  };
  scan(String(text || ''));
  if (!rows.length) scan(String(text || '').replace(/\\"/g, '"'));
  return rows;
}

/* v2.19.12 Arena 风控规避：停用对 Arena 的主动探测请求 —— 榜单 RSC 实时单价表
   不再抓取（回退到随包快照 + 已缓存的存活表）。要恢复就把下面置 true。 */
const ARENA_API_PROBES = false;

/* 实时抓取公开单价表；成功后归一化、持久化到 chrome.storage.local 并刷新内存缓存。 */
async function fetchLivePricingTable(force = false) {
  if (!ARENA_API_PROBES) throw new Error('Arena 价格指纹实时抓取已停用（风控规避）');
  if (!force && Date.now() - lastLiveFetchAt < PRICING_LIVE_COOLDOWN_MS) return null;
  lastLiveFetchAt = Date.now();
  const response = await fetch('https://arena.ai/leaderboard', {headers: {RSC: '1'}, cache: 'no-store', credentials: 'omit'});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  const rows = parseLeaderboardFlight(text);
  if (rows.length < 10) throw new Error(`flight 载荷只解析出 ${rows.length} 行单价，疑似 Arena 改版`);
  const doc = {schema: 'arena-model-pricing', source: 'https://arena.ai/leaderboard (RSC live)', fetched_at: new Date().toISOString(), unit: 'usd_per_million_tokens', rows};
  const table = await decoratePricingTable(doc); // 校验不过会抛错；合并 OpenRouter 模型 + cache 费率
  try { await chrome.storage.local.set({[PRICING_LIVE_KEY]: doc}); } catch { /* 持久化失败仍用内存缓存 */ }
  pricingTableCache = table;
  pricingTableInfo = {source: table.source, models: table.models, text_models: table.text_models, fetched_at: table.fetched_at, error: null};
  return table;
}

async function loadPricingTable() {
  if (pricingTableCache) return pricingTableCache;
  try {
    const stored = await chrome.storage.local.get(PRICING_LIVE_KEY);
    const doc = stored?.[PRICING_LIVE_KEY];
    const age = doc?.fetched_at ? Date.now() - Date.parse(doc.fetched_at) : Infinity;
    if (doc && Number.isFinite(age) && age >= 0 && age < PRICING_LIVE_TTL_MS) {
      try {
        const table = await decoratePricingTable(doc);
        pricingTableCache = table;
        pricingTableInfo = {source: table.source, models: table.models, text_models: table.text_models, fetched_at: table.fetched_at, error: null};
        return table;
      } catch { /* 持久化表损坏 → 继续走重抓/快照 */ }
    }
  } catch { /* 存储读取失败忽略 */ }
  try {
    const live = await fetchLivePricingTable(false);
    if (live) return live;
  } catch (error) {
    pricingTableInfo = {...pricingTableInfo, error: `实时抓取失败：${String(error?.message || error)}`};
  }
  try {
    const response = await fetch(chrome.runtime.getURL('arena-pricing-table.json'), {cache: 'no-cache'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const table = await decoratePricingTable(await response.json());
    pricingTableCache = table;
    pricingTableInfo = {source: table.source, models: table.models, text_models: table.text_models, fetched_at: table.fetched_at, error: null};
    return table;
  } catch (error) {
    pricingTableInfo = {...pricingTableInfo, error: String(error?.message || error)};
    throw error;
  }
}

/** 原始价目文档 → 归一化单价表，并按可信度合并三张补充表：
 *  ① `arena-battle-price-rates.json` —— 已揭示 Battle 同消息实测价（同 key 覆盖主值、保留官方参考）；
 *  ② `openrouter-prices.json` —— 再补前两者都没有的公开模型（只加不覆盖）；
 *  ③ `arena-cache-rates.json` —— 给已有行补 cache 费率（只补不覆盖）。
 *  任一张读不到都不阻塞 —— 补充表缺失不能让整条价格通道瘫痪。 */
async function decoratePricingTable(rawDoc) {
  const [battleRates, prices, cacheRates] = await Promise.all([
    loadBattlePriceRates(), loadOpenRouterPrices(), loadCacheRates(),
  ]);
  const observed = mergeBattleObservedPrices(rawDoc, battleRates);
  const merged = mergeOpenRouterPrices(observed, prices);
  const table = normalizePricingTable(merged);
  const officialRows = new Map((rawDoc.rows || [])
    .filter(row => row.source !== 'openrouter-public').map(row => [row.model_key, row]));
  const arenaKeys = new Set(officialRows.keys());
  const mergedRows = new Map((merged.rows || []).map(row => [row.model_key, row]));
  const observedKeys = new Set((merged.rows || []).filter(row => row.source === 'arena-battle-observed').map(row => row.model_key));
  const battleSamplesBySlug = new Map();
  for (const row of (Array.isArray(battleRates?.rows) && battleRates.rows.length ? battleRates.rows : (merged.rows || []))) {
    if (!row?.observed_samples) continue;
    const slug = canonicalModelSlug(row.model_key);
    if (slug) {
      const exactKey = `${slug}|${row.input_usd_per_mtok}|${row.output_usd_per_mtok}`;
      const entry = battleSamplesBySlug.get(exactKey) || {samples: row.observed_samples, tiers: [], inRate: row.input_usd_per_mtok, outRate: row.output_usd_per_mtok};
      entry.tiers.push({...row.observed_samples, tier_key: row.model_key});
      battleSamplesBySlug.set(exactKey, entry);
      if (!battleSamplesBySlug.has(slug)) {
        battleSamplesBySlug.set(slug, entry);
      }
    }
  }
  for (const profile of table.all()) {
    profile.arena_listed = arenaKeys.has(profile.model_key);
    profile.arena_battle_observed = observedKeys.has(profile.model_key);
    const mergedRow = mergedRows.get(profile.model_key);
    const officialRow = officialRows.get(profile.model_key);
    profile.price_source = profile.arena_battle_observed ? 'arena-battle-observed'
      : profile.arena_listed ? 'arena-official'
        : (typeof mergedRow?.source === 'string' ? mergedRow.source : null);
    profile.battle_observed_samples = profile.arena_battle_observed
      ? (mergedRow?.observed_samples ? {...mergedRow.observed_samples} : null) : null;
    if (battleSamplesBySlug.size) {
      const slug = canonicalModelSlug(profile.display || profile.model_key) || canonicalModelSlug(profile.model_key);
      const exactKey = slug ? `${slug}|${profile.input_usd_per_mtok}|${profile.output_usd_per_mtok}` : '';
      const matched = (exactKey && battleSamplesBySlug.get(exactKey)) || (slug ? battleSamplesBySlug.get(slug) : null);
      if (matched && profile.input_usd_per_mtok === matched.inRate && profile.output_usd_per_mtok === matched.outRate) {
        if (!profile.battle_observed_samples) profile.battle_observed_samples = {...matched.samples};
        if (matched.tiers.length > 1) {
          profile.battle_observed_samples.tier_samples = matched.tiers.map(t => ({...t}));
        }
      }
    }
    if (profile.arena_battle_observed) profile.battle_observed_rates = {
      input_usd_per_mtok: profile.input_usd_per_mtok,
      output_usd_per_mtok: profile.output_usd_per_mtok,
      cache_read_usd_per_mtok: profile.cache_read_usd_per_mtok,
      cache_write_usd_per_mtok: profile.cache_write_usd_per_mtok,
    };
    // 官方字段从合并前的原始表保存，避免被 Battle 主值覆盖后丢失辅助参考。
    if (profile.arena_listed) profile.arena_official_rates = {
      input_usd_per_mtok: officialRow?.input_usd_per_mtok ?? null,
      output_usd_per_mtok: officialRow?.output_usd_per_mtok ?? null,
      cache_read_usd_per_mtok: officialRow?.cache_read_usd_per_mtok ?? null,
      cache_write_usd_per_mtok: officialRow?.cache_write_usd_per_mtok ?? null,
    };
  }
  /* 补充表元信息显式挂到归一化表上（normalizePricingTable 只回传计价档案，不搬运任意字段）。 */
  if (merged.battle_observed_supplement) table.battle_observed_rates = merged.battle_observed_supplement;
  if (merged.openrouter_supplement) table.openrouter_supplement = merged.openrouter_supplement;
  return applyCacheRates(table, cacheRates) || table;
}
/** 识别费率优先级：Battle 稳定实测 > Arena 官方参考 > OpenRouter 公开价兜底。 */
function arenaPricingTable(table, pageUrl = '') {
  let agentOnly = false;
  try { agentOnly = /^\/(?:agent|work|c)(?:\/|$)/i.test(new URL(pageUrl).pathname); } catch {} // v2.19.10：补 Arena 新会话路由 /c/<id>，否则新路由下不会按 agent 变体收窄
  // 榜单包含历史 text/webdev 条目，不等于当前 Agent 的路由池。
  // 明确的 Agent/Work 页面只过滤纯官方历史条目；Battle 实测和 OpenRouter 兜底不按后缀误删。
  const profiles = table.all().filter(profile =>
    (profile.arena_battle_observed === true || profile.arena_listed === true || profile.price_source === 'openrouter-public')
      && (!agentOnly || profile.arena_battle_observed === true || profile.price_source === 'openrouter-public'
        || /(?:^|-)agent(?:-|$)/i.test(profile.model_key))).map(profile => {
    const observed = profile.arena_battle_observed === true;
    const official = profile.arena_listed === true;
    const primary = observed ? profile.battle_observed_rates
      : official ? profile.arena_official_rates : null;
    const source = observed ? 'arena-battle-observed'
      : official ? 'arena-official' : 'openrouter-public';
    const primaryHasRead = (primary?.cache_read_usd_per_mtok ?? null) !== null;
    const primaryHasWrite = (primary?.cache_write_usd_per_mtok ?? null) !== null;
    const usedSupplementCache = (!primaryHasRead && profile.cache_read_usd_per_mtok !== null)
      || (!primaryHasWrite && profile.cache_write_usd_per_mtok !== null);
    const primaryHasCache = (primaryHasRead || primaryHasWrite) && !usedSupplementCache;
    return {
      ...profile,
      ...(primary || {}),
      cache_read_usd_per_mtok: primary?.cache_read_usd_per_mtok ?? profile.cache_read_usd_per_mtok,
      cache_write_usd_per_mtok: primary?.cache_write_usd_per_mtok ?? profile.cache_write_usd_per_mtok,
      cache_rate_source: primaryHasCache ? source : (profile.cache_rate_source || source),
      cache_rate_or_id: primaryHasCache ? null : (profile.cache_rate_or_id || null),
      cache_rate_batch: primaryHasCache ? false : profile.cache_rate_batch === true,
      cache_rate_consistent: primaryHasCache ? true : profile.cache_rate_consistent !== false,
      price_source: source,
      official_reference_rates: observed && official ? profile.arena_official_rates : null,
    };
  });
  const byKey = new Map(profiles.map(profile => [profile.model_key, profile]));
  // 在过滤后的池子重新解析别名，避免非 Agent 精确命中挡住 Agent 变体。
  const scoped = profiles.length ? normalizePricingTable({schema: table.schema, rows: profiles}) : null;
  return {...table, byKey, rows: profiles.length, models: profiles.length,
    text_models: profiles.filter(profile => profile.kind !== 'media').length,
    media_models: profiles.filter(profile => profile.kind === 'media').length,
    openrouter_supplement: table.openrouter_supplement || null,
    cache_rates: table.cache_rates || null,
    battle_observed_rates: table.battle_observed_rates || null,
    pricing_policy: 'battle-observed-then-arena-official-then-openrouter',
    candidate_scope: agentOnly ? 'agent-pricing-priority' : 'pricing-priority',
    profile: key => byKey.get(key) || null,
    all: () => profiles.slice(),
    text: () => profiles.filter(profile => profile.kind !== 'media'),
    resolve: id => scoped ? scoped.resolve(id) : [],
  };
}

async function loadBattlePriceRates() {
  if (battlePriceRatesLoadState.tried) return battlePriceRatesDoc;
  battlePriceRatesLoadState = {tried: true, error: null};
  try {
    const response = await fetch(chrome.runtime.getURL(BATTLE_PRICE_RATES_FILE), {cache: 'no-cache'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const doc = await response.json();
    if (!doc || doc.schema !== 'arena-battle-price-rates-v1' || !Array.isArray(doc.rows)) {
      throw new Error('Battle 实测费率表 schema 无效');
    }
    battlePriceRatesDoc = doc;
  } catch (error) {
    battlePriceRatesLoadState.error = String(error?.message || error);
    battlePriceRatesDoc = null;
  }
  return battlePriceRatesDoc;
}

/** v2.19.6：读 OpenRouter 公开价目补充表（模型本体：in/out/cache）。
 *  动机：Arena 榜单只覆盖它自己上架的模型，实际会话可能跑在榜单之外的模型上
 *  （实测 deepseek/deepseek-v4-flash-vision-exp 既不在榜单也不在指纹库，但能逐项解释真实账单）。 */
async function loadOpenRouterPrices() {
  if (openRouterLoadState.tried) return openRouterDoc;
  openRouterLoadState = {tried: true, error: null};
  try {
    const response = await fetch(chrome.runtime.getURL(OPENROUTER_PRICES_FILE), {cache: 'no-cache'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const doc = await response.json();
    if (!doc || doc.schema !== 'openrouter-prices' || !Array.isArray(doc.rows)) throw new Error('补充表 schema 无效');
    openRouterDoc = doc;
  } catch (error) {
    openRouterLoadState.error = String(error?.message || error);
    openRouterDoc = null;
  }
  return openRouterDoc;
}

async function loadCacheRates() {
  if (cacheRatesLoadState.tried) return cacheRatesDoc;
  cacheRatesLoadState = {tried: true, error: null};
  try {
    const response = await fetch(chrome.runtime.getURL(CACHE_RATES_FILE), {cache: 'no-cache'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const doc = await response.json();
    if (!doc || doc.schema !== 'arena-cache-rates' || !doc.rates || typeof doc.rates !== 'object') {
      throw new Error('补充表 schema 无效');
    }
    cacheRatesDoc = doc;
  } catch (error) {
    cacheRatesLoadState.error = String(error?.message || error);
    cacheRatesDoc = null;
  }
  return cacheRatesDoc;
}

/* v2.16.0 官方成本通道清洗：content.js 带 PostHog 覆写 cookie 读到 /cost 200 后，
   把整份账单发给后台，在这里洗成可存形态。
   字段全部过白名单（不进正文、不接对象）、条数 ≤100、量级 ≤1e7，全空的行直接丢。
   返回 null = 这份账单没有任何可用数字，调用方按没收到处理。 */
function cleanOfficialCost(message) {
  const session = message?.session && typeof message.session === 'object' ? message.session : null;
  const messages = message?.messages && typeof message.messages === 'object' ? message.messages : null;
  if (!session && !messages) return null;
  const num = (value) => (value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e7 ? Number(value) : null);
  const cleanSession = session ? {
    actualTotalUsd: num(session.actualTotalUsd),
    chargedTotalUsd: num(session.chargedTotalUsd),
    basePriceUsd: num(session.basePriceUsd),
    costMultiplier: num(session.costMultiplier),
    marginMultiplier: num(session.marginMultiplier),
    messageCount: Number(session.messageCount) || null,
    /* 实测 session 下还挂一层 aggregate（basePriceUsd / totalChargedCredits 在这里）。 */
    aggregate: session.aggregate && typeof session.aggregate === 'object' ? {
      basePriceUsd: num(session.aggregate.basePriceUsd),
      totalChargedUsd: num(session.aggregate.totalChargedUsd),
      totalChargedCredits: num(session.aggregate.totalChargedCredits),
    } : null,
  } : null;
  /* messages 逐条过白名单：只留 messageId + USD/积分/倍率字段，最多 100 条。 */
  const cleanMessages = {};
  if (messages) {
    let count = 0;
    for (const [messageId, entry] of Object.entries(messages)) {
      if (count >= 100) break;
      if (!entry || typeof entry !== 'object') continue;
      const actual = entry.actual && typeof entry.actual === 'object' ? entry.actual : entry;
      const row = {
        basePriceUsd: num(entry.basePriceUsd ?? actual.basePriceUsd),
        totalCostUsd: num(actual.totalCostUsd ?? entry.totalCostUsd),
        totalChargedUsd: num(entry.totalChargedUsd ?? actual.totalChargedUsd),
        totalChargedCredits: num(entry.totalChargedCredits ?? actual.totalChargedCredits),
        inputTokensCostUsd: num(actual.inputTokensCostUsd ?? entry.inputTokensCostUsd),
        outputTokensCostUsd: num(actual.outputTokensCostUsd ?? entry.outputTokensCostUsd),
        cacheWriteTokensCostUsd: num(actual.cacheWriteTokensCostUsd ?? entry.cacheWriteTokensCostUsd),
        cacheReadTokensCostUsd: num(actual.cacheReadTokensCostUsd ?? entry.cacheReadTokensCostUsd),
        isFallback: actual.isFallback === true || entry.isFallback === true ? true : null,
        isLongContext: actual.isLongContext === true || entry.isLongContext === true ? true : null,
        /* pricingStrategy 实测在 entry 顶层（不在 actual 里）—— 与其余字段一样双来源。 */
        pricingStrategy: typeof (actual.pricingStrategy ?? entry.pricingStrategy) === 'string' ? String(actual.pricingStrategy ?? entry.pricingStrategy).slice(0, 40) : null,
        marginMultiplier: num(entry.marginMultiplier ?? actual.marginMultiplier),
        discountPercent: num(entry.discountPercent ?? actual.discountPercent),
      };
      if (hasNonTokenMediaCost(entry)) row.non_token_media_cost = true;
      if (Object.values(row).every(value => value === null)) continue;
      cleanMessages[String(messageId).slice(0, 64)] = row;
      count += 1;
    }
  }
  if (!cleanSession && !Object.keys(cleanMessages).length) return null;
  return {
    route: String(message.route || 'cost-api').slice(0, 40),
    path: String(message.path || '').slice(0, 200),
    session: cleanSession,
    messages: cleanMessages,
    at: Number(message.at) || Date.now(),
  };
}

function baseUsdFromCostEntry(entry) {
  for (const value of [entry?.basePriceUsd, entry?.base_usd, entry?.actual?.basePriceUsd]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function explicitSessionBaseUsd(session) {
  return baseUsdFromCostEntry(session) || baseUsdFromCostEntry(session?.aggregate);
}

function sumExplicitMessageBase(messages) {
  const rows = Array.isArray(messages) ? messages : Object.values(messages || {});
  return rows.reduce((sum, entry) => sum + (baseUsdFromCostEntry(entry) || 0), 0);
}

function nonTokenMediaCostCount(messages) {
  const rows = Array.isArray(messages) ? messages : (messages && typeof messages === 'object' ? Object.values(messages) : []);
  return rows.filter(hasNonTokenMediaCost).length;
}

function nonTokenMediaCostNote(count) {
  return `官方账单有 ${count} 条包含图像/视频/音频专属费用；当前 usage 没有对应模态计数，不与纯 token 费率反推。`;
}

/** Pick the newest exact Arena usage row whose message_id has an explicit per-message base. */
function latestMatchedMessageCostUsage(messageUsage = netState.messageUsage, costPayload = null) {
  const baseById = new Map();
  const addMessages = messages => {
    if (Array.isArray(messages)) {
      for (const entry of messages) {
        const id = entry?.message_id;
        const base = baseUsdFromCostEntry(entry);
        if (id && base && !baseById.has(String(id))) baseById.set(String(id), base);
      }
      return;
    }
    if (!messages || typeof messages !== 'object') return;
    for (const [key, entry] of Object.entries(messages)) {
      const id = entry?.message_id || key;
      const base = baseUsdFromCostEntry(entry);
      if (id && base && !baseById.has(String(id))) baseById.set(String(id), base);
    }
  };
  if (costPayload && typeof costPayload === 'object') {
    if (nonTokenMediaCostCount(costPayload.messages)) return null;
    addMessages(costPayload.messages);
  } else {
    const route = netState.costRouteSignals[netState.costRouteSignals.length - 1];
    if (nonTokenMediaCostCount(netState.officialCost?.messages) || nonTokenMediaCostCount(route?.messages)) return null;
    addMessages(netState.officialCost?.messages);
    addMessages(route?.messages);
  }
  const rows = Array.isArray(messageUsage) ? messageUsage : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const entry = rows[index];
    const id = String(entry?.message_id || '');
    const base = baseById.get(id);
    if (!id || !base) continue;
    const raw = entry?.usage;
    const usage = raw?.schema === USAGE_SCHEMA ? raw : parseUsage(raw);
    if (usage && (Number(usage.totalTokens) || 0) > 0) {
      return {message_id: id, base_usd: base, usage, usage_source: 'message-usage'};
    }
  }
  return null;
}

/* 按公开单价反推只接受 Arena base：actualTotalUsd / totalCostUsd 是上游成本，
   不能代替 base；有消息明细时再与相同 message_id 的精确 usage 配对。 */
function observedCostActual() {
  const official = netState.officialCost;
  if (official) {
    const detail = costDetailFromSession(official.session);
    const sessionUsd = explicitSessionBaseUsd(official.session);
    if (sessionUsd) return {usd: sessionUsd, via: 'official-cost/session', detail: detail ? {...detail, base_usd: sessionUsd} : {base_usd: sessionUsd}};
    const sum = sumExplicitMessageBase(official.messages);
    if (sum > 0) return {usd: Number(sum.toFixed(12)), via: 'official-cost/messages', detail: detail ? {...detail, base_usd: Number(sum.toFixed(12))} : {base_usd: Number(sum.toFixed(12))}};
  }
  const route = netState.costRouteSignals[netState.costRouteSignals.length - 1];
  if (route) {
    const detail = costDetailFromSession(route.session);
    const sessionUsd = explicitSessionBaseUsd(route.session);
    if (sessionUsd) return {usd: sessionUsd, via: 'cost-route/session', detail: detail ? {...detail, base_usd: sessionUsd} : {base_usd: sessionUsd}};
    const sum = sumExplicitMessageBase(route.messages);
    if (sum > 0) return {usd: Number(sum.toFixed(12)), via: 'cost-route/messages', detail: detail ? {...detail, base_usd: Number(sum.toFixed(12))} : {base_usd: Number(sum.toFixed(12))}};
  }
  const detail = observedCostDetail(netState.costSignals);
  const genericBase = baseUsdFromCostEntry({basePriceUsd: detail?.base_usd});
  return genericBase ? {usd: genericBase, via: 'cost-fields', detail} : null;
}

/** 给指纹结果附上单价块：候选的价格档位 + 本次用量的期望成本区分度（+ 有实测成本时按价排序 + 全库按价反推）。 */
async function pricingBlockFor(result, options = {}) {
  try {
    const table = await loadPricingTable();
    const latestMessageEntry = netState.messageUsage.slice().reverse().find(entry => entry?.usage) || null;
    const usage = latestMessageEntry?.usage || latestUsage(netState.usageSignals)?.usage || null;
    const candidates = [result.nearest.id, ...(result.top3 || []).map(item => item.id)];
    const block = {
      table: pricingSummary(table),
      usage_source: usage ? (latestMessageEntry ? 'message-usage' : 'netState.usageSignals') : null,
      candidates: candidates.map(id => {
        const priced = bankPricing(id, table);
        return {id, priced: priced?.priced || false, keys: priced?.keys || [], input_range: priced?.input_range || null, output_range: priced?.output_range || null};
      }),
      discrimination: usage ? discrimination(usage, candidates, table) : null,
      note: usage
        ? `期望成本按最近一次${latestMessageEntry ? '逐条 Arena usage' : '实测 token 用量'}折算；缓存单价 Arena 未下发，故只是下界。`
        : '尚未捕获 token 用量，只能给价格档位、无法折算期望成本（需页面上真实发一条消息）。',
    };
    /* v2.13.0 每条消息的期望成本：本条实测 token 用量 × 识别模型的单价。
       Arena 网页版不下发美元成本，这就是「本次发消息花了多少」的可用答案；
       识别模型有多档变体单价时给区间；缓存单价未下发时只是下界（complete=false）。 */
    if (usage) {
      const nearestPriced = bankPricing(result.nearest.id, table);
      if (nearestPriced?.priced) {
        const exps = nearestPriced.keys
          .map(key => {
            const profile = table.profile(key);
            const expected = profile ? expectedCostUsd(usage, profile) : null;
            return expected && expected.usd > 0 ? {key, ...expected} : null;
          })
          .filter(Boolean);
        if (exps.length) {
          const usds = exps.map(entry => entry.usd);
          const lo = Math.min(...usds);
          const hi = Math.max(...usds);
          block.message_cost = {
            model: result.nearest.id,
            min_usd: lo,
            max_usd: hi,
            complete: exps.some(entry => entry.complete),
            variants: exps.length,
            text: `本条 ≈ $${lo.toFixed(4)}${hi > lo ? `~$${hi.toFixed(4)}` : ''}（期望成本，按公开单价估算）`,
          };
        }
      }
    }
    const actual = observedCostActual();
    const matchedPair = latestMatchedMessageCostUsage(netState.messageUsage, options.costPayload || null);
    const suppliedBase = explicitSessionBaseUsd(options.costPayload?.session);
    const observedUsd = actual?.usd || suppliedBase || null;
    const route = netState.costRouteSignals[netState.costRouteSignals.length - 1];
    const mediaCostCount = nonTokenMediaCostCount(options.costPayload?.messages || netState.officialCost?.messages || route?.messages);
    const detail = actual?.detail
      || costDetailFromSession(options.costPayload?.session)
      || costDetailFromSession(netState.officialCost?.session)
      || costDetailFromSession(route?.session)
      || observedCostDetail(netState.costSignals);
    /* 仅展示明确 base；实际用于比较时还必须是同 message_id 的 base + usage。 */
    block.observed_usd = observedUsd || null;
    block.observed_via = actual?.via || (suppliedBase ? 'cost-payload/session-base' : null);
    if (detail) {
      block.observed_detail = detail;
      block.observed_text = describeCostDetail(detail);
    }
    if (matchedPair) {
      block.ranked = rankByObservedCost(matchedPair.base_usd, matchedPair.usage, candidates, table);
      block.ranked_observation = {message_id: matchedPair.message_id, base_usd: matchedPair.base_usd, usage_source: matchedPair.usage_source};
    } else {
      block.ranked = null;
      const hasExactUsage = netState.messageUsage.some(entry => entry?.usage);
      const upstreamOnly = Number(detail?.actual_usd) > 0 && !(Number(detail?.base_usd) > 0);
      block.observed_note = mediaCostCount
        ? nonTokenMediaCostNote(mediaCostCount)
        : upstreamOnly
          ? '只有上游 actual 成本，没有明确 Arena base；不能与公开 token 单价比较。'
          : observedUsd && hasExactUsage
            ? '已有 Arena base 与逐条用量，但没有相同 message_id 的配对；不会拿会话合计比较单条用量。'
            : observedUsd
              ? '已拿到 Arena session base，但没有同 message_id 的逐条 base + usage 配对，按价排序待命。'
              : netState.costGate
                ? `检测到 ${netState.costGate.url || '/cost 路由'} 返回 ${netState.costGate.status}（覆写 cookie 后仍未放行）→ 显示期望成本；一旦取得同消息 base + usage 配对才按价排序。`
                : (netState.officialCost || options.costPayload)
                  ? '已拿到 /cost 响应，但缺少可与逐条 usage 对齐的明确 Arena base；按价排序待命。'
                  : '未拿到 Arena 按次成本（/api/chat/:id/cost；v2.16.0 起会带 PostHog 覆写 cookie 再试）。';
    }
    /* 按价反推只用同 message_id 的逐条 Arena base × 精确 usage；会话总额不会摊给单条用量。 */
    const bankIds = Array.isArray(options.bankIds) ? options.bankIds.filter(id => typeof id === 'string') : [];
    if (matchedPair && bankIds.length) {
      const hits = rankByObservedCost(matchedPair.base_usd, matchedPair.usage, bankIds, table, 6);
      if (hits?.length) {
        const groups = samePriceGroups(hits.map(hit => hit.model_key), table);
        block.reverse = {
          observed_usd: matchedPair.base_usd,
          message_id: matchedPair.message_id,
          usage_source: matchedPair.usage_source,
          scope: 'message',
          bank_models: bankIds.length,
          hits,
          same_price_groups: groups.map(group => ({ids: group.ids, ambiguous: group.ids.length > 1})),
          text: `按价反推: ${hits[0].label || hits[0].model_key}（比值 ${hits[0].ratio}${hits[0].complete ? '' : ' · 下界'}）`,
        };
      }
    } else if (matchedPair) {
      block.reverse = {blocked: 'no-model-bank', note: '同消息 base 与精确 usage 已配对，但指纹库没有可排序的模型。'};
    } else {
      const hasExactUsage = netState.messageUsage.some(entry => entry?.usage);
      const upstreamOnly = Number(detail?.actual_usd) > 0 && !(Number(detail?.base_usd) > 0);
      block.reverse = mediaCostCount
        ? {blocked: 'non-token-media-cost', note: nonTokenMediaCostNote(mediaCostCount)}
        : observedUsd
          ? {blocked: hasExactUsage ? 'no-message-pair' : 'no-usage', note: '按价反推需要相同 message_id 的「逐条 Arena base + 精确 usage」；会话级合计不与单条用量混算。'}
          : upstreamOnly
            ? {blocked: 'no-base-cost', note: '只有上游 actual 成本，没有明确 Arena base，不能与公开模型单价比较。'}
            : {blocked: 'no-observed-cost', note: '按价反推需要「同消息的真实 base 成本与精确 usage」；当前没有可配对数据。'};
    }
    return block;
  } catch (error) {
    return {error: String(error?.message || error), table: pricingTableInfo};
  }
}

/* v2.13.2 花费账本：把「这次会话花了多少」摊成逐条明细。
   base 由「公开单价 × 实测 token 用量」算出（**不需要计费账号**）；
   真实成本（已开通计费才有）按 message_id 对齐后覆盖，用 source 区分两者。
   逐条对不上时（例如只有会话级聚合）只把真实值挂到汇总，**不硬摊到每条**。 */
async function ledgerBlock(options = {}) {
  try {
    const table = await loadPricingTable();
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(120, options.limit)) : 60;
    const entries = netState.messageUsage.slice(-limit).map(entry => ({
      message_id: entry.message_id, role: entry.role, position: entry.position,
      model_id: entry.model_id, usage: entry.usage,
    }));
    /* 真实成本按 message_id 对齐（/cost 路由的结构化结果）。 */
    const realCosts = {};
    const route = netState.costRouteSignals[netState.costRouteSignals.length - 1];
    if (route && Array.isArray(route.messages)) {
      for (const message of route.messages) {
        if (message?.message_id) realCosts[message.message_id] = {actual_usd: message.actual_usd};
      }
    }
    /* v2.13.4：content.js 主动探测到的 /cost 响应（服务端权威金额）优先。
       Agent 模式拿不到 token 用量（会话包 metadata 里就没有 usage 字段），
       只能靠这条路。
       v2.16.0：灰度门已可用 PostHog 覆写 cookie 放行（实测 200），现在有两条来路：
       浮层本轮传来的 costPayload，或 background 缓存的 netState.officialCost
       （弹窗路径不传 costPayload，靠缓存这份同样能出官方明细）。 */
    let costPayload = options.costPayload && typeof options.costPayload === 'object' ? options.costPayload : null;
    if (!costPayload && netState.officialCost && (netState.officialCost.session || Object.keys(netState.officialCost.messages || {}).length)) {
      costPayload = {session: netState.officialCost.session, messages: netState.officialCost.messages};
    }
    const costRows = costPayload ? ledgerRowsFromCostMessages(costPayload.messages) : [];
    let ledger = costRows.length
      ? {schema: LEDGER_SCHEMA, rows: costRows, totals: ledgerTotals(costRows)}
      : buildLedger(entries, table, realCosts);
    /* v2.14.0：Agent 会话既没有 token 用量、也没有 /cost 金额时，退到「转录字数估算」——
       行与 token 路径同形，每行带 estimate 标记（正文+thinking 字数 → token × 公开单价）。 */
    if (!costRows.length && !entries.length && netState.transcriptEstimates.length) {
      /* v2.15.0：把**已识别**的模型带进来 —— 指纹认出模型后，估算行才能折出基准价（金额）。
         模型未知（options.model 为空）时行为不变：只报 token、不猜价。 */
      const estimateRows = ledgerRowsFromEstimates(netState.transcriptEstimates, table, {model: options.model || null});
      if (estimateRows.length) ledger = {schema: LEDGER_SCHEMA, rows: estimateRows, totals: ledgerTotals(estimateRows)};
    }
    const totals = ledger.totals;
    /* 会话级聚合（session.actualTotalUsd / chargedTotalUsd / …）只有一条，挂到汇总上。 */
    const sessionDetail = (costPayload && costDetailFromSession(costPayload.session)) || observedCostActual()?.detail || null;
    if (sessionDetail) {
      const fill = (key, value) => { if (totals[key] === null && Number.isFinite(Number(value))) totals[key] = Number(value); };
      fill('charged_usd', sessionDetail.charged_usd);
      fill('credits', sessionDetail.credits);
      fill('multiplier', sessionDetail.multiplier);
      fill('actual_usd', sessionDetail.actual_usd !== null && sessionDetail.actual_usd !== undefined ? sessionDetail.actual_usd : sessionDetail.base_usd);
    }
    const sum = sumUsage(netState.messageUsage.map(entry => entry.usage));
    const candidateIds = Array.isArray(options.candidates) ? options.candidates.filter(id => typeof id === 'string').slice(0, 40) : [];
    const groups = candidateIds.length ? samePriceGroups(candidateIds, table) : [];
    /* 按价反推进花费账本：只比较相同 message_id 的逐条 Arena base 与精确 usage。 */
    let reverse = null;
    const reverseObserved = observedCostActual();
    const reversePair = latestMatchedMessageCostUsage(netState.messageUsage, costPayload);
    if (reversePair) {
      try {
        const loaded = await loadProbeBank();
        const bankIds = (loaded?.bank?.models || []).map(m => m?.id).filter(id => typeof id === 'string');
        if (bankIds.length) {
          const hits = rankByObservedCost(reversePair.base_usd, reversePair.usage, bankIds, table, 6);
          if (hits?.length) {
            const hitGroups = samePriceGroups(hits.map(hit => hit.model_key), table);
            reverse = {
              observed_usd: reversePair.base_usd,
              message_id: reversePair.message_id,
              usage_source: reversePair.usage_source,
              hits,
              same_price_groups: hitGroups.map(group => ({ids: group.ids, ambiguous: group.ids.length > 1})),
              text: `按价反推: ${hits[0].label || hits[0].model_key}（比值 ${hits[0].ratio}${hits[0].complete ? '' : ' · 下界'}）`,
            };
          }
        } else reverse = {blocked: 'no-model-bank', note: '同消息 base 与精确用量已配对，但指纹库没有可排序的模型。'};
      } catch { /* 指纹库没加载出来就不出反推 */ }
    } else {
      const hasMessageUsage = netState.messageUsage.some(entry => entry?.usage);
      const sessionDetail = (costPayload && costDetailFromSession(costPayload.session))
        || costDetailFromSession(netState.officialCost?.session)
        || costDetailFromSession(netState.costRouteSignals[netState.costRouteSignals.length - 1]?.session)
        || observedCostDetail(netState.costSignals);
      const upstreamOnly = Number(sessionDetail?.actual_usd) > 0 && !(Number(sessionDetail?.base_usd) > 0);
      reverse = reverseObserved?.usd
        ? hasMessageUsage
          ? {blocked: 'no-message-pair', note: '已有精确用量和 Arena base，但没有相同 message_id 的逐条配对；不拿会话合计比较单条用量。'}
          : {blocked: 'no-usage', note: '已拿到 Arena base，但 Agent 会话没有逐条 token 用量（会话包不下发）—— 按价反推待命；Battle 模式有用量即自动启用。'}
        : upstreamOnly
          ? {blocked: 'no-base-cost', note: '只拿到上游 actual 成本，没有明确 Arena base；不能与公开模型单价比较。'}
          : {blocked: 'no-observed-cost', note: netState.costGate
          ? `读成本被灰度门拦（/cost 返回 ${netState.costGate.status}）：按价反推需要真实 base 成本。`
          : '未拿到真实 base 成本：按价反推待命（有 /cost 响应即自动启用）。'};
    }
    /* mode 决定浮层怎么解释「为什么有/没有数字」：
       cost-route = 服务端 /cost 给了金额；usage = 有 token 用量可自算 base；blocked = 两者都没有。 */
    const mode = costRows.length ? 'cost-route' : (entries.length ? 'usage' : (ledger.rows.length ? 'estimate' : 'blocked'));
    return {
      table: pricingSummary(table),
      mode,
      cost_rows: costRows.length,
      usage_rows: entries.length,
      estimate_rows: mode === 'estimate' ? ledger.rows.length : 0,
      totals,
      text: describeTotals(totals),
      token_ratio: sum ? tokenRatioText(sum) : null,
      rows: ledger.rows,
      reverse,
      /* v2.16.1 花费反推腿：官方逐条 base ÷ 同消息估算 token（Agent 模式无用量时的反推来路）。 */
      cost_reverse: await costReverseBlock({candidates: candidateIds, costPayload}),
      same_price_groups: groups.map(group => ({
        input_usd_per_mtok: group.input_usd_per_mtok,
        output_usd_per_mtok: group.output_usd_per_mtok,
        ids: group.ids,
        ambiguous: group.ids.length > 1,
      })),
      gate: netState.costGate,
      /* v2.16.0：官方账单是否在位（浮层据此标注口径来源）。 */
      official: netState.officialCost ? {at: netState.officialCost.at, path: netState.officialCost.path, messages: Object.keys(netState.officialCost.messages || {}).length} : null,
      /* v2.15.0：估算会话里实际用来折价的模型（指纹识别结果）；null = 未识别 ⇒ 只报 token。 */
      estimate_model: mode === 'estimate' ? (options.model || null) : null,
      note: mode === 'cost-route'
        ? '金额来自 Arena /cost 路由（服务端权威值，含 base / 实扣 / 倍率；灰度门经 PostHog 覆写 cookie 临时放行，读完即删）。'
        : (mode === 'usage'
          ? '基准价 = Σ token × 公开单价；实扣 = 页面下发的真实成本（有则覆盖）。'
          : (mode === 'estimate'
            ? (options.model
              ? `Agent 会话：Arena 不下发 token 用量 —— 输出侧 token 由转录字数估算（正文+thinking），按**已识别模型** ${options.model} 的公开单价折出基准价。模型来自本扩展的指纹识别；token 是估算值，不是服务端数字。`
              : 'Agent 会话：Arena 不下发 token 用量，也不下发模型（页面 DOM 里也没有）—— 输出侧 token 由转录字数估算（正文+thinking），但**模型未揭晓 ⇒ 不折价**（绝不猜价）。跑一次指纹探测识别出模型后，这里就会自动变成金额。')
            : '本会话既没有 token 用量、也没有 /cost 金额 —— 原因见浮层说明。')),
    };
  } catch (error) {
    return {error: String(error?.message || error)};
  }
}

/* v2.16.1 花费反推：官方逐条 base ÷ 同 message_id 的 Arena 精确用量 = 隐含单价，
   汇总喂给 rankByObservedCost 对候选排序。chars-v1 只估输出文字，缺少历史输入与
   cache-read token；它仍可显示在花费账本，但不能用于模型价格排名。
   与 v2.13.3 账本里的 `reverse` 是同一条腿的两种来路：
   · reverse      —— Battle 模式：最近一条真实 base × 服务端逐条 token 用量；
   · cost_reverse —— Agent 模式：官方逐条 base × 同消息精确 usage。
   诚实在前：缺精确用量就不排名；同价等价类里的模型
   单靠花费区分不开，same_price_groups.ambiguous 如实标注，绝不和稀泥。 */
async function costReverseBlock(options = {}) {
  try {
    const table = arenaPricingTable(await loadPricingTable(), options.pageUrl);
    /* 官方账单：浮层本轮传来的 costPayload 优先（刚探测完 200 的鲜活数据），
       否则 background 缓存的 netState.officialCost（弹窗路径不传 payload，靠缓存）。 */
    const payload = options.costPayload && typeof options.costPayload === 'object' ? options.costPayload : null;
    const cached = netState.officialCost && netState.officialCost.messages && Object.keys(netState.officialCost.messages).length
      ? {session: netState.officialCost.session, messages: netState.officialCost.messages}
      : null;
    const official = payload && Object.keys(payload.messages || {}).length
      ? {session: payload.session || null, messages: payload.messages}
      : cached;
    if (!official) {
      return {
        blocked: 'no-official-cost',
        note: netState.costGate
          ? `读成本被灰度门拦（/cost 返回 ${netState.costGate.status}）：花费反推需要官方逐条 base 金额；门过不去时只能给候选区分度与同价等价类。`
          : '还没有官方逐条账单（/api/chat/:id/cost）：花费反推待命 —— 打开花费账本浮层即会自动读取（临时覆写 PostHog cookie，读完即删）。',
      };
    }
    const mediaCostCount = nonTokenMediaCostCount(official.messages);
    if (mediaCostCount) {
      return {blocked: 'non-token-media-cost', note: nonTokenMediaCostNote(mediaCostCount), n_non_token_media_cost: mediaCostCount};
    }
    /* v2.19.9：候选与**硬筛选腿**都不依赖「账单↔用量能否配对」，先算好 ——
       配对失败时也照样把费率族报出来（用户反馈「还是获取不到模型」）。
       池子：给了候选就用候选，否则扫**整张单价表**（不被 21 个模型的指纹库框住）。 */
    const requested = Array.isArray(options.candidates) ? options.candidates.filter(id => typeof id === 'string') : [];
    const given = [...new Set(requested)].filter(id => table.resolve(id).length);
    if (requested.length && !given.length) return {blocked: 'no-candidates', note: '数字候选未匹配当前模式的 Arena 价目，不能扩大到其他模式猜测。'};
    const {hardOut, rateFamily} = await hardFamily(table, given.length ? given : [], options.costPayload);
    const familyFields = rateFamily ? {
      evidence: 'rate-family',
      evidence_label: rateFamily.price_source === 'arena-battle-observed' ? 'Battle 实测优先旁证（非定名）' : '费率族（费率结构）',
      hard_filter: hardOut,
      rate_family: rateFamily,
      text: blockedRateFamilyText(rateFamily),
    } : {hard_filter: hardOut};

    const paired = pairCostWithUsage(official.messages, netState.messageUsage, netState.transcriptEstimates);
    if (!paired.n_pairs) {
      return {
        blocked: 'no-pairs',
        note: `官方逐条 base ${Object.keys(official.messages).length} 条与同 message_id 用量没配上对（Arena 精确 usage 可用于价格比较，chars-v1 只作账本估算；账单侧落单 ${paired.cost_only.length} 条 / 估算侧落单 ${paired.estimate_only.length} 条）。`,
        n_cost_only: paired.cost_only.length,
        n_estimate_only: paired.estimate_only.length,
        ...familyFields,
      };
    }
    if (!paired.exact_usage) {
      return {
        blocked: 'estimate-only',
        note: `已配对 ${paired.n_pairs} 条账单，但只有 chars-v1 转录估算；缺少历史输入和缓存 token，不能据此做可信的价格排名。`,
        n_pairs: paired.n_pairs,
        exact_usage: false,
        ...familyFields,
      };
    }
    /* 候选：调用方给缩小范围（指纹候选）；否则指纹库全量（v2.13.3 同口径）。 */
    let ids = given;
    if (!ids.length) {
      ids = table.text().map(profile => profile.model_key);
    }
    /* Price fingerprint must score the full supplied scope before claiming uniqueness;
       ordinary cost-reverse keeps its compact top-8 result. */
    const allHits = ids.length ? rankByObservedCost(paired.total_base_usd, paired.usage, ids, table, ids.length) : null;
    const hits = options.fullPriceRanking === true ? allHits : allHits?.slice(0, 8);
    const ratesComplete = !!allHits?.length && allHits.length === ids.length && allHits.every(hit => hit.complete === true);
    if (!hits?.length) {
      return {blocked: 'no-priced', note: 'Arena 官方费率不足以折算候选成本；缺失字段保持未知，不使用 OpenRouter 补价定名。'};
    }
    const groups = samePriceGroups(hits.map(hit => hit.model_key), table);
    const implied = paired.total_tokens > 0 ? Number((paired.total_base_usd / paired.total_tokens * 1e6).toFixed(4)) : null;
    return {
      observed_usd: paired.total_base_usd,
      token_count: paired.total_tokens,
      estimated_tokens: paired.exact_usage ? null : paired.total_tokens,
      implied_usd_per_mtok: implied,
      usage_source: paired.usage_source,
      exact_usage: paired.exact_usage,
      n_pairs: paired.n_pairs,
      n_cost_only: paired.cost_only.length,
      n_estimate_only: paired.estimate_only.length,
      hits,
      rates_complete: ratesComplete,
      ranking_complete: hits.length === allHits.length,
      pricing_policy: table.pricing_policy,
      pricing_source: table.source,
      pricing_fetched_at: table.fetched_at,
      same_price_groups: groups.map(group => ({ids: group.ids, ambiguous: group.ids.length > 1})),
      hard_filter: hardOut,
      rate_family: rateFamily,
      text: `花费反推: ${hits[0].label || hits[0].model_key}（比值 ${hits[0].ratio}${hits[0].complete ? '' : ' · 下界'} · 隐含 $${implied}/Mtok · ${paired.n_pairs} 对配对）`,
      note: `口径：金额是官方逐条 base；费率按 Battle 稳定实测 > Arena 官方参考 > OpenRouter 公开价兜底；token 来源为 ${paired.exact_usage ? '同 message_id 的 Arena 精确 usage' : 'chars-v1 转录字符估算（弱证据）'}。${ratesComplete ? '' : '部分候选缺少本次计费所需费率，成本仅为下界，不能认定唯一。'}这里只作可能性排序；同价模型单靠花费区分不开。`,
    };
  } catch (error) {
    return {error: String(error?.message || error)};
  }
}

/* v2.17.0 价格指纹通道：把「花费反推」的排序收窄到**识别候选集**内，回答一个更硬的问题 ——
   这批候选里，价格能不能把它切成**唯一一个**？

   与 costReverseBlock（全库排序、只作旁证）的区别：
   · costReverseBlock  —— 候选为空时全库排序，输出「可能性排序」，绝不单独定名；
   · priceFingerprintBlock —— 候选来自指纹识别的 top3/置信集，输出 `separable` 判据：
       命中唯一 + 比值贴合（|log ratio| 阈值内）+ 无同价歧义 ⇒ 允许**单独定名**（用户明确要求）。

   允许单独定名的条件（全部满足，缺一不可）：
   1. 比值腿优先用按 message_id 配对的 Arena 精确 usage；chars-v1 转录估算仅作弱排序旁证，不能独立触发定名；
   2. 候选内**只有一个**模型的期望成本落进比值窗口（`PRICE_FINGERPRINT_RATIO` 内），
      第二名明显更远 —— 也就是说价格确实把候选切开了；
   3. 该命中不与任何其他候选同价（同价等价类单靠价格区分不开，禁止定名）。
   任何一条不满足都如实降级，`separable:false` + `reason` 说明卡在哪。

   ★ v2.19.5 修两个实测出来的缺陷（用户反馈「定名 claude-sonnet-4-6，但 Arena 基本没这个模型」）：
   ① **刻度错位**：`z` 的除数必须与 pricing-channel 一致（`ln(CONSISTENT_RATIO)=ln1.6`）。
      此前除数误写成 `Math.log(2)`，两个刻度差 1.47 倍 —— 使 `PRICE_FINGERPRINT_Z = 0.8`
      实际等效 1.18，**比注释里说的「相符界 1.0 更严」反而更松**，允许比值 [0.574, 1.741]
      （偏差 −43%~+74%）都算「贴合」。实测因此把比值 0.841（偏差 16%）的模型误报成唯一命中。
   ② **没数窗口**：注释写的是「只有一个模型落进阈值」，实现却只比 top1/top2 的 z 差，
      **从未统计窗口里有几个**。实测该账单在全库有 **14 个模型**落在 ±15% 内，
      却被标成「全库 208 个模型里只此一个贴合」。现在真的数一遍（`uniqueInWindow`）。
   窗口与间距一律用**比值**表达再换算成 z，避免再次写错刻度。 */
const PRICE_FINGERPRINT_RATIO = 1.10;   // 贴合窗口：比值 ∈ [1/1.1, 1.1]（约 ±10%）
const PRICE_FINGERPRINT_GAP_RATIO = 1.25;   // 第二名比值至少再差 25% 才算「明显更远」
const PRICE_FINGERPRINT_Z = Math.log(PRICE_FINGERPRINT_RATIO) / Math.log(CONSISTENT_RATIO);
const PRICE_FINGERPRINT_GAP = Math.log(PRICE_FINGERPRINT_GAP_RATIO) / Math.log(CONSISTENT_RATIO);

/* v2.18.0「价格指纹」独立识别模式：候选集为空时**不报 no-candidates，而是全库裁决**。
   与候选集路径的区别只在候选来源：
   · 候选集路径（识别主流程的并行通道）—— 候选由数字指纹给出，价格在小范围里裁决；
   · 全库路径（识别模式选「价格指纹」）—— 用户明确只用价格识别，不借数字候选，
     直接在 Arena 官方单价表的文本模型里比价（排除按张/秒计价的媒体模型，不依赖数字指纹库）。
   全库比价「无数个价格都贴近」的概率天然更高，所以三条判据（贴合阈值 / 拉不开距离 /
   同价歧义）一条都不能松 —— 这正是 separable 存在的意义：宁可说不确定，也不猜。

   v2.19.0 新增**硬筛选腿**（借鉴参考扩展 cost-browser-extension 的整数反推）：
   把 /cost 账单的**四项分项费用**（input/output/cacheWrite/cacheRead）按各模型单价
   反推 token 数，要求为正整数 —— 能整除的模型才留。这是硬约束，比 log 比值软判据硬得多。

   但**硬筛选不能单独定名**，原因有二（均为实测结论）：
   ① 硬筛选对价格口径极度敏感。实测会话真身是 GPT 5.6 Luna，但 Luna 的 out 费率 1.2
      反推 605.87（非整数）被淘汰，反倒是 qwen3.7-plus 的 1.28 反推 568.00 恰好整除 → 误判。
      根因：Arena 实际计费口径与 OpenRouter 挂牌价存在差值（见 tools/build-cache-rates.mjs）。
   ② 候选命中依赖费率表「恰好整除」，本质是数值巧合的筛选，不是语义识别。
   所以本函数把硬筛选当**强旁证**：硬筛选唯一解 + 软判据同指一个模型 → 高置信定名（evidence:'both'）；
   两者分歧 → 如实报 `conflict` 且 **separable:false**（绝不凭硬筛选推翻软判据）。 */
/** 按**四项费率签名**给硬筛选候选分组（v2.19.7）。
 *  费率完全相同的模型属于同一「费率族」—— 单看账单**永远**区分不开，只能报到族这一级。
 *  代表组先按 Battle > 官方 > OpenRouter，再按成员数降序；组内也遵循同一来源优先级。
 *  这里只决定「优先展示哪组」，不会把来源优先级当作身份识别证据。 */
function rateSignatureGroups(candidates) {
  const map = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const rates = candidate?.rates || {};
    const sig = [rates.input, rates.output, rates.cache_write, rates.cache_read].join('|');
    if (!map.has(sig)) map.set(sig, {rates, counts: candidate?.counts || null, models: []});
    map.get(sig).models.push(candidate);
  }
  const groups = [...map.values()];
  for (const group of groups) {
    group.models.sort((a, b) => pricingSourcePriority(a.price_source) - pricingSourcePriority(b.price_source));
  }
  const isSubmultipleCounts = (subCounts, baseCounts) => {
    if (!subCounts || !baseCounts) return false;
    let hasPositive = false;
    let anyStrictlyLarger = false;
    for (const k of ['I', 'O', 'W', 'R']) {
      const a = Number(baseCounts[k]) || 0;
      const b = Number(subCounts[k]) || 0;
      if (a === 0 && b === 0) continue;
      if (a <= 0 || b < a) return false;
      const ratio = b / a;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-6) return false;
      hasPositive = true;
      if (Math.round(ratio) >= 2) anyStrictlyLarger = true;
    }
    return hasPositive && anyStrictlyLarger;
  };
  for (const group of groups) {
    const prio = pricingSourcePriority(group.models[0]?.price_source);
    group.submultipleDepth = groups.filter(other =>
      other !== group &&
      pricingSourcePriority(other.models[0]?.price_source) <= prio &&
      isSubmultipleCounts(group.counts, other.counts)
    ).length;
  }
  return groups.sort((a, b) =>
    pricingSourcePriority(a.models[0]?.price_source) - pricingSourcePriority(b.models[0]?.price_source)
    || (a.submultipleDepth || 0) - (b.submultipleDepth || 0)
    || b.models.length - a.models.length);
}

function blockedRateFamilyText(rateFamily) {
  if (!rateFamily) return '';
  const lead = rateFamily.price_source === 'arena-battle-observed'
    ? 'Battle 实测优先旁证指向'
    : rateFamily.price_source === 'arena-official' ? 'Arena 官方费率旁证指向' : 'OpenRouter 兜底费率旁证指向';
  return `价格指纹: ${lead} ${rateFamily.text}；但硬筛选仍有 ${rateFamily.members} 个候选、${rateFamily.groups} 个费率组，缺少同 message_id 的 Arena 精确 usage，不能唯一定名`;
}

/** 跑硬筛选腿并整理成「费率族」结论（v2.19.9 抽出，供价格指纹与花费反推两处复用）。
 *  `ids` 传空数组 = 扫**整张单价表**（费率结构问题是「这份账单像谁」，不该被 21 个模型的
 *  指纹库框住）。返回 `{hard, hardOut, rateFamily}`。 */
async function hardFamily(table, ids, costPayload) {
  const hard = await hardFilterLeg(table, ids, costPayload);
  const rateGroups = hard && hard.candidates.length ? rateSignatureGroups(hard.candidates) : [];
  const topGroup = rateGroups[0] || null;
  const topNames = topGroup ? topGroup.models.map(m => m.display || m.model_key) : [];
  const rateFamily = topGroup ? {
    members: hard.candidates.length,
    groups: rateGroups.length,
    rates: topGroup.rates,
    price_source: topGroup.models[0]?.price_source || null,
    models: topGroup.models.map(m => ({model_key: m.model_key, display: m.display || m.model_key, price_source: m.price_source || null})),
    text: `${topNames.slice(0, 4).join(' / ')}${topNames.length > 4 ? ` 等 ${topNames.length} 个` : ''}（费率完全相同：in $${topGroup.rates.input} / out $${topGroup.rates.output}${topGroup.rates.cache_read != null ? ` / cache读 $${topGroup.rates.cache_read}` : ''} 每 Mtok）`,
  } : null;
  const hardOut = hard ? {
    state: hard.state,
    candidates: hard.candidates.map(c => ({model_key: c.model_key, display: c.display, counts: c.counts, price_source: c.price_source || null, cache_rate_source: c.cache_rate_source, cache_rate_batch: c.cache_rate_batch})),
    partial: hard.partial.length,
    partial_candidates: hard.partial.map(c => ({model_key: c.model_key, display: c.display || c.model_key,
      counts: c.counts, missing_rates: c.missing_rates, rates_complete: false,
      price_source: table.profile(c.model_key)?.price_source || null})),
    same_price_groups: hard.same_price_groups,
    excluded_media: hard.excluded_media,
    checked_models: hard.checked_models,
    uses_batch_rate: hard.uses_batch_rate,
    note: hard.note,
  } : null;
  return {hard, hardOut, rateFamily};
}

/** A fail-open sidecar: never changes the hard pool, usage flags, bill selection or main result. */
function agentPriceOutputHint(table, hard, options) {
  const probeId = options.priceProbeId;
  if (typeof probeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(probeId)) return null;
  const fallback = {state: 'not-observed', can_suggest: false, separable: false, exact_usage: false,
    calibrated: false, ranked: [], groups: [], n_pairs: 0,
    note: '本轮可选输出旁证未采到或尚未配对，沿用原识别结果；不拦截原结果、不借旧消息猜测。名称仅是本次探针的候选，不确认此会话后续回复的模型。'};
  const records = new Map((Array.isArray(netState.agentPriceOutputs) ? netState.agentPriceOutputs : [])
    .filter(row => row?.price_probe_id === probeId && typeof row.message_id === 'string')
    .map(row => [row.message_id, row]));
  const costs = options.costPayload?.messages || netState.officialCost?.messages || {};
  const samples = [];let incomplete = false;
  for (const [id, row] of records) {
    const cost = Object.prototype.hasOwnProperty.call(costs, id) ? costs[id] : null;
    const breakdown = normalizeCostBreakdown(cost);
    const built = estimateUsageFromStats({text: row.chars});
    if (!built || !breakdown || !(breakdown.output_usd > 0) || breakdown.is_fallback
      || breakdown.total_consistent === false || breakdown.has_non_token_media_cost
      || cost?.isLongContext || cost?.actual?.isLongContext) { incomplete = true;continue; }
    samples.push({tokens: built.usage.outputTokens, low: built.estimate.output_range.low,
      high: built.estimate.output_range.high, chars: built.estimate.chars.text,
      reasoning_chars: Number(row.reasoning_chars) || 0,
      output_usd: breakdown.output_usd, unobserved: Number(row.unobserved_parts) || 0});
  }
  if (!samples.length) return fallback;
  const total = samples.reduce((sum, row) => ({tokens: sum.tokens + row.tokens, low: sum.low + row.low,
    high: sum.high + row.high, chars: sum.chars + row.chars, output_usd: sum.output_usd + row.output_usd,
    reasoning_chars: sum.reasoning_chars + row.reasoning_chars,
    unobserved: sum.unobserved + row.unobserved}), {tokens: 0, low: 0, high: 0, chars: 0, output_usd: 0, reasoning_chars: 0, unobserved: 0});
  const ranked = [];
  const seen = new Set();
  const isValidSubmultiple = (subCounts, baseCounts) => {
    if (!subCounts || !baseCounts) return false;
    let hasPositive = false;
    let anyStrictlyLarger = false;
    for (const k of ['I', 'O', 'W', 'R']) {
      const a = Number(baseCounts[k]) || 0;
      const b = Number(subCounts[k]) || 0;
      if (a === 0 && b === 0) continue;
      if (a <= 0 || b < a) return false;
      const r = b / a;
      if (Math.abs(r - Math.round(r)) > 1e-6) return false;
      hasPositive = true;
      if (Math.round(r) >= 2) anyStrictlyLarger = true;
    }
    return hasPositive && anyStrictlyLarger;
  };
  const computeSingleSampleDist = (samplesMeta, isThinkingName, implied, ratio) => {
    const rawOutToVis = Number(samplesMeta?.output_to_visible_p50);
    const shortOutToVis = Number(samplesMeta?.short_output_to_visible_p50);
    const longOutToVis = Number(samplesMeta?.long_output_to_visible_p50);
    const effOutToVis = total.tokens >= 500
      ? (Number.isFinite(longOutToVis) ? longOutToVis : rawOutToVis)
      : (total.tokens < 16 && Number.isFinite(shortOutToVis) ? shortOutToVis : rawOutToVis);
    const reasP50 = Number(samplesMeta?.reasoning_tokens_p50);
    const hasEmpiricalReasoning = (Number.isFinite(reasP50) && reasP50 > 4) || (Number.isFinite(effOutToVis) && effOutToVis > 1.15);
    const hasSufficientSamples = samplesMeta && Number(samplesMeta.messages) >= 2 && (Number.isFinite(effOutToVis) || Number.isFinite(reasP50));
    const hasHiddenReasoning = !(total.reasoning_chars > 0) && (hasEmpiricalReasoning || (!hasSufficientSamples && isThinkingName));
    if (!(total.reasoning_chars > 0) && samplesMeta && Number(samplesMeta.messages) >= 1) {
      const addReas = Number.isFinite(reasP50) && reasP50 > 0 ? reasP50 : 0;
      const maxLongSlope = total.tokens >= 500
        ? (Number.isFinite(longOutToVis) ? 4.5 : 1.75)
        : 3.2;
      const minLongSlope = total.tokens >= 500 && Number.isFinite(longOutToVis) ? 1.15 : 1.8;
      const longSlope = hasHiddenReasoning
        ? Math.min(Math.max(Number.isFinite(effOutToVis) ? effOutToVis : 1.8, minLongSlope), maxLongSlope)
        : (Number.isFinite(effOutToVis) && effOutToVis > 0 ? Math.min(Math.max(effOutToVis, 0.85), 1.15) : 1.0);
      const expected = hasHiddenReasoning
        ? Math.max(total.tokens + addReas, total.tokens * longSlope)
        : total.tokens * longSlope;
      const lowBound = Math.max(1, total.tokens * (hasEmpiricalReasoning && total.tokens >= 50 ? 0.90 : 0.78));
      const highBound = hasHiddenReasoning ? Math.max(expected * 2.2, total.tokens * 6) : total.tokens * 1.25 + 4;
      const directDist = Math.abs(Math.log((implied + 3) / (total.tokens * 0.92 + 3))) * 0.45;
      const targetDist = Math.abs(Math.log((implied + 3) / (expected + 3))) * (hasHiddenReasoning ? 0.35 : 0.70);
      const centerDist = hasHiddenReasoning && implied >= lowBound && implied <= expected
        ? Math.min(directDist, targetDist, 0.14 + targetDist * 0.35)
        : targetDist;
      const rangeDist = implied < lowBound
        ? Math.abs(Math.log(implied / lowBound))
        : (implied > highBound ? Math.log(implied / highBound) : 0);
      const missingLongPenalty = total.tokens >= 500 && !Number.isFinite(longOutToVis) ? 0.03 : 0;
      return centerDist + rangeDist + missingLongPenalty;
    }
    const outToVis = isThinkingName ? 6 : 1;
    const refLow = total.tokens;
    const refHigh = hasHiddenReasoning ? Math.max(total.tokens * outToVis, total.tokens + 180) : total.tokens;
    return !hasHiddenReasoning || implied <= refLow
      ? Math.abs(Math.log((implied + 3) / (total.tokens + 3)))
      : (implied <= refHigh
        ? Math.log(Math.max(1, ratio)) * 0.28 + 0.06
        : Math.log(refHigh / refLow) * 0.28 + Math.log(implied / refHigh));
  };
  const viableCompleteBases = (hard?.candidates || []).filter(c => {
    const r = Number(c?.rates?.output);
    if (!(r > 0)) return false;
    const imp = (total.output_usd * 1e6) / r;
    const rawO2V = Number(c?.observed_samples?.long_output_to_visible_p50 ?? c?.observed_samples?.output_to_visible_p50);
    const minRatio = (Number.isFinite(rawO2V) && rawO2V > 1.25) ? 0.94 : (total.tokens >= 200 ? 0.85 : 0.72);
    return imp >= Math.max(1, total.tokens * minRatio - 2);
  });
  for (const candidate of [...(hard?.candidates || []), ...(hard?.partial || [])]) {
    if (seen.has(candidate.model_key)) continue;
    seen.add(candidate.model_key);
    const profile = table.profile(candidate.model_key);
    const rate = candidate.rates?.output ?? profile?.output_usd_per_mtok;
    if (!(typeof rate === 'number' && Number.isFinite(rate) && rate > 0)) continue;
    const implied = total.output_usd * 1e6 / rate, ratio = implied / total.tokens;
    if (!Number.isFinite(implied) || !(ratio > 0)) continue;
    const missing = Array.isArray(candidate.missing_rates) ? [...candidate.missing_rates] : [];
    const samplesMeta = candidate.observed_samples || profile?.battle_observed_samples || null;
    const nameHint = `${String(candidate.model_key || '')} ${String(candidate.display || '')}`;
    const isThinkingName = /(?:^|[- (\b])(?:thinking|reasoner|high|max|xhigh|heavy|pro-preview)(?:$|[- )\b])/i.test(nameHint)
      && !/non-thinking|no-thinking|minimal/i.test(nameHint);
    const tiers = Array.isArray(samplesMeta?.tier_samples) && samplesMeta.tier_samples.length
      ? samplesMeta.tier_samples
      : [samplesMeta];
    const rawDist = Math.min(...tiers.map(t => computeSingleSampleDist(t, isThinkingName, implied, ratio)));
    const nonThinkingPenalty = (total.reasoning_chars > 0 && Number(samplesMeta?.messages) >= 2 && Number(samplesMeta?.reasoning_tokens_p50) === 0) ? 0.5 : 0;
    const priceSource = candidate.price_source || profile?.price_source || null;
    const fallbackSourcePenalty = priceSource === 'openrouter-public' ? 0.35 : (priceSource === 'arena-official' ? 0.08 : 0);
    const candPrio = pricingSourcePriority(priceSource);
    const isSubmultiple = missing.length === 0 && candidate.counts && viableCompleteBases.some(other => {
      if (other === candidate || pricingSourcePriority(other.price_source) > candPrio) return false;
      if (!isValidSubmultiple(candidate.counts, other.counts)) return false;
      const otherProfile = table.profile(other.model_key);
      const otherRate = other.rates?.output ?? otherProfile?.output_usd_per_mtok;
      const otherImp = total.output_usd * 1e6 / otherRate, otherRatio = otherImp / total.tokens;
      const otherMeta = other.observed_samples || otherProfile?.battle_observed_samples || null;
      const otherHint = `${String(other.model_key || '')} ${String(other.display || '')}`;
      const otherThink = /(?:^|[- (\b])(?:thinking|reasoner|high|max|xhigh|heavy|pro-preview)(?:$|[- )\b])/i.test(otherHint)
        && !/non-thinking|no-thinking|minimal/i.test(otherHint);
      const otherTiers = Array.isArray(otherMeta?.tier_samples) && otherMeta.tier_samples.length ? otherMeta.tier_samples : [otherMeta];
      const otherRawDist = Math.min(...otherTiers.map(t => computeSingleSampleDist(t, otherThink, otherImp, otherRatio)));
      return otherRawDist <= rawDist + 0.06;
    });
    const submultiplePenalty = isSubmultiple ? 0.16 : 0;
    const distance = rawDist + nonThinkingPenalty + fallbackSourcePenalty + submultiplePenalty;
    ranked.push({model_key: candidate.model_key, label: candidate.display || candidate.model_key,
      price_source: priceSource, output_usd_per_mtok: rate,
      rates_complete: missing.length === 0, missing_rates: missing,
      implied_output_tokens: implied, visible_ratio: ratio, distance});
  }
  ranked.sort((a, b) => a.distance - b.distance || pricingSourcePriority(a.price_source) - pricingSourcePriority(b.price_source)
    || String(a.model_key).localeCompare(String(b.model_key)));
  const groups = [];
  for (const item of ranked) {
    let group = groups.find(group => group.output_usd_per_mtok === item.output_usd_per_mtok);
    if (!group) { group = {output_usd_per_mtok: item.output_usd_per_mtok,
      implied_output_tokens: item.implied_output_tokens, visible_ratio: item.visible_ratio, models: []};groups.push(group); }
    group.models.push(item);
  }
  const best = ranked[0];
  const bestSamples = best ? (table.profile(best.model_key)?.battle_observed_samples || null) : null;
  const bestMultiplier = Math.max(2, (Number(bestSamples?.output_to_visible_p50) || 1) * 4);
  const canSuggest = !incomplete && samples.length === records.size && total.unobserved === 0
    && total.tokens >= 1 && total.chars >= 2 && !!best
    && best.implied_output_tokens >= Math.max(1, total.low / 4)
    && best.implied_output_tokens <= Math.max(total.high * bestMultiplier, 4096);
  return {...fallback, state: canSuggest ? 'available' : 'display-only', can_suggest: canSuggest,
    ranked, groups, n_pairs: samples.length, visible_output_tokens: total.tokens,
    visible_output_range: {low: total.low, high: total.high}, unobserved_parts: total.unobserved,
    note: `本轮 ${samples.length} 条同消息费用与可见正文/思考/工具参数配对，输出参考约 ${total.tokens}t。${canSuggest ? '仅在勾选“只取最接近”时辅助选代表项。' : '采集不完整、样本过短或偏差过大，仅展示，不改变原选择。'}完整与缺价未排除候选都可比较已知输出单价；缺价项不冒充完整匹配。仅描述本次探针，不确认此会话后续回复的模型。隐藏推理未知；Battle 费率移用于 Agent 尚未校准，同输出单价不分型号，参考带不是计费上下界或置信区间。`};
}

async function priceFingerprintBlock(candidates, options = {}) {
  try {
    const table = arenaPricingTable(await loadPricingTable(), options.pageUrl);
    const requested = Array.isArray(candidates) ? candidates.filter(id => typeof id === 'string') : [];
    let ids = [...new Set(requested)].filter(id => table.resolve(id).length);
    let scope = 'candidates';
    if (!requested.length && options.fullBank === true) {
      /* 全库模式遵循同一费率优先级；OpenRouter 只补 Battle/官方都没有的 key。 */
      ids = table.all().filter(profile => profile.kind !== 'media').map(profile => profile.model_key);
      scope = 'full-bank';
    }
    if (!ids.length) return {separable: false, reason: 'no-candidates', note: '没有候选（指纹识别未给出候选集），价格指纹无从收窄。'};
    /* v2.19.8：硬筛选腿只依赖**账单的分项费用**，与「账单↔估算能否配对」无关 —— 所以先跑它。
       此前配对失败就整条 return，面板只剩一句「没法配对」、候选列表全空（用户反馈「直接不显示了」），
       而参考扩展在这种账单上照样给得出答案。现在配对失败也把**费率族**报出来。 */
    const mediaCostCount = nonTokenMediaCostCount(options.costPayload?.messages || netState.officialCost?.messages);
    if (mediaCostCount) {
      const note = nonTokenMediaCostNote(mediaCostCount);
      return {
        separable: false, exact_usage: false, blocked: 'non-token-media-cost', reason: 'non-token-media-cost',
        note, text: `价格指纹: ${note}`, scope, arena_only: false, evidence: 'none', evidence_label: '',
        hard_filter: {state: 'non-token-media-cost', candidates: [], partial: 0, excluded_media: 0, checked_models: 0, note},
        rate_family: null,
      };
    }
    const {hard, hardOut, rateFamily} = await hardFamily(table, ids, options.costPayload);
    let agentPriceHint = null;
    try {
      agentPriceHint = agentPriceOutputHint(table, hard, options);
      const waitMs = Math.max(0, Math.min(3000, Number(options.agentHintWaitMs) || 0));
      for (let remaining = waitMs; agentPriceHint?.state === 'not-observed' && remaining > 0; remaining -= 250) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)));
        agentPriceHint = agentPriceOutputHint(table, hard, options);
      }
    } catch { /* missing evidence, timeout or auxiliary errors never block the original result */ }

    /* This path needs every scored candidate for the ±10% uniqueness test. */
    const base = await costReverseBlock({candidates: ids, costPayload: options.costPayload, pageUrl: options.pageUrl, fullPriceRanking: true});
    if (!base || base.blocked) {
      /* 配对不上也照样报费率族 —— 它是纯账单分项推出来的，不需要估算 token。 */
      return {
        separable: false,
        reason: base?.blocked || 'no-cost',
        note: [
          base?.note || '没能拿到官方 base 账单 / 同消息 token usage，价格指纹待命。',
          '⚠️ 比值判据需要与逐条账单配对的 Arena 精确 token 用量；chars-v1 只估输出文字，本次不能用于比价。',
        ].filter(Boolean).join(' '),
        scope,
        arena_only: false,
        evidence: rateFamily ? 'rate-family' : 'none',
        evidence_label: rateFamily ? (rateFamily.price_source === 'arena-battle-observed' ? 'Battle 实测优先旁证（非定名）' : '费率族（费率结构）') : '',
        hard_filter: hardOut,
        rate_family: rateFamily,
        agent_price_hint: agentPriceHint,
        text: rateFamily
          ? blockedRateFamilyText(rateFamily)
          : `价格指纹: 暂无可用的价格证据（${base?.note || '账单与用量没配上对'}）`,
      };
    }
    const rankedHits = base.hits || [];
    if (!rankedHits.length) return {separable: false, reason: 'no-priced', note: '候选里没有可折价模型。', scope};
    /* 刻度与 pricing-channel 一致：除数用 ln(CONSISTENT_RATIO)，不是 ln2（v2.19.5 修）。 */
    const zOf = hit => Number.isFinite(Number(hit.ratio)) && Number(hit.ratio) > 0
      ? Math.abs(Math.log(Number(hit.ratio))) / Math.log(CONSISTENT_RATIO) : Infinity;
    const best = rankedHits[0];
    const runnerUp = rankedHits[1] || null;
    const bestZ = zOf(best);
    const within = bestZ <= PRICE_FINGERPRINT_Z;
    const separated = !runnerUp || zOf(runnerUp) > bestZ + PRICE_FINGERPRINT_GAP;   // 第二名要明显更远
    /* v2.19.5：必须数完整候选范围内落窗的模型；top-8 展示截断不能参与唯一性判断。 */
    const withinHits = rankedHits.filter(hit => zOf(hit) <= PRICE_FINGERPRINT_Z);
    const uniqueInWindow = withinHits.length === 1;
    const bestKey = best.model_key;
    const windowGroups = withinHits.length
      ? samePriceGroups(withinHits.map(hit => hit.model_key), table).map(group => ({
          ids: group.ids,
          ambiguous: group.ids.length > 1,
          input_usd_per_mtok: group.input_usd_per_mtok,
          output_usd_per_mtok: group.output_usd_per_mtok,
          cache_write_usd_per_mtok: group.cache_write_usd_per_mtok,
          cache_read_usd_per_mtok: group.cache_read_usd_per_mtok,
          cache_rate_source: group.cache_rate_source,
        }))
      : [];
    const ambiguousGroup = windowGroups.find(group => group.ambiguous && group.ids.includes(bestKey));
    const exactUsage = base.exact_usage === true;
    const allRatesComplete = base.rates_complete === true;
    const softSeparable = exactUsage && allRatesComplete && best.complete === true && within && separated && uniqueInWindow && !ambiguousGroup;
    const reasons = [];
    if (!allRatesComplete) reasons.push('候选存在缺失的官方费率或无法折价项，不能把未知候选排除后宣称唯一');
    if (best.complete !== true) reasons.push('命中候选费率不完整，期望成本只是下界，不能定名');
    if (!exactUsage) reasons.push('本次只有 chars-v1 转录字符估算（弱证据），不能独立触发模型定名');
    if (!within) reasons.push(`最贴近的 ${best.label || bestKey} 比值 ${best.ratio} 超出贴合窗口（±${Math.round((PRICE_FINGERPRINT_RATIO - 1) * 100)}%）`);
    else if (!uniqueInWindow) reasons.push(`贴合窗口内有 ${withinHits.length} 个模型（${withinHits.slice(0, 3).map(hit => `${hit.label || hit.model_key} ${hit.ratio}`).join('、')}）—— 价格切不开`);
    if (!separated) reasons.push(`与第二名 ${runnerUp.label || runnerUp.model_key}（比值 ${runnerUp.ratio}）拉不开距离`);
    if (ambiguousGroup) reasons.push(`命中与 ${ambiguousGroup.ids.filter(id => id !== bestKey).join('/')} 同价，价格区分不开`);

    /* 硬筛选腿与费率族已在函数开头算好（v2.19.8 提前，好让配对失败时也能报出来）。 */
    /* rateFamily 只是按来源优先级挑出的展示组，不能代表全部合法硬筛选候选。 */
    const softInFamily = !!hard?.candidates?.some(m =>
      baseModelName(m.model_key) === baseModelName(best.matched_key || bestKey));

    /* 交叉验证：硬筛选唯一解与软判据是否同指一个模型（按基础名比对，容忍变体 key 差异）。
       evidence='both' 的前提是**两条腿都成立且同指** —— 光硬筛选指对了、软判据自己没切开，
       不能算「一致」，只能算旁证（hard-hint）。否则会把「软判据没切开」误报成高置信。 */
    let evidence = softSeparable ? 'soft-ratio' : 'none';
    let conflict = null;
    if (hard && hard.state === 'unique' && hard.candidates.length === 1) {
      const hardBase = baseModelName(hard.candidates[0].model_key);
      const softBase = baseModelName(bestKey);
      if (softSeparable && hardBase === softBase) {
        evidence = 'both';           // 两条独立证据都成立且同指 —— 可定名，置信最高
      } else if (softSeparable) {
        evidence = 'conflict';       // 软判据说 A、硬筛选说 B —— 定名分歧，一律不定名
        conflict = {soft: bestKey, soft_label: best.label || bestKey, hard: hard.candidates[0].model_key, hard_label: hard.candidates[0].display || hard.candidates[0].model_key};
        reasons.push(`硬筛选（整数反推）指向 ${conflict.hard_label}，与软判据（比值）指向的 ${conflict.soft_label} 分歧`);
      } else {
        /* 软判据本来就切不开（within/separated/同价任一不满足），硬筛选给出的唯一解是**新的**收窄信息，
           但仍不足以定名（唯一解可能是费率巧合，实测已见误判），所以只作旁证记下。 */
        evidence = 'hard-hint';
      }
    } else if (hard && hard.state === 'multiple') {
      /* v2.19.7：多个模型能整除。若软判据的命中**不在**硬筛选候选里 —— 它已被费率结构否掉
         （实测会错选贵一个数量级的模型），按「以费率结构为准」视为**分歧**，绝不据它定名。 */
      if (softSeparable && !softInFamily) {
        evidence = 'conflict';
        conflict = {soft: bestKey, soft_label: best.label || bestKey, hard: null, hard_label: rateFamily ? rateFamily.models.map(m => m.display).join(' / ') : null};
        reasons.push(`软判据（比值）指向 ${conflict.soft_label}，但费率结构（整数反推）指向另一族（${conflict.hard_label}）—— 分歧，不定名`);
      } else {
        evidence = softSeparable ? 'soft-ratio' : 'rate-family';
      }
      reasons.push(`硬筛选有 ${hard.candidates.length} 个模型能整除账单，切不开`);
    }
    /* 比值腿最贴近的那个若不在费率族里，说明它被费率结构否掉了 —— 不该出现在结论里。 */
    const softRefuted = !!rateFamily && !!best && !softInFamily;

    const separable = softSeparable && evidence !== 'conflict' && !softRefuted;
    const scopeLabel = scope === 'full-bank'
      ? `Battle 实测/官方/OpenRouter 递补模型池 ${ids.length} 个模型里只有它落进 ±${Math.round((PRICE_FINGERPRINT_RATIO - 1) * 100)}% 窗口`
      : `候选 ${ids.length} 个里只有它落进 ±${Math.round((PRICE_FINGERPRINT_RATIO - 1) * 100)}% 窗口`;
    const evidenceLabel = {both: '硬筛选+软判据一致', 'soft-ratio': '软判据（log 比值）', 'hard-hint': '硬筛选旁证（未交叉确认）', 'rate-family': '费率族（费率结构）', conflict: '两条证据分歧', none: ''}[evidence] || '';
    return {
      separable,
      reason: separable ? 'unique' : (evidence === 'conflict' ? 'conflict' : 'not-separable'),
      evidence,
      evidence_label: evidenceLabel,
      conflict,
      hard_filter: hardOut,
      /* v2.19.7：费率族 —— 硬筛选候选按四项费率签名分组后的结果（精确版本切不开时报到这一级）。 */
      rate_family: rateFamily,
      agent_price_hint: agentPriceHint,
      scope,
      arena_only: false,
      hit: best,
      soft_refuted: softRefuted,
      runner_up: runnerUp,
      candidates: ids.length,
      price_ranked_models: rankedHits.length,
      price_window_matches: withinHits.length,
      price_window_hits: withinHits.slice(0, 8).map(hit => ({
        model_key: hit.model_key,
        label: hit.label || hit.model_key,
        price_source: hit.price_source || null,
        ratio: hit.ratio,
        expected_usd: hit.expected_usd,
        complete: hit.complete,
        rates: hit.rates || null,
      })),
      n_pairs: base.n_pairs,
      observed_usd: base.observed_usd,
      token_count: base.token_count,
      estimated_tokens: base.estimated_tokens,
      implied_usd_per_mtok: base.implied_usd_per_mtok,
      usage_source: base.usage_source,
      exact_usage: base.exact_usage,
      rates_complete: allRatesComplete,
      pricing_policy: table.pricing_policy,
      pricing_source: table.source,
      pricing_fetched_at: table.fetched_at,
      battle_observed_rates: table.battle_observed_rates,
      openrouter_supplement: table.openrouter_supplement,
      same_price_groups: windowGroups,
      cache_rates: table.cache_rates ? {applied: table.cache_rates.applied, source: table.cache_rates.source, caveat: table.cache_rates.caveat} : null,
      /* v2.19.7：结论优先级 —— 定名 > 冲突（不定名） > 费率族/硬筛选旁证 > 如实不定名。
         冲突必须排在费率族之前，否则会被费率族文案盖掉（单测抓出来的）。 */
      text: (() => {
        if (separable) return `价格指纹: ${best.label || best.model_key}（唯一命中 · 比值 ${best.ratio} · ${scopeLabel}${evidence === 'both' ? ' · 硬筛选一致' : ''}）`;
        if (evidence === 'conflict') return `价格指纹: 不能唯一定名（${reasons.join('；')}）`;
        if (rateFamily) {
          const only = hard?.state === 'unique' && hard.candidates.length === 1;
          const head = only
            ? `费率旁证候选 ${rateFamily.models[0].display}（完整费率候选中仅它通过整数检验；不是身份确认${hardOut.partial ? `，另有 ${hardOut.partial} 个费率不全候选未排除` : ''}）`
            : `费率旁证含 ${hard.candidates.length} 个候选、${rateFamily.groups} 个费率组；展示其中一组：${rateFamily.text}，单凭账单切不开`;
          return `价格指纹: ${head}${softRefuted ? `；比值判据最贴近的 ${best.label || bestKey} 与费率结构不符，已忽略` : ''}`;
        }
        return `价格指纹: 不能唯一定名（${reasons.join('；')}）`;
      })(),
      note: [
        scope === 'full-bank'
          ? '价格指纹（全库）：同 key 优先使用已揭示 Battle 的同消息稳定实测费率；无实测时用 Arena 官方价，二者都没有时才用 OpenRouter 公开价。'
          : '价格指纹把候选收窄到唯一一个才可用于定名；同价等价类与比值不贴合一律降级为旁证。',
        '费率优先级：Battle 稳定实测 > Arena 官方参考 > OpenRouter 公开价兜底；缺失值不当作免费。',
        !allRatesComplete ? '本轮当前优先级下的费率覆盖不完整，只能给出旁证，不能认定唯一。' : '',
        exactUsage
          ? '金额是官方 base / 分项费用，token 是按相同 message_id 配对的 Arena 精确 usage。'
          : '金额是官方 base / 分项费用，token 仅为 chars-v1 转录字符估算（弱证据），不能独立触发模型定名。',
        hard ? `硬筛选：${hard.checked_models} 个模型里 ${hard.candidates.length} 个能整除分项账单（已剔除 ${hard.excluded_media} 个按张计价的媒体模型）。` : '',
        hard?.state === 'none' ? '⚠️ 没有任何模型的费率结构能整除这份账单 —— 多半是账单混合了多次调用/多个模型，或该模型不在 Arena 榜单里；此时只靠比值定名的可靠性明显更低。' : '',
        softRefuted ? `⚠️ 比值判据最贴近的 ${best.label || bestKey}（比值 ${best.ratio}）与费率结构冲突，已忽略 —— 比值腿看不到分项结构，账单里缓存读占比高时会系统性偏向贵模型。` : '',
      ].filter(Boolean).join(' '),
    };
  } catch (error) {
    return {separable: false, reason: 'error', error: String(error?.message || error)};
  }
}

/** v2.19.0 硬筛选腿：从最近一条官方账单取分项费用，在给定模型范围里做四项整数反推。
 *  取不到分项账单（cookie 门没过 / 会话没有 /cost 数据）就返回 null，价格指纹退回纯软判据。 */
async function hardFilterLeg(table, ids, costPayload) {
  try {
    const payload = costPayload && typeof costPayload === 'object' ? costPayload : null;
    const cached = netState.officialCost && netState.officialCost.messages ? netState.officialCost.messages : null;
    const messages = (payload && payload.messages) || cached;
    if (!messages || typeof messages !== 'object') return null;
    /* /cost 的 messages 可能按新→旧排列；对象末尾并不代表最新消息。
       仅在 ID 均为可排序的 UUIDv7（或只有一条）时定位最新账单，避免把旧消息/其他模型误当当前模型。 */
    const entries = Object.entries(messages).filter(([, m]) => m && typeof m === 'object');
    if (!entries.length) return null;
    if (entries.length > 1 && !entries.every(([id]) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) return null;
    entries.sort(([a], [b]) => b.localeCompare(a));
    const latest = entries[0][1];
    /* 当前单价表无长上下文分档；不能用标准费率对长上下文账单做硬判。 */
    if (latest.isLongContext === true || latest.actual?.isLongContext === true) return null;
    const breakdown = normalizeCostBreakdown(latest);
    if (!breakdown || breakdown.is_fallback ||
        ![breakdown.input_usd, breakdown.output_usd, breakdown.cache_write_usd, breakdown.cache_read_usd].some(v => v > 0)) return null;
    /* 范围：候选集路径只在指纹候选里筛；全库路径筛全库。 */
    const restricted = Array.isArray(ids) && ids.length > 0;
    const keys = restricted ? [...new Set(ids.flatMap(id => table.resolve(id)))] : null;
    if (restricted && !keys.length) return null;
    return hardFilterByCosts(breakdown, table, keys ? {keys} : {});
  } catch {
    return null;   // 硬筛选任何异常都不影响软判据链路
  }
}

/* tracePublic() 是同步的，这里用**已缓存**的单价表做一份同步账本摘要
   （表还没加载就只报条数，不阻塞轨迹读取）。 */
function ledgerSummarySync() {
  const table = pricingTableCache;
  const count = netState.messageUsage.length;
  if (!table) return {messages: count, priced: 0, unpriced: count, note: '单价表尚未加载'};
  /* v2.16.0：官方账单（/cost 200，覆写 cookie 放行灰度门）优先 —— 服务端权威值，
     Agent 模式下这是唯一不需要估算的逐条金额来源。 */
  if (netState.officialCost && (netState.officialCost.session || Object.keys(netState.officialCost.messages || {}).length)) {
    const rows = ledgerRowsFromCostMessages(netState.officialCost.messages);
    if (rows.length) {
      const officialTotals = ledgerTotals(rows);
      return {...officialTotals, mode: 'cost-route', token_ratio: null, text: describeTotals(officialTotals)};
    }
  }
  /* v2.14.0：Agent 会话没有 token 用量时，用转录字数估算给同一口径的摘要。 */
  if (!count && netState.transcriptEstimates.length) {
    const rows = ledgerRowsFromEstimates(netState.transcriptEstimates, table, {model: netState.identifiedModel || null});
    if (rows.length) {
      const estTotals = ledgerTotals(rows);
      return {...estTotals, mode: 'estimate', token_ratio: null, text: describeTotals(estTotals)};
    }
  }
  const entries = netState.messageUsage.map(entry => ({
    message_id: entry.message_id, role: entry.role, position: entry.position,
    model_id: entry.model_id, usage: entry.usage,
  }));
  const totals = buildLedger(entries, table, null).totals;
  const sum = sumUsage(netState.messageUsage.map(entry => entry.usage));
  return {...totals, mode: count ? 'usage' : 'blocked', token_ratio: sum ? tokenRatioText(sum) : null, text: describeTotals(totals)};
}

/* v2.9.3：页面 JS 可能因 CORS 读不到跨域响应头（未 expose 时 headers.get 返回 null），
   webRequest 在扩展网络层直接观测响应头，只读 public-access-token，与页面嗅探器互补。 */
async function ingestWebRequestToken(token, url) {
  if (typeof token !== 'string' || token.length < 20 || token === netState.token) return;
  netState.token = token;
  netState.tokenAt = Date.now();
  traceState.status = 'idle';
  traceState.name = null;
  traceState.environment = null;
  traceState.rhythm = null;
  traceState.text = `已从响应头捕获新运行 token（webRequest${url ? ' · ' + String(url).slice(0, 60) : ''}），正在查询轨迹…`;
  netState.pendingStreams = [];
  try { await handleTraceQuery(false); } catch { /* 失败留待下一次 */ }
}

if (chrome.webRequest?.onResponseStarted) {
  chrome.webRequest.onResponseStarted.addListener(
    (details) => {
      const header = (details.responseHeaders || []).find(item => /^(public-access-token|x-public-access-token)$/i.test(item.name));
      if (header?.value) void ingestWebRequestToken(header.value, details.url);
      /* 诊断计数：最近看到的请求（只留 主机+路径前缀，内存里最多 6 条，不落盘）。 */
      try {
        const parsed = new URL(details.url);
        const frameMark = details.frameId > 0 ? ` [frame${details.frameId}]` : '';
        const entry = `${parsed.host}${parsed.pathname.slice(0, 48)}${details.type === 'websocket' ? ' [WS]' : ''}${frameMark}`;
        if (netState.recentRequests[0]?.text !== entry) {
          netState.recentRequests.unshift({at: Date.now(), text: entry});
          netState.recentRequests = netState.recentRequests.slice(0, 6);
        }
      } catch { /* ignore */ }
    },
    {urls: ['https://arena.ai/*', 'https://canary.arena.ai/*', 'https://api.trigger.dev/*']},
    ['responseHeaders']
  );
}


function safeEnvironment(value, pageUrl) {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  try {
    const url = new URL(String(pageUrl || 'https://arena.ai/agent'));
    const route = url.pathname.startsWith('/work') ? 'work' : 'agent';
    const endpoints = [...new Set((netState.currentModels || []).map(item => {
      try { return new URL(item.url).hostname; } catch { return ''; }
    }).filter(Boolean))].sort();
    return `${url.hostname}/${route}${endpoints.length ? `|${endpoints.join(',')}` : ''}`.slice(0, 120);
  } catch { return 'arena.ai/agent'; }
}

function addCountVector(target, vector) {
  if (!Array.isArray(target.counts)) target.counts = new Array(355).fill(0);
  for (let index = 0; index < 355; index += 1) target.counts[index] = (Number(target.counts[index]) || 0) + (Number(vector[index]) || 0);
}

function shortHash(value) {
  let hash = 2166136261;
  for (const char of String(value || 'unknown')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function saveRhythmForVerifiedModel(modelId, streams) {
  if (!modelId || !Array.isArray(streams) || !streams.length) return null;
  const profile = rhythmProfile(streams);
  if (!profile?.enough) return null;
  const profiles = await readStore(RHYTHM_KEY, {});
  profiles[modelId] = rhythmAccumulate(profiles[modelId], profile);
  await writeStore({[RHYTHM_KEY]: profiles});
  const vote = rhythmVote(profile, profiles);
  traceState.rhythm = {profile, vote};
  return traceState.rhythm;
}

function evidenceStoreShape(value) {
  const store = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    schema: 2,
    rows: Array.isArray(store.rows) ? store.rows : [],
    models: store.models && typeof store.models === 'object' ? store.models : {},
    unlabeled_responses: Number(store.unlabeled_responses) || 0,
  };
}

async function bankStatus() {
  const store = evidenceStoreShape(await readStore(EVIDENCE_KEY, {}));
  const models = Object.entries(store.models).map(([id, item]) => ({
    id,
    responses: Number(item.responses) || 0,
    remaining: Math.max(0, BANK_TARGET_RESPONSES - (Number(item.responses) || 0)),
    environments: Object.entries(item.environments || {}).map(([environment, entry]) => ({environment, responses: Number(entry.responses) || 0})),
  })).sort((left, right) => right.responses - left.responses);
  return {
    target_per_model: BANK_TARGET_RESPONSES,
    target_basis: 'trace-verified response rows (not classifier guesses)',
    labeled_models: models.length,
    total_labeled_responses: models.reduce((sum, item) => sum + item.responses, 0),
    unlabeled_responses: store.unlabeled_responses,
    models: models.slice(0, 40),
  };
}

async function readStore(key, fallback) {
  const items = await chrome.storage.local.get(key);
  const value = items?.[key];
  return value === undefined ? fallback : value;
}

async function writeStore(patch) {
  await chrome.storage.local.set(patch);
}

function capped(list, cap) {
  return list.length > cap ? list.slice(-cap) : list;
}

function summarizeTrace(result) {
  if (!result) return '无结果';
  if (result.ok) {
    const layers = result.layers || {};
    const parts = [];
    if (layers.arena?.length) parts.push(`Arena ${layers.arena.slice(0, 3).join('/')}`);
    if (layers.providerRequest?.length) parts.push(`请求 ${layers.providerRequest.slice(0, 3).join('/')}`);
    if (layers.providerResponse?.length) parts.push(`响应 ${layers.providerResponse.slice(0, 3).join('/')}`);
    return `轨迹命中（${result.spans} spans）：${parts.join(' · ') || '拿到 200 但没挖到模型名'}`;
  }
  const codes = (result.attempts || []).map(item => `${new URL(item.url).pathname}→${item.status || 'ERR'}`).join(' ');
  return `轨迹未命中：${result.error || '未知原因'}｜${codes}`;
}

/* v2.11.0 用量通道：汇总嗅探到的 token 用量（最近一次 / 累计 / 形态签名）。
   注意：美元成本 Arena 不下发（metadata.cost 为 null），这里只报 token 与形态，不折算、不猜价。 */
function usageBlock() {
  const signals = netState.usageSignals;
  if (!signals.length) return {signals: 0, latest: null, total: null, signatures: [], recent: [], note: '尚未捕获 usage：需页面上真实发一条消息（响应 GET /api/evaluation/<sid> 才带）'};
  const latest = latestUsage(signals);
  const total = sumUsage(signals.map(item => item.usage));
  return {
    signals: signals.length,
    latest: latest ? {usage: latest.usage, shape: latest.shape, text: describeUsage(latest.usage), where: latest.where} : null,
    total: total ? {usage: total, text: describeUsage(total)} : null,
    signatures: [...new Set(signals.map(item => item.signature).filter(Boolean))],
    recent: signals.slice(-3).map(item => ({signature: item.signature, text: describeUsage(item.usage), where: item.where, at: item.at})),
  };
}

function tracePublic() {
  return {
    status: traceState.status,
    text: traceState.text,
    runId: traceState.runId,
    name: traceState.name,
    endpoints: traceState.endpoints.slice(0, 8),
    error: traceState.error,
    environment: traceState.environment,
    rhythm: traceState.rhythm,
    at: traceState.at,
    tokenSeen: !!netState.token,
    models: netState.models.slice(0, 8),
    recent: netState.recentRequests.map(item => item.text),
    pageSnifferAt: netState.pageSnifferAliveAt || null,
    scan: netState.pageScanStats,
    cost: (() => { const actual = observedCostActual(); const detail = actual?.detail || observedCostDetail(netState.costSignals); return {signals: netState.costSignals.length, observed_usd: actual?.usd || null, via: actual?.via || null, detail, text: describeCostDetail(detail), routes: netState.costRouteSignals.length, gate: netState.costGate, recent: netState.costSignals.slice(-4)}; })(),
    ledger: ledgerSummarySync(),
    usage: usageBlock(),
    pricing: pricingTableInfo,
  };
}

async function handleTraceQuery(force) {
  if (!netState.token) {
    traceState.status = 'no-token';
    traceState.text = '还没嗅探到 public-access-token：需要页面上真实触发一次 Agent 运行';
    return tracePublic();
  }
  if (!force && Date.now() - netState.lastTraceAt < TRACE_COOLDOWN_MS && traceState.status !== 'idle') return tracePublic();
  netState.lastTraceAt = Date.now();
  traceState.status = 'querying';
  traceState.text = '正在查询运行轨迹…';
  try {
    const result = await queryRunTrace({token: netState.token, fetchImpl: (...args) => fetch(...args), maxAttempts: 6});
    traceState.at = Date.now();
    traceState.runId = result.runId || null;
    traceState.endpoints = result.attempts || [];
    traceState.error = result.ok ? null : (result.error || '未命中');
    const layers = result.layers || {};
    const chosen = [
      ...(layers.providerResponse || []),
      ...(layers.providerRequest || []),
      ...(layers.arena || []),
    ].find(value => typeof value === 'string' && value.length > 1) || null;
    traceState.name = result.ok ? chosen : null;
    traceState.status = result.ok ? (chosen ? 'ok' : 'ok-no-model') : 'failed';
    traceState.text = summarizeTrace(result);
    if (result.ok && chosen) {
      const cache = await readStore(TRACE_KEY, {});
      for (const model of netState.currentModels) {
        const codename = String(model?.name || '');
        if (codename && codename !== chosen && /request/i.test(model.where || '')) {
          cache[codename] = {name: chosen, at: Date.now(), runId: traceState.runId};
        }
      }
      cache[`run:${traceState.runId}`] = {name: chosen, layers, at: Date.now()};
      const keys = Object.keys(cache);
      for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete cache[key];
      await writeStore({[TRACE_KEY]: cache});
    }
    const environment = (layers.attributes || []).find(item => /(deployment[._-]?environment|service\.namespace|cloud\.region|provider\.name|arena\.environment)/i.test(item.key || ''));
    traceState.environment = environment ? `${environment.key}=${environment.value}`.slice(0, 120) : null;
    if (result.ok && chosen) netState.currentModels = netState.currentModels.filter(item => /request/i.test(item.where || '')).slice(0, 20);
  } catch (error) {
    traceState.status = 'error';
    traceState.error = String(error?.message || error);
    traceState.text = `轨迹查询异常：${traceState.error}`;
  }
  return tracePublic();
}

// v2.9.14/15：受信任点击与受信任键入 —— Arena 会过滤合成事件（isTrusted=false 一律无效），菜单选项、发送按钮、输入框 value+input 都必须走 chrome.debugger 的真实输入。
const trustedSessions = new Set(); // v2.9.15：已建立持久调试会话的页签
chrome.debugger?.onDetach?.addListener(source => { if (source && typeof source.tabId === 'number') trustedSessions.delete(source.tabId); });
chrome.tabs.onRemoved.addListener(tabId => trustedSessions.delete(tabId));
/* v2.9.23：debugger 改为可选权限（optional_permissions）——静态声明时直接可用；
   否则必须先由带用户手势的扩展页面（工具栏弹窗按钮）调用 chrome.permissions.request 授权。 */
async function debugPermissionGranted() {
  if (chrome.runtime.getManifest().permissions.includes('debugger')) return true;
  if (!chrome.permissions?.contains) return false;
  try { return await chrome.permissions.contains({ permissions: ['debugger'] }); } catch { return false; }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type !== 'AMP_ENSURE_DEBUG') return;
  (async () => {
    if (await debugPermissionGranted()) return { granted: true };
    if (!chrome.permissions?.request) return { granted: false, error: 'chrome.permissions 不可用' };
    const granted = await chrome.permissions.request({ permissions: ['debugger'] }).catch(() => false);
    return { granted: !!granted };
  })().then(reply, error => reply({ granted: false, error: String(error?.message || error) }));
  return true;
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const isClick = message?.type === 'AMP_TRUSTED_CLICK';
  const isType = message?.type === 'AMP_TRUSTED_TYPE';
  const isSend = message?.type === 'AMP_TRUSTED_SEND';
  if ((!isClick && !isType && !isSend) || !sender.tab || typeof message.x !== 'number' || typeof message.y !== 'number') return;
  if ((isType || isSend) && typeof message.text !== 'string') return;
  if (isSend && (typeof message.x2 !== 'number' || typeof message.y2 !== 'number')) return;
  (async () => {
    const debuggee = { tabId: sender.tab.id };
    if (!(await debugPermissionGranted())) { reply({ error: '未获得 debugger 权限：请在扩展弹窗里点一次识别/抽卡按钮以授权' }); return; }
    const timings = { attachMs: -1, insertMs: -1, pollMs: -1, clickMs: -1 };
    const trace = (step, extra) => { try { btraceLog.push([message.type, step, extra == null ? '' : String(extra).slice(0, 60), Date.now() % 1000000]); if (btraceLog.length > BTRACE_CAP) btraceLog.splice(0, btraceLog.length - BTRACE_CAP); } catch {} };
    trace('enter', 'tab=' + sender.tab.id);
    const attempt = async () => {
      // v2.9.15：持久调试会话 —— 首次 attach 后保持，不再反复 attach/detach（反复挂载会触发 Chrome 的 attach 挂起）。
      if (!trustedSessions.has(debuggee.tabId)) {
        let attachedOk = false;
        const attachStart = Date.now();
        for (let i = 0; i < 3 && !attachedOk; i++) { // v2.9.15：attach 可能因孤儿会话挂起——限时竞速 + 强拆 + 重试
          trace('attach-try', i);
          const targets = await chrome.debugger.getTargets().catch(() => []);
          trace('getTargets', 'n=' + (Array.isArray(targets) ? targets.filter(t => t.attached).length : -1));
          if (Array.isArray(targets) && targets.some(t => t.tabId === debuggee.tabId && t.attached)) await chrome.debugger.detach(debuggee).catch(() => {});
          trace('postDetach', '');
          await new Promise(resolve => setTimeout(resolve, 400));
          attachedOk = await Promise.race([
            chrome.debugger.attach(debuggee, '1.3').then(() => true).catch(() => false),
            new Promise(resolve => setTimeout(() => resolve(false), 3500))
          ]);
          trace('attachResult', attachedOk);
          if (!attachedOk) await chrome.debugger.detach(debuggee).catch(() => {});
        }
        if (!attachedOk) throw Error('debugger attach 三次尝试均失败');
        timings.attachMs = Date.now() - attachStart;
        trustedSessions.add(debuggee.tabId);
      }
      if (!message.skipClick) {
        trace('clickPre', message.x + ',' + message.y);
        await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: message.x, y: message.y });
        await new Promise(resolve => setTimeout(resolve, 150)); // v2.9.15：悬停一拍再按，真实点击节奏
        await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: message.x, y: message.y, button: 'left', clickCount: 1 });
        await new Promise(resolve => setTimeout(resolve, 120)); // v2.9.15：按住 120ms 再放——零间隔会吞掉 mouseup/pointerup
        await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: message.x, y: message.y, button: 'left', clickCount: 1 });
        trace('clickDone', '');
      }
      if (isType || isSend) await chrome.debugger.sendCommand(debuggee, 'Input.insertText', { text: message.text });
      trace('insertDone', message.text ? message.text.slice(0, 12) : '');
      const insertDone = Date.now();
      if (isSend) {
        let tx = message.x2, ty = message.y2;
        for (let i = 0; i < 10; i++) { // v2.9.15：等 React 把发送按钮点亮，并自定位其最新坐标
          await new Promise(resolve => setTimeout(resolve, 250));
          try {
            const probe = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', { expression: `(() => { let b=[...document.querySelectorAll('button[aria-label]')].find(x => x.getClientRects().length && /^send\\s*message$/i.test(x.getAttribute('aria-label') || '')); if (!b) b = [...document.querySelectorAll('button')].find(x => x.getClientRects().length && /^(send|发送)$/i.test((x.textContent || '').trim())); if (!b) return null; const r = b.getBoundingClientRect(); return { disabled: b.disabled, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`, returnByValue: true });
            const info = probe && probe.result && probe.result.value;
            if (info && !info.disabled) { tx = info.x; ty = info.y; break; }
          } catch {}
        }
        trace('pollDone', tx + ',' + ty);
        timings.pollMs = Date.now() - insertDone;
        const clickStart = Date.now();
        await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: tx, y: ty });
        await new Promise(resolve => setTimeout(resolve, 150));
        await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', clickCount: 1 });
        await new Promise(resolve => setTimeout(resolve, 120));
        await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1 });
        trace('sendClicked', '');
        timings.clickMs = Date.now() - clickStart;
        return { ok: true, timings };
      }
      if (!isType) return { ok: true };
      let active = null;
      try { const probe = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', { expression: 'document.activeElement ? document.activeElement.tagName + "." + String(document.activeElement.className || "").slice(0,30) : "none"', returnByValue: true }); active = probe && probe.result && probe.result.value; } catch {}
      return { ok: true, active };
    };
    try{
      try{
        return await attempt();
      }catch(firstError){
        trustedSessions.delete(debuggee.tabId);
        await new Promise(resolve => setTimeout(resolve, 700)); // v2.9.15：会话失效或 attach 挂起时，重置会话并重试一次
        return await attempt();
      }
    }catch(error){
      trustedSessions.delete(debuggee.tabId);
      return { error: String(error?.message || error) };
    }
  })().then(response => { try { reply(response); } catch {} }).catch(() => { try { reply({ error: 'trusted handler 异常' }); } catch {} }); // v2.9.15 关键修复：把结果真正回给内容脚本（此前 reply 从未被调用，所有受信任操作都靠前端超时兜底）
  return true;
});

/* v2.9.23：防节流计时服务 —— 隐藏标签页的链式 setTimeout 会被 Chrome 降频（隐藏超 5 分钟后 1 分钟/次），
   内容脚本的秒级轮询会大面积假超时。由 SW 代为计时（不受页面可见性节流），经长连接端口回唤醒；
   抽卡期间消息不断，顺带持续重置 SW 空闲计时避免被回收。 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'amp-timer') return;
  port.onMessage.addListener(msg => {
    if (msg?.type !== 'AMP_TIMER' || typeof msg.id !== 'number') return;
    const ms = Math.max(0, Math.min(120000, Number(msg.ms) || 0));
    setTimeout(() => { try { port.postMessage({ id: msg.id }); } catch {} }, ms);
  });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;

  if (message?.type === 'AMP_NET') {
    (async () => {
      const incomingModels = (Array.isArray(message.models) ? message.models : []).map(model => ({
        name: String(model?.name || '').slice(0, 120),
        where: String(model?.where || '').slice(0, 60),
        url: String(model?.url || '').slice(0, 200),
        at: Date.now(),
      })).filter(model => model.name);
      for (const item of Array.isArray(message.evidence) ? message.evidence : []) {
        if (item?.kind === 'token' && typeof item.token === 'string' && item.token.length >= 20) {
          const fresh = item.token !== netState.token;
          netState.token = item.token;
          netState.tokenAt = item.at || Date.now();
          if (fresh) {
            traceState.status = 'idle';
            traceState.name = null;
            traceState.environment = null;
            traceState.rhythm = null;
            traceState.text = '新的运行 token 已捕获，正在查询轨迹…';
            netState.currentModels = incomingModels.slice(0, 20);
            // 新 run 的节奏样本不能混进上一 run 的队列。
            netState.pendingStreams = [];
          }
        } else if (item?.kind === 'stats') {
          netState.pageScanStats = {req: Number(item.req) || 0, body: Number(item.body) || 0, chunks: Number(item.chunks) || 0, urls: Array.isArray(item.urls) ? item.urls.slice(0, 6) : [], at: item.at || Date.now()};
        } else if (item?.kind === 'alive') {
          netState.pageSnifferAliveAt = item.at || Date.now();
        } else if (item?.kind === 'cost') {
          const value = Number(item.value);
          if (Number.isFinite(value) && value >= 0 && value <= 1e7) {
            const key = `${item.field}=${value}`;
            if (!netState.costSignals.some(entry => `${entry.field}=${entry.value}` === key)) {
              netState.costSignals.push({
                field: String(item.field || '').slice(0, 40),
                value,
                /* v2.13.1：保留 credits / multiplier 两类（旧代码只认 usd，把 `totalChargedCredits`
                   和 `costMultiplier` 一律当 token 数，倍率就永远推不出来）。 */
                unit: ['usd', 'credits', 'multiplier', 'tokens'].includes(item.unit) ? item.unit : 'tokens',
                where: String(item.where || '').slice(0, 60),
                url: String(item.url || '').slice(0, 200),
                at: item.at || Date.now(),
              });
              netState.costSignals = capped(netState.costSignals, 60);
            }
          }
        } else if (item?.kind === 'cost-route') {
          /* v2.13.0 真实按次成本路由（/api/chat/:id/cost 等）的结构化按消息成本。 */
          const signal = {
            route: String(item.route || '').slice(0, 40),
            session: item.session && typeof item.session === 'object' ? item.session : null,
            messages: Array.isArray(item.messages) ? item.messages.slice(0, 50) : [],
            url: String(item.url || '').slice(0, 200),
            at: item.at || Date.now(),
          };
          const signature = JSON.stringify([signal.session, signal.messages.map(m => [m.message_id, m.actual_usd])]);
          if (!netState.costRouteSignals.some(entry => entry.signature === signature)) {
            signal.signature = signature;
            netState.costRouteSignals.push(signal);
            netState.costRouteSignals = capped(netState.costRouteSignals, 20);
          }
        } else if (item?.kind === 'cost-gate') {
          /* /cost 路由 403 = 账号灰度门；记一次，供浮层解释「为什么没有真实成本」。 */
          netState.costGate = {status: Number(item.status) || 0, url: String(item.url || '').slice(0, 200), at: item.at || Date.now()};
        } else if (item?.kind === 'usage') {
          /* v2.11.0 用量通道：Arena 实测会下发每条消息的 token 用量（见 usage-channel.js 头注）。 */
          const usage = parseUsage(item.usage);
          if (usage) {
            const key = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens].join(',');
            if (!netState.usageSignals.some(entry => [entry.usage.inputTokens, entry.usage.outputTokens, entry.usage.cacheReadTokens, entry.usage.cacheWriteTokens, entry.usage.reasoningTokens].join(',') === key)) {
              netState.usageSignals.push({
                usage,
                shape: usageShape(usage),
                signature: usageShape(usage)?.signature || null,
                where: String(item.where || '').slice(0, 60),
                url: String(item.url || '').slice(0, 200),
                at: item.at || Date.now(),
              });
              netState.usageSignals = capped(netState.usageSignals, 40);
            }
          }
        } else if (item?.kind === 'message-usage') {
          /* v2.13.2 花费账本：带消息身份的逐条用量（嗅探器从 /api/evaluation/<sid> 结构化抽出）。
             与上面的 usage 信号并存：那个只做形态旁证，这个用来摊「逐条花费明细」。 */
          const usage = parseUsage(item.usage);
          if (usage) {
            const messageId = item.message_id ? String(item.message_id).slice(0, 64) : null;
            const key = `${messageId || ''}|${usage.inputTokens || 0},${usage.outputTokens || 0},${usage.cacheReadTokens || 0},${usage.cacheWriteTokens || 0}`;
            if (!netState.messageUsage.some(entry => entry.key === key)) {
              netState.messageUsage.push({
                key,
                message_id: messageId,
                role: item.role ? String(item.role).slice(0, 20) : null,
                position: item.position ? String(item.position).slice(0, 4) : null,
                model_id: item.model_id ? String(item.model_id).slice(0, 120) : null,
                usage,
                url: String(item.url || '').slice(0, 200),
                at: item.at || Date.now(),
              });
              netState.messageUsage = capped(netState.messageUsage, 120);
            }
          }
        } else if (item?.kind === 'agent-price-output') {
          try {
            const probeId = typeof item.price_probe_id === 'string' ? item.price_probe_id : '';
            const messageId = typeof item.message_id === 'string' ? item.message_id.slice(0, 64) : null;
            const chars = normalizeEstimateBucket(item.chars);
            if (messageId && chars && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(probeId)) {
              const row = {message_id: messageId, price_probe_id: probeId, chars,
                unobserved_parts: Math.max(0, Math.min(100000, Number(item.unobserved_parts) || 0))};
              const existing = netState.agentPriceOutputs.find(entry => entry.message_id === messageId && entry.price_probe_id === probeId);
              if (existing) Object.assign(existing, row);
              else netState.agentPriceOutputs = capped([...netState.agentPriceOutputs, row], 120);
            }
          } catch { /* optional statistics never disrupt original evidence ingestion */ }
        } else if (item?.kind === 'transcript-estimate') {
          /* v2.14.0 Agent 转录估算：会话包没有 usage 字段时，按正文+thinking 字数估算输出 token。
             只存数字与字符计数（没有正文），供花费账本在无用量、无 /cost 时使用。
             v2.15.0：另存用户那条消息的字符数作为**输入下界**（input_chars）。 */
          const chars = item.chars && typeof item.chars === 'object' ? item.chars : null;
          const bucketOf = normalizeEstimateBucket;
          if (chars?.text && chars?.reasoning) {
            const messageId = item.message_id ? String(item.message_id).slice(0, 64) : null;
            const normalizedChars = {text: bucketOf(chars.text), reasoning: bucketOf(chars.reasoning), skipped_parts: Math.max(0, Math.min(100000, Number(chars.skipped_parts) || 0))};
            const url = String(item.url || '').slice(0, 200);
            const key = `${messageId || ''}|${JSON.stringify(normalizedChars)}`;
            const inputChars = bucketOf(item.input_chars);
            const existing = netState.transcriptEstimates.find(entry => messageId
              ? entry.message_id === messageId && entry.url === url : entry.key === key);
            if (existing) {
              // 同一消息的流式/转录快照更新原条目，不能每长一段就再累计一次。
              existing.key = key;
              existing.chars = normalizedChars;
              existing.at = item.at || Date.now();
              if (!existing.input_chars && inputChars) existing.input_chars = inputChars;
            } else {
              netState.transcriptEstimates.push({
                key,
                message_id: messageId,
                model_id: item.model_id ? String(item.model_id).slice(0, 120) : null,
                chars: normalizedChars,
                input_chars: inputChars,
                input_message_id: item.input_message_id ? String(item.input_message_id).slice(0, 64) : null,
                url,
                at: item.at || Date.now(),
              });
              netState.transcriptEstimates = capped(netState.transcriptEstimates, 120);
            }
          }
        } else if (item?.kind === 'stream') {
          const stream = {
            runId: item.runId || null,
            chunks: Number(item.chunks) || 0,
            bytes: Number(item.bytes) || 0,
            duration_ms: Number(item.duration_ms) || 0,
            gaps: Array.isArray(item.gaps) ? item.gaps.slice(0, 1200).map(Number).filter(Number.isFinite) : [],
            at: item.at || Date.now(),
          };
          netState.streams.push(stream);
          netState.pendingStreams.push(stream);
          netState.streams = capped(netState.streams, STREAM_CAP);
          netState.pendingStreams = capped(netState.pendingStreams, STREAM_CAP);
        }
      }
      for (const model of incomingModels) {
        if (!netState.models.some(item => item.name === model.name && item.where === model.where && item.url === model.url)) netState.models.push(model);
      }
      netState.models = capped(netState.models, 60);
      if (incomingModels.length && !netState.currentModels.length) netState.currentModels = incomingModels.slice(0, 20);
      const trace = netState.token && traceState.status !== 'querying' ? await handleTraceQuery(false) : tracePublic();
      if (traceState.status === 'ok' && traceState.name && netState.pendingStreams.length) {
        const rhythm = await saveRhythmForVerifiedModel(traceState.name, netState.pendingStreams);
        if (rhythm) netState.pendingStreams = [];
        traceState.text = `${traceState.text.split(' · 节奏提示 ')[0]} · 节奏提示 ${rhythm?.vote?.verdict || 'insufficient'}${rhythm?.vote?.best ? ` (${rhythm.vote.best})` : ''}`;
      }
      return {trace: tracePublic(), models: netState.models.slice(0, 12), streams: netState.streams.length};
    })().then(reply, error => reply({trace: {...tracePublic(), status: 'error', text: `嗅探处理失败：${error?.message || error}`}}));
    return true;
  }

  if (message?.type === 'AMP_TRACE_QUERY') {
    void handleTraceQuery(message.force === true).then(reply, error => reply({trace: {...tracePublic(), status: 'error', text: String(error?.message || error)}}));
    return true;
  }

  /* v2.10.0 价格通道：返回 Arena 成本表与现场成本信号；给 ids 时按模型查成本档位，否则给全部条目。 */
  if (message?.type === 'AMP_PRICE') {
    (async () => {
      const fromExtensionPage = !sender.tab && isExtensionPage(sender.url);
      if (!fromExtensionPage && (sender.frameId !== 0 || !isAgentUrl(sender.url))) throw Error('价格请求来源无效');
      const table = await loadCostTable();
      const ids = Array.isArray(message.ids) ? message.ids.filter(id => typeof id === 'string').slice(0, 40) : [];
      const entries = ids.length
        ? ids.map(id => {
            const profile = table.profile(id);
            return profile
              ? {id, label: profile.label, cost_p50: profile.cost_p50, tier: profile.tier, tier_label: TIER_LABEL[profile.tier] || null, variants: profile.variants}
              : {id, missing: true};
          })
        : table.all().slice(0, 60).map(profile => ({id: profile.bank_id, label: profile.label, cost_p50: profile.cost_p50, tier: profile.tier}));
      return {
        info: {source: table.source, fetched_at: table.fetched_at, metric: table.metric, models: table.models, rows: table.rows},
        observed_usd: observedCostFromSignals(netState.costSignals),
        observed_detail: observedCostActual()?.detail || observedCostDetail(netState.costSignals),
        cost_signals: netState.costSignals.slice(-6),
        usage: usageBlock(),
        pricing: pricingTableInfo.error ? {error: pricingTableInfo.error} : pricingTableInfo,
        entries,
      };
    })().then(reply, error => reply({error: String(error?.message || error)}));
    return true;
  }

  /* v2.12.0 单价通道：返回随包单价表摘要与（给定候选时的）期望成本区分度。
     候选可以是 Arena 变体 key，也可以是指纹库基础 id（自动展开到全部变体）。 */
  if (message?.type === 'AMP_PRICING') {
    (async () => {
      const fromExtensionPage = !sender.tab && isExtensionPage(sender.url);
      if (!fromExtensionPage && (sender.frameId !== 0 || !isAgentUrl(sender.url))) throw Error('单价请求来源无效');
      const table = arenaPricingTable(await loadPricingTable(), sender.url);
      const ids = Array.isArray(message.ids) ? message.ids.filter(id => typeof id === 'string').slice(0, 40) : [];
      const usage = latestUsage(netState.usageSignals)?.usage || null;
      return {
        info: pricingSummary(table),
        usage: usage ? {usage, text: describeUsage(usage)} : null,
        observed_usd: observedCostFromSignals(netState.costSignals) || null,
        observed_detail: observedCostActual()?.detail || observedCostDetail(netState.costSignals),
        candidates: ids.map(id => {
          const priced = bankPricing(id, table);
          return priced ? {id, ...priced, arena_listed: priced.keys.some(key => table.profile(key)?.arena_listed === true)} : {id, priced: false, arena_listed: false, keys: [], variants: []};
        }),
        discrimination: usage && ids.length >= 2 ? discrimination(usage, ids, table) : null,
      };
    })().then(reply, error => reply({error: String(error?.message || error)}));
    return true;
  }

  /* v2.16.0 官方成本通道：content.js 带 PostHog 覆写 cookie 读到 /cost 200 后，
     把整份账单同步过来。存进 netState.officialCost —— observedCostActual / 自检 /
     AMP_PRICE 的 observed_detail 都读它；同时清掉「灰度门」记录（门已经过了）。
     只收 Agent/Battle 页顶层框架的消息，字段全部过白名单，不进正文。 */
  /* v2.16.0 把 content.js 传来的 /cost 账单洗成可存形态：字段白名单 + 条数/量级上限。
     纯函数 —— 不过问来源、不碰 netState，单测直接喂 2026-10-12 CDP 实测 payload。 */
  if (message?.type === 'AMP_COST_PAYLOAD') {
    if (sender.frameId !== 0 || !isAgentUrl(sender.url)) return;
    const official = cleanOfficialCost(message);
    if (!official) return;
    netState.officialCost = official;
    /* 门已经过了，旧的 403 记录作废（留着会让自检误报「灰度门拦」）。 */
    netState.costGate = null;
    reply({ok: true, at: official.at});
    return true;
  }

  /* v2.13.2 花费账本：返回「这次会话花了多少」的逐条明细与汇总。
     不需要计费账号 —— base 用公开单价 × 实测 token 用量算。 */
  if (message?.type === 'AMP_LEDGER') {
    (async () => {
      const fromExtensionPage = !sender.tab && isExtensionPage(sender.url);
      if (!fromExtensionPage && (sender.frameId !== 0 || !isAgentUrl(sender.url))) throw Error('花费请求来源无效');
      const candidates = Array.isArray(message.candidates) ? message.candidates : [];
      /* v2.15.0：内容脚本若已用指纹识别出**唯一**模型，就带进来给估算行折价 ——
         否则「转录字数估算」的行永远 unpriced（模型未知 ⇒ 绝不猜价），永远给不出金额。 */
      const model = typeof message.model === 'string' && /^[a-z0-9._-]{2,80}$/i.test(message.model.trim()) ? message.model.trim() : null;
      if (model) netState.identifiedModel = model;
      const costPayload = message.costPayload && typeof message.costPayload === 'object' ? message.costPayload : null;
      return await ledgerBlock({candidates, limit: Number(message.limit), costPayload, model: model || netState.identifiedModel || null});
    })().then(reply, error => reply({error: String(error?.message || error)}));
    return true;
  }

  /* v2.16.1 花费反推：官方逐条 base ÷ 同消息估算 token = 隐含单价 → 对指纹库全量排序。
     Agent 会话没有逐条 token 用量（会话包不下发），这是「用花费反推模型」的唯一起点；
     Battle 模式有服务端用量，走 ledgerBlock 里的 reverse。来源校验与 AMP_LEDGER 一致。 */
  if (message?.type === 'AMP_COST_REVERSE') {
    (async () => {
      const fromExtensionPage = !sender.tab && isExtensionPage(sender.url);
      if (!fromExtensionPage && (sender.frameId !== 0 || !isAgentUrl(sender.url))) throw Error('花费反推请求来源无效');
      const candidates = Array.isArray(message.candidates) ? message.candidates : [];
      const costPayload = message.costPayload && typeof message.costPayload === 'object' ? message.costPayload : null;
      return await costReverseBlock({candidates, costPayload, pageUrl: sender.url, fullPriceRanking: message.fullPriceRanking === true});
    })().then(reply, error => reply({error: String(error?.message || error)}));
    return true;
  }

  /* v2.18.0 价格指纹独立识别模式：不借数字候选集，直接在**全库**模型里按价格裁决。
     返回 priceFingerprintBlock 的 separable 判据（含 scope:'full-bank'）。
     来源校验与 AMP_COST_REVERSE 一致。 */
  if (message?.type === 'AMP_PRICE_FULL') {
    (async () => {
      const fromExtensionPage = !sender.tab && isExtensionPage(sender.url);
      if (!fromExtensionPage && (sender.frameId !== 0 || !isAgentUrl(sender.url))) throw Error('价格指纹请求来源无效');
      const costPayload = message.costPayload && typeof message.costPayload === 'object' ? message.costPayload : null;
      const priceProbeId = typeof message.priceProbeId === 'string' ? message.priceProbeId.slice(0, 64) : null;
      const agentHintWaitMs = Math.max(0, Math.min(3000, Number(message.agentHintWaitMs) || 0));
      return await priceFingerprintBlock([], {costPayload, fullBank: true, pageUrl: sender.url, priceProbeId, agentHintWaitMs});
    })().then(reply, error => reply({error: String(error?.message || error)}));
    return true;
  }

  if (message?.type === 'AMP_EVIDENCE_SAVE') {
    (async () => {
      const samples = Array.isArray(message.samples) ? message.samples.filter(item => typeof item?.text === 'string' && item.text.length > 40) : [];
      if (!samples.length) return {saved: 0};
      const verifiedModel = message.traceVerified === true && typeof message.traceModel === 'string' ? message.traceModel.slice(0, 120) : null;
      const environment = safeEnvironment(message.environment, message.pageUrl);
      const store = evidenceStoreShape(await readStore(EVIDENCE_KEY, {}));
      let saved = 0;
      for (const sample of samples) {
        const numbers = parseNumbers(sample.text);
        if (numbers.length < 80) continue;
        const counts = countNumbers(numbers);
        const row = {
          at: Date.now(), model_id: verifiedModel, label_source: verifiedModel ? 'trace' : 'unlabeled',
          candidate_id: message.candidateModel || null, status: message.status || null, environment,
          expected_count: Number(sample.expected_count) || null, valid_number_count: numbers.length, counts,
        };
        store.rows.push(row);
        saved += 1;
        if (verifiedModel) {
          const model = store.models[verifiedModel] || (store.models[verifiedModel] = {responses: 0, environments: {}, updated_at: Date.now()});
          const env = model.environments[environment] || (model.environments[environment] = {responses: 0, number_count: 0, counts: new Array(355).fill(0)});
          model.responses += 1;
          env.responses += 1;
          env.number_count += numbers.length;
          addCountVector(env, counts);
          model.updated_at = Date.now();
        } else store.unlabeled_responses += 1;
      }
      while (store.rows.length > EVIDENCE_CAP) store.rows.shift();
      await writeStore({[EVIDENCE_KEY]: store});
      return {saved, verified_model: verifiedModel, environment, status: await bankStatus()};
    })().then(reply, error => reply({error: String(error?.message || error)}));
    return true;
  }

  if (message?.type === 'AMP_API_STASH_PUT') {
    void (async () => {
      try {
        const key = 'ampApiStash:' + String(message.sid || '').slice(0, 64);
        if (!message.per) await chrome.storage.session.remove(key);
        else await chrome.storage.session.set({ [key]: { sid: message.sid, per: message.per, at: Date.now() } });
        reply({ ok: true });
      } catch (e) { reply({ error: String(e?.message || e) }); }
    })();
    return true;
  }
  if (message?.type === 'AMP_API_STASH_GET') {
    void (async () => {
      try {
        const key = 'ampApiStash:' + String(message.sid || '').slice(0, 64);
        const got = await chrome.storage.session.get(key);
        reply(got?.[key] || null);
      } catch (e) { reply(null); }
    })();
    return true;
  }

  if (message?.type === 'AMP_TEXT_BANK_SAVE') {
    (async () => {
      const rt = globalThis.ArenaProbeRuntime;
      const model = typeof message.model === 'string' ? message.model.trim().slice(0, 120) : '';
      const samples = (Array.isArray(message.samples) ? message.samples : [])
        .filter(sample => typeof sample?.id === 'string' && typeof sample?.text === 'string' && sample.text.trim().length > 1)
        .slice(0, 20);
      if (!model) return {error: '自动建档缺少模型名'};
      if (!samples.length) return {error: '没有可入库的文本回复'};
      const store = await readStore(TEXT_BANK_KEY, {schema: 1, models: {}});
      if (!store.models || typeof store.models !== 'object') store.models = {};
      const entry = store.models[model] || (store.models[model] = {prompts: {}, updated_at: 0});
      let saved = 0;
      for (const sample of samples) {
        const counts = rt.textToCounts(sample.text);
        const bucket = entry.prompts[sample.id] || (entry.prompts[sample.id] = {responses: 0, counts: {}});
        for (const [word, count] of Object.entries(counts)) bucket.counts[word] = (bucket.counts[word] || 0) + count;
        bucket.responses += 1;
        saved += 1;
      }
      entry.updated_at = Date.now();
      const keys = Object.keys(store.models);
      if (keys.length > 40) {
        keys.sort((left, right) => (store.models[left].updated_at || 0) - (store.models[right].updated_at || 0));
        for (const key of keys.slice(0, keys.length - 40)) delete store.models[key];
      }
      await writeStore({[TEXT_BANK_KEY]: store});
      const responses = Object.values(entry.prompts).reduce((sum, p) => sum + (p.responses || 0), 0);
      return {saved, responses, target: rt.TEXT_BANK_TARGET, models: Object.keys(store.models).length};
    })().then(reply, error => reply({error: String(error?.message || error)}));
    return true;
  }

  if (message?.type === 'AMP_TEXT_SCORE') {
    (async () => {
      const rt = globalThis.ArenaProbeRuntime;
      const store = await readStore(TEXT_BANK_KEY, {schema: 1, models: {}});
      const models = store.models && typeof store.models === 'object' ? store.models : {};
      const total = Object.values(models).reduce((sum, entry) => sum + Object.values(entry.prompts || {}).reduce((s, p) => s + (p.responses || 0), 0), 0);
      // ready = 已达到「每提示 ≥ TEXT_MIN_RESPONSES」门槛、可参与文本评分的模型数。
      const ready = Object.values(models).filter(entry => Object.values(entry.prompts || {}).some(p => (p.responses || 0) >= rt.TEXT_MIN_RESPONSES)).length;
      const available = {models: Object.keys(models).length, total, ready};
      const samples = (Array.isArray(message.samples) ? message.samples : [])
        .filter(sample => typeof sample?.id === 'string' && typeof sample?.text === 'string' && sample.text.trim().length > 1)
        .slice(0, 8)
        .map(sample => ({id: sample.id, counts: rt.textToCounts(sample.text)}));
      const scored = [];
      for (const [model, entry] of Object.entries(models)) {
        let sum = 0, used = 0;
        for (const sample of samples) {
          const ref = entry.prompts?.[sample.id];
          if (!ref || (ref.responses || 0) < rt.TEXT_MIN_RESPONSES) continue;
          sum += rt.textCosine(sample.counts, ref.counts || {});
          used += 1;
        }
        if (used) scored.push({model, score: Number((sum / used).toFixed(4)), used});
      }
      scored.sort((left, right) => right.score - left.score);
      const top = scored[0] || null, second = scored[1] || null;
      let verdict = 'insufficient';
      if (top) verdict = second && top.score - second.score < 0.03 ? 'tied' : 'candidate';
      return {available, scored: scored.slice(0, 5), verdict, top, second};
    })().then(reply, error => reply({error: String(error?.message || error)}));
    return true;
  }


  if (message?.type === 'AMP_RHYTHM_PROFILE') {
    (async () => {
      const profile = rhythmProfile(netState.pendingStreams);
      const profiles = await readStore(RHYTHM_KEY, {});
      const modelId = traceState.status === 'ok' ? traceState.name : null;
      if (modelId && profile?.enough) {
        profiles[modelId] = rhythmAccumulate(profiles[modelId], profile);
        await writeStore({[RHYTHM_KEY]: profiles});
        netState.pendingStreams = [];
      }
      return {profile, vote: rhythmVote(profile, profiles), baseline: Object.keys(profiles)};
    })().then(reply, error => reply({error: String(error?.message || error)}));
    return true;
  }

  if (message?.type === 'AMP_RHYTHM_VOTE') {
    (async () => {
      const profiles = await readStore(RHYTHM_KEY, {});
      const profile = rhythmProfile(netState.pendingStreams);
      return {vote: rhythmVote(profile, profiles), profile, baseline: Object.keys(profiles)};
    })().then(reply, error => reply({error: String(error?.message || error)}));
    return true;
  }

});
