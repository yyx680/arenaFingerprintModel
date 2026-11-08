import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {costDetailFromSession} from '../price-channel.js';
import {describeTotals, ledgerTotals, ledgerRowsFromCostMessages} from '../cost-ledger.js';
import * as ledgerMod from '../cost-ledger.js';
import * as priceMod from '../price-channel.js';
import * as pricingMod from '../pricing-channel.js';
import * as usageMod from '../usage-channel.js';

/* ---------- v2.16.0 官方成本通道（PostHog 覆写 cookie → /cost 200 逐条账单） ----------
   fixture 是 2026-10-12 CDP 真机实测：Agent 会话 01a12c2a-f113-73b4-ad1b-a9d6c8a3f01b，
   无 cookie 403 / 带 cookie 200 / 删 cookie 回到 403。
   自洽校验（实测值）：Σmessages.base == aggregate.basePriceUsd；charged == base×2；
   credits == charged×1000；session.actualTotalUsd == Σmessages.actual。 */

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const LIVE = JSON.parse(JSON.parse(read('dev-scratch/amp_livecost3.json')).r2.body);   // r2.body 本身是 JSON 文本，要二次 parse
const SESSION = LIVE.session;
const MESSAGES = LIVE.messages;
const MESSAGE_IDS = Object.keys(MESSAGES);
const AGENT_PATH = '/api/chat/01a12c2a-f113-73b4-ad1b-a9d6c8a3f01b/cost?includeSession=true';
const EVAL_PATH = '/api/evaluation/01a12c2a-f113-73b4-ad1b-a9d6c8a3f01b/cost';
const SESSION_ID = '01a12c2a-f113-73b4-ad1b-a9d6c8a3f01b';   // probeCostRoute 用会话 id 自己拼路径;
const UNAUTHORIZED = JSON.stringify({error: 'Unauthorized'});                            // 24B：灰度门未过
const NOT_OWNER = JSON.stringify({error: 'User does not own session "01a12ca1"'});       // 78B：会话不归当前账号

test('fixture 自洽：逐条之和 == 会话级聚合（服务端口径对得上）', () => {
  const sum = key => Object.values(MESSAGES).reduce((acc, m) => acc + Number(m[key]), 0);
  assert.equal(MESSAGE_IDS.length, 5);
  assert.ok(Math.abs(sum('basePriceUsd') - SESSION.aggregate.basePriceUsd) < 1e-12, 'Σbase == aggregate.basePriceUsd');
  assert.ok(Math.abs(sum('totalChargedUsd') - SESSION.aggregate.totalChargedUsd) < 1e-12, 'Σcharged == aggregate.totalChargedUsd');
  assert.ok(Math.abs(sum('totalChargedCredits') - SESSION.aggregate.totalChargedCredits) < 1e-9, 'Σcredits == aggregate.totalChargedCredits');
  assert.ok(Math.abs(SESSION.chargedTotalUsd - SESSION.aggregate.basePriceUsd * SESSION.aggregate.marginMultiplier) < 1e-12, 'charged == base × marginMultiplier');
  assert.ok(Math.abs(SESSION.aggregate.totalChargedCredits - SESSION.chargedTotalUsd * 1000) < 1e-9, 'credits == charged × 1000');
  const sumActual = Object.values(MESSAGES).reduce((acc, m) => acc + Number(m.actual.totalCostUsd), 0);
  assert.ok(Math.abs(sumActual - SESSION.actualTotalUsd) < 1e-12, 'Σactual == session.actualTotalUsd');
});

/* content.js 的 cookie 策略是从 IIFE 里抠出来在 vm 沙箱跑的（network-sniffer / work-compat
   同套路）。snippet 边界用标志串锚定：代码挪位时这里立刻炸，而不是静默测个空。 */
const CONTENT = read('content.js');
const SNIP_START = CONTENT.indexOf('const PH_OVERRIDE_KEY=');
const SNIP_END = CONTENT.indexOf('async function refreshLedger(');
assert.ok(SNIP_START > 0 && SNIP_END > SNIP_START, 'content.js 应含 PostHog 覆写 cookie 逻辑');
const COOKIE_SNIPPET = CONTENT.slice(SNIP_START, SNIP_END);
const COST_SHOWN_JSON = JSON.stringify({'credit-system-m1': 'cost-shown'});   // writePhOverride 的入参形态（未编码）
const COST_SHOWN_COOKIE = encodeURIComponent(COST_SHOWN_JSON);                // document.cookie 里的形态（编码）

/* 可编程 fetch：按 path 给响应；每次调用顺手记下「当时 cookie jar 里有什么」——
   这样「请求期间 cookie 在、请求之后被删」才能被测出来。 */
function makeFetch(views, jar) {
  const calls = [];
  const fetch = async path => {
    calls.push({path, cookie: jar ? [...jar.entries()] : []});
    const view = views[path] || {};
    if (view.throw) throw new Error('boom');
    const status = view.status === undefined ? 200 : view.status;
    return {
      ok: status === 200,
      status,
      json: async () => {
        if (view.raw !== undefined) throw new Error('not json');
        if (view.body === undefined) throw new Error('no body');
        return typeof view.body === 'string' ? JSON.parse(view.body) : view.body;
      },
      text: async () => (typeof view.body === 'string' ? view.body : JSON.stringify(view.body ?? {})),
    };
  };
  fetch.calls = calls;
  return fetch;
}
const OK = body => ({status: 200, body});
const DENIED = text => ({status: 403, body: text});

/* 简易 document.cookie jar：Max-Age=0 → 删除；clears=false 模拟「删不掉」的死 cookie。 */
function makeContentCtx(views, {clears = true, battle = false} = {}) {
  const jar = new Map();
  const document = {
    get cookie() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(text) {
      const [pair, ...attrs] = String(text).split(';').map(part => part.trim());
      const eq = pair.indexOf('=');
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const maxAgeAttr = attrs.find(attr => /^max-age=/i.test(attr));
      const maxAge = maxAgeAttr ? Number(maxAgeAttr.split('=')[1]) : null;
      if (maxAge !== null && maxAge <= 0) { if (clears) jar.delete(key); return; }
      jar.set(key, value);
    },
  };
  const fetch = makeFetch(views, jar);
  const ctx = vm.createContext({document, fetch, battleMode: () => battle, ARENA_API_PROBES: true});
  vm.runInContext(COOKIE_SNIPPET + '\nglobalThis.api={fetchCostPath, probeCostRoute, readPhOverride, writePhOverride, clearPhOverride, PH_OVERRIDE_KEY, PH_COST_SHOWN};', ctx);
  return {ctx, api: ctx.api, jar, fetch};
}
const COOKIE_KEY = 'ph-toolbar-overrides';

/* ==================== ① cookie 礼貌策略三态 ==================== */

test('cookie 三态之「原本没有」：临时写 60s → 请求带着它 → 读完必删', async () => {
  const {api, jar, fetch} = makeContentCtx({[AGENT_PATH]: OK(LIVE)});
  const probe = await api.fetchCostPath(AGENT_PATH);
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.payload, LIVE, 'payload 原样带回，供后台摊明细');
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(fetch.calls[0].cookie, [[COOKIE_KEY, COST_SHOWN_COOKIE]], '请求期间覆写 cookie 必须在场');
  assert.equal(jar.size, 0, '读完即删，不留后门');
});

test('cookie 三态之「值相同」：直接用，读完不删（用户自己开的成本显示）', async () => {
  const {api, jar, fetch} = makeContentCtx({[AGENT_PATH]: OK(LIVE)});
  jar.set(COOKIE_KEY, COST_SHOWN_COOKIE);
  const probe = await api.fetchCostPath(AGENT_PATH);
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.payload, LIVE);
  assert.deepEqual(jar.get(COOKIE_KEY), COST_SHOWN_COOKIE, '同值 = 用户自己的选择，不能删');
});

test('cookie 三态之「值不同」：不覆盖、不请求，本通道待命', async () => {
  const {api, jar, fetch} = makeContentCtx({[AGENT_PATH]: OK(LIVE)});
  const mine = encodeURIComponent(JSON.stringify({'credit-system-m1': 'other-flag'}));
  jar.set(COOKIE_KEY, mine);
  const probe = await api.fetchCostPath(AGENT_PATH);
  assert.equal(probe.status, 403);
  assert.equal(probe.reason, 'user-override-exists');
  assert.equal(fetch.calls.length, 0, '用户已有覆写 ∩ 值不同 → 一个请求都不发');
  assert.equal(jar.get(COOKIE_KEY), mine, '原值保持不动，网站自己的设置赢');
});

test('临时 cookie 删不掉：200 也标 cookie-stuck，数据不可信', async () => {
  const {api, jar} = makeContentCtx({[AGENT_PATH]: OK(LIVE)}, {clears: false});
  const probe = await api.fetchCostPath(AGENT_PATH);
  assert.equal(probe.status, 200);
  assert.equal(probe.reason, 'cookie-stuck', '清理失败必须标进 reason，调用方按无数据处理');
  assert.ok(jar.has(COOKIE_KEY), '死 cookie 还原术失效 —— 沙箱里它确实还在');
});

/* ==================== ② 403 分型 ==================== */

test('403 分型：24B Unauthorized = 灰度门未过', async () => {
  const {api, jar, fetch} = makeContentCtx({[AGENT_PATH]: DENIED(UNAUTHORIZED)});
  const probe = await api.fetchCostPath(AGENT_PATH);
  assert.equal(probe.status, 403);
  assert.equal(probe.reason, 'unauthorized');
  assert.equal(jar.size, 0, '失败也打扫干净');
});

test('403 分型：78B User does not own session = 门过了但会话不归本账号', async () => {
  const {api, jar} = makeContentCtx({[AGENT_PATH]: DENIED(NOT_OWNER)});
  const probe = await api.fetchCostPath(AGENT_PATH);
  assert.equal(probe.status, 403);
  assert.equal(probe.reason, 'not-owner', '与门禁未过是两回事，别混');
  assert.equal(jar.size, 0);
});

test('网络错误 / 响应不可解析：如实报，不猜', async () => {
  const netCtx = makeContentCtx({[AGENT_PATH]: {throw: true}});
  const net = await netCtx.api.fetchCostPath(AGENT_PATH);
  assert.equal(net.status, 0);
  assert.equal(net.reason, 'network');
  assert.equal(netCtx.jar.size, 0);

  const rawCtx = makeContentCtx({[AGENT_PATH]: {status: 200, raw: 'not json'}});
  const raw = await rawCtx.api.fetchCostPath(AGENT_PATH);
  assert.equal(raw.status, 200, 'HTTP 层确实 200');
  assert.equal(raw.reason, 'bad-json');
  assert.equal(raw.payload, undefined, '解不出 JSON 就没有 payload');
  assert.equal(rawCtx.jar.size, 0);
});

/* ==================== ③ probeCostRoute 的路径试探 ==================== */

test('probeCostRoute：Agent 模式 chat 路径 404 → 换 evaluation 路径（实测顺序）', async () => {
  const ctx = makeContentCtx({[AGENT_PATH]: {status: 404}, [EVAL_PATH]: OK(LIVE)});
  const probe = await ctx.api.probeCostRoute(SESSION_ID);
  assert.equal(probe.status, 200);
  assert.equal(probe.path, EVAL_PATH, '第二条路径命中');
  assert.equal(ctx.fetch.calls.length, 2);
  assert.equal(ctx.jar.size, 0, '成功路径也读完即删');
});

test('probeCostRoute：chat 路径 200 但不可解析 → 继续试 evaluation', async () => {
  const {api, fetch} = makeContentCtx({[AGENT_PATH]: {status: 200, raw: 'not json'}, [EVAL_PATH]: OK(LIVE)});
  const probe = await api.probeCostRoute(SESSION_ID);
  assert.equal(probe.path, EVAL_PATH);
  assert.equal(fetch.calls.length, 2);
});

test('probeCostRoute：403 即停（门禁/归属已定，换路径也一样）', async () => {
  const {api, fetch} = makeContentCtx({[AGENT_PATH]: DENIED(NOT_OWNER), [EVAL_PATH]: OK(LIVE)});
  const probe = await api.probeCostRoute(SESSION_ID);
  assert.equal(probe.reason, 'not-owner');
  assert.equal(fetch.calls.length, 1, '不浪费时间试第二条');
});

test('probeCostRoute：两条路都 404 → null，浮层按无数据处理', async () => {
  const {api} = makeContentCtx({[AGENT_PATH]: {status: 404}, [EVAL_PATH]: {status: 404}});
  assert.equal(await api.probeCostRoute(SESSION_ID), null);
  assert.equal(await api.probeCostRoute(''), null, '没有会话 id 直接放弃');
});

test('probeCostRoute：Battle 模式只试 evaluation 一条路', async () => {
  const {api, fetch} = makeContentCtx({[EVAL_PATH]: DENIED(UNAUTHORIZED)}, {battle: true});
  const probe = await api.probeCostRoute(SESSION_ID);
  assert.equal(probe.status, 403);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].path, EVAL_PATH, 'Battle 不碰 /api/chat');
});

test('refreshLedger 只外传可信账单：200+reason 一律不外送', () => {
  /* 源码级断言（浮层主路径没有 DOM 可测）：带 reason 的 200（bad-json / cookie-stuck）
     既不发 AMP_COST_PAYLOAD，也不作 costPayload 上传层。
     v2.17.0 起第三处：价格指纹通道拉 AMP_COST_REVERSE 时同样只传可信账单。
     v2.18.0 起第四处：价格指纹独立模式拉 AMP_PRICE_FULL 时同样只传可信账单。 */
  const guarded = CONTENT.match(/probe\?\.status===200&&!probe\.reason/g) || [];
  assert.equal(guarded.length, 4, 'AMP_COST_PAYLOAD / AMP_LEDGER / AMP_COST_REVERSE / AMP_PRICE_FULL 四处上送都要过 !reason 闸门');
});

/* ==================== ④ background 沙箱：清洗 / 优先级 / 账本 ====================
   work-compat.test.mjs 同套路：剥掉 import 行后在 vm 里跑 background.js，
   这次注入的是**真实模块实现**（只有 chrome API 是 stub）。 */

function makeBgApi() {
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
    loadProbeBank: async () => null,
    countNumbers: () => 0, parseNumbers: () => [],
    queryRunTrace: async () => null,
    rhythmProfile: () => ({}), rhythmVote: () => null, rhythmAccumulate: () => ({}),
    normalizeCostTable: () => null, crossCheckCost: () => null,
    observedCostFromSignals: () => null, observedCostDetail: () => null,
    describeCostDetail: () => '', chargedFromBase: () => null, TIER_LABEL: {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('background.js').replace(/^import .*;\r?\n/gm, '')
    + '\nglobalThis.api={cleanOfficialCost, observedCostActual, ledgerBlock, ledgerSummarySync, netState};', ctx);
  return ctx.api;
}

const bg = makeBgApi();
const COST_MESSAGE = {type: 'AMP_COST_PAYLOAD', route: 'cost-api', path: AGENT_PATH, session: SESSION, messages: MESSAGES, at: 1770000000000};
/* vm 沙箱里产出的对象带沙箱 realm 的 prototype，deepStrictEqual 会误判 —— 序列化归一化再比
   （顺带验证「可 JSON 序列化」，反正 netState 里存的就要能进 chrome.storage）。 */
const plain = value => JSON.parse(JSON.stringify(value));
function resetOfficial(value) {
  bg.netState.officialCost = value;
  bg.netState.costRouteSignals = [];
  bg.netState.costSignals = [];
  bg.netState.messageUsage = [];
  bg.netState.transcriptEstimates = [];
  bg.netState.costGate = null;
}

test('cleanOfficialCost：真实 200 账单按白名单落型（aggregate 子对象保留）', () => {
  const clean = bg.cleanOfficialCost(COST_MESSAGE);
  assert.equal(clean.route, 'cost-api');
  assert.equal(clean.path, AGENT_PATH);
  assert.equal(clean.at, 1770000000000);
  assert.deepStrictEqual(plain(clean.session), {
    actualTotalUsd: 0.004122368, chargedTotalUsd: 0.0033874648, basePriceUsd: null,
    costMultiplier: null, marginMultiplier: null, messageCount: 5,
    aggregate: {basePriceUsd: 0.0016937324, totalChargedUsd: 0.0033874648, totalChargedCredits: 3.3874648},
  }, 'session 顶层无 base/margin（都在 aggregate 里）→ 顶层字段 null，不臆造');
  assert.equal(Object.keys(clean.messages).length, 5);
  const first = clean.messages[MESSAGE_IDS[0]];
  assert.deepStrictEqual(plain(first), {
    basePriceUsd: 0.0007117024, totalCostUsd: 0.0018288640000000001, totalChargedUsd: 0.0014234048,
    totalChargedCredits: 1.4234048000000001, pricingStrategy: 'agent_p50', marginMultiplier: 2, discountPercent: 0,
  }, '逐条摊平：actual 子对象提上来，来源字段一律丢弃');
  for (const row of Object.values(clean.messages)) {
    assert.ok(!('actual' in row) && !('isFallback' in row) && !('source' in row), '不接服务端内部字段');
  }
});

test('cleanOfficialCost：junk / 超量级 / 超条数 / 全空行', () => {
  assert.equal(bg.cleanOfficialCost(null), null);
  assert.equal(bg.cleanOfficialCost({}), null, 'session / messages 都没有 → 不收');
  assert.equal(bg.cleanOfficialCost({session: 'x', messages: 3}), null, '类型不对按没有处理');
  assert.equal(bg.cleanOfficialCost({messages: {m1: {junk: 'x'}}}), null, '全 null 行 + 无 session → 整份丢弃');
  assert.equal(bg.cleanOfficialCost({messages: {m1: {basePriceUsd: 1e9}}}), null, '超出 1e7 量级视为脏数据');
  assert.equal(bg.cleanOfficialCost({messages: {m1: {basePriceUsd: -5}}}), null, '负数行全 null 被跳过，无 session → 整份丢弃');
  const neg = bg.cleanOfficialCost({session: {actualTotalUsd: 0.1}, messages: {m1: {basePriceUsd: -5, totalChargedUsd: 0.2}}});
  assert.equal(neg.messages.m1.basePriceUsd, null, '有 session 保住容器，行内负数变 null');
  assert.equal(neg.messages.m1.totalChargedUsd, 0.2, '同行的有效字段照常保留');
  // 101 条只留前 100
  const many = {messages: {}};
  for (let i = 0; i < 101; i++) many.messages['m' + i] = {basePriceUsd: 0.001};
  assert.equal(Object.keys(bg.cleanOfficialCost(many).messages).length, 100);
  // pricingStrategy 截到 40 字符；route/path 截断；at 非法回退 now
  const long = bg.cleanOfficialCost({route: 'r'.repeat(80), path: 'p'.repeat(300), at: 'nope', messages: {m1: {pricingStrategy: 's'.repeat(80), basePriceUsd: 0.001}}});
  assert.equal(long.route.length, 40);
  assert.equal(long.path.length, 200);
  assert.ok(Number.isFinite(long.at) && long.at > 1e12, 'at 非法 → Date.now()');
  assert.equal(long.messages.m1.pricingStrategy.length, 40);
  // 全 null 的行被跳过，有数的行保留
  const mixed = bg.cleanOfficialCost({messages: {gone: {}, stay: {basePriceUsd: 0.5}}});
  assert.deepEqual(Object.keys(mixed.messages), ['stay']);
});

test('observedCostActual：官方 session 优先（via official-cost/session）', () => {
  resetOfficial(bg.cleanOfficialCost(COST_MESSAGE));
  const got = bg.observedCostActual();
  assert.equal(got.via, 'official-cost/session');
  assert.ok(Math.abs(got.usd - 0.0016937324) < 1e-12, '按公开单价比较必须用 aggregate.basePriceUsd');
  assert.ok(Math.abs(got.detail.base_usd - 0.0016937324) < 1e-12, 'detail.base 来自 aggregate');
  assert.ok(Math.abs(got.detail.actual_usd - 0.004122368) < 1e-12, 'actualTotalUsd 保留为上游 actual');
  assert.ok(Math.abs(got.detail.credits - 3.3874648) < 1e-9);
  assert.equal(got.detail.multiplier, 2);
});

test('observedCostActual：session 无值时回退逐条求和（via official-cost/messages）', () => {
  resetOfficial({session: {}, messages: {a: {basePriceUsd: 0.0004, totalCostUsd: 0.001}, b: {basePriceUsd: 0.0006, totalCostUsd: 0.002}, c: {}}});
  const got = bg.observedCostActual();
  assert.equal(got.via, 'official-cost/messages');
  assert.equal(got.usd, 0.001, '逐条只合计 explicit base，不合计 upstream totalCostUsd');
});

test('observedCostActual：仅有上游 actual 的 cost-route 不参与公开单价比较', () => {
  resetOfficial(null);
  bg.netState.costRouteSignals = [{session: {actualTotalUsd: 1.5, chargedTotalUsd: 3}, messages: [{message_id: 'm', actual_usd: 1.5}]}];
  assert.equal(bg.observedCostActual(), null, 'actualTotalUsd / actual_usd 都不是 explicit Arena base');
});

test('observedCostActual：官方不在位时 cost-route 优先取 aggregate.base 与逐条 base', () => {
  resetOfficial(null);
  bg.netState.costRouteSignals = [{session: {actualTotalUsd: 1.5, chargedTotalUsd: 3, aggregate: {basePriceUsd: 0.75}}, messages: [{message_id: 'm', base_usd: 0.5, actual_usd: 1.5}]}];
  const got = bg.observedCostActual();
  assert.equal(got.via, 'cost-route/session');
  assert.equal(got.usd, 0.75);
  resetOfficial(null);
  assert.equal(bg.observedCostActual(), null, '什么都没有 → null，绝不编');
});

/* ==================== ⑤ ledgerBlock 两条来路 + 汇总优先 ==================== */

test('ledgerBlock 弹窗路径：不传 costPayload，回落 netState.officialCost 出官方明细', async () => {
  resetOfficial(bg.cleanOfficialCost(COST_MESSAGE));
  const block = await bg.ledgerBlock();
  assert.equal(block.mode, 'cost-route');
  assert.equal(block.cost_rows, 5);
  assert.equal(block.rows.length, 5);
  assert.equal(block.rows[0].source, 'cost-route', '官方行标服务端口径');
  assert.equal(block.rows[0].tokens, null, 'Agent 模式没有 token 用量 —— 绝不假装有');
  const t = block.totals;
  assert.equal(t.messages, 5);
  assert.equal(t.base_usd, 0.001694, 'base 合计 == ΣbasePriceUsd（ledgerTotals 保留 6 位）');
  assert.equal(t.charged_usd, 0.003387);
  assert.ok(Math.abs(t.credits - 3.387465) < 1e-9);
  assert.equal(t.multiplier, 2);
  assert.equal(t.actual_usd, 0.004122, 'actual 合计 == ΣtotalCostUsd（上游口径）');
  assert.deepEqual(plain(block.official), {at: 1770000000000, path: AGENT_PATH, messages: 5});
  assert.equal(block.reverse.blocked, 'no-usage', '有真实成本但 Agent 无用量 → 按价反推待命');
  assert.match(block.reverse.note, /Agent 会话没有逐条 token 用量/);
  assert.match(block.note, /PostHog 覆写 cookie/);
  assert.equal(block.gate, null);
});

test('ledgerBlock 浮层路径：costPayload 由浮层传入时同样出官方明细', async () => {
  resetOfficial(null);
  const block = await bg.ledgerBlock({costPayload: LIVE});
  assert.equal(block.mode, 'cost-route');
  assert.equal(block.cost_rows, 5);
  assert.equal(block.official, null, '未走 AMP_COST_PAYLOAD → official 标记为 null，honest 标记来源');
  assert.match(block.note, /灰度门经 PostHog 覆写 cookie 临时放行/);
});

test('ledgerBlock：官方账单与用量都没有 → blocked，不编数字', async () => {
  resetOfficial(null);
  const block = await bg.ledgerBlock();
  assert.equal(block.mode, 'blocked');
  assert.equal(block.cost_rows, 0);
  assert.equal(block.rows.length, 0);
  assert.equal(block.totals.messages, 0);
  assert.equal(block.reverse.blocked, 'no-observed-cost');
});

test('ledgerSummarySync：官方账单优先于单价表自算路径', () => {
  resetOfficial(bg.cleanOfficialCost(COST_MESSAGE));
  const summary = bg.ledgerSummarySync();
  assert.equal(summary.mode, 'cost-route');
  assert.equal(summary.messages, 5);
  assert.equal(summary.base_usd, 0.001694);
  assert.match(summary.text, /^5 条/);
  assert.match(summary.text, /积分/);
  resetOfficial(null);
  assert.equal(bg.ledgerSummarySync().mode, 'blocked');
});

/* ==================== ⑥ costDetailFromSession / describeTotals（纯函数直测） ==================== */

test('costDetailFromSession：真实 session 的 base/credits 走 aggregate 回退', () => {
  const detail = costDetailFromSession(SESSION);
  assert.ok(Math.abs(detail.base_usd - 0.0016937324) < 1e-12, '顶层无 basePriceUsd → 回退 aggregate');
  assert.equal(detail.charged_usd, 0.0033874648);
  assert.ok(Math.abs(detail.credits - 3.3874648) < 1e-9, 'credits 只在 aggregate 里有');
  assert.equal(detail.multiplier, 2);
  assert.equal(detail.actual_usd, 0.004122368);
  assert.equal(detail.source, 'cost-route/session');
});

test('costDetailFromSession：顶层优先于 aggregate；倍率可推；空值拒收', () => {
  const top = costDetailFromSession({basePriceUsd: 0.5, chargedTotalUsd: 1, aggregate: {basePriceUsd: 9, totalChargedUsd: 18}});
  assert.equal(top.base_usd, 0.5, '顶层字段赢');
  assert.equal(top.charged_usd, 1);
  const pushed = costDetailFromSession({basePriceUsd: 0.01, chargedTotalUsd: 0.02});
  assert.equal(pushed.multiplier, 2, '无 marginMultiplier → 由 charged/base 推');
  assert.equal(costDetailFromSession({}), null);
  assert.equal(costDetailFromSession(null), null);
  assert.equal(costDetailFromSession({messageCount: 5}), null, '全无数值 → null');
});

test('describeTotals：官方账单 actual ≠ base 时报上游成本合计', () => {
  const totals = ledgerTotals(ledgerRowsFromCostMessages(MESSAGES));
  const text = describeTotals(totals);
  assert.match(text, /^5 条/);
  assert.match(text, /基准价合计 \$0\.001694/);
  assert.match(text, /实扣合计 \$0\.003387/);
  assert.match(text, /3\.39 积分/);
  assert.match(text, /上游成本合计 \$0\.004122/, 'actual（上游口径）与 base（Arena 计价）分开报');
  assert.match(text, /×2/);
});

test('describeTotals：actual == base 时不出现上游成本行', () => {
  const flat = ledgerTotals(ledgerRowsFromCostMessages({m: {basePriceUsd: 0.01, totalCostUsd: 0.01, totalChargedUsd: 0.02, totalChargedCredits: 20}}));
  assert.ok(!describeTotals(flat).includes('上游成本合计'), '同口径就不多这一行');
  assert.match(describeTotals(flat), /实扣合计 \$0\.02/);
});
