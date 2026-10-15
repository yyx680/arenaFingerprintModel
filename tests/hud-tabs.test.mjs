/* v2.19.1 浮层 Tab 布局 + 消费级明细表。
   用户需求（截图）：浮层可切 Tab；价格指纹与数字指纹的结果都要展示；轨迹直读不再独立展示；
   价格指纹面板里把「消费级明细」按表格展示。
   本组测试用最小 DOM stub 真跑 createHud / renderPricePanel / renderCostTable，
   再补几条源码级断言，防止以后改样式时把结构改回去。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

/* ---------- 最小 DOM stub：够 content.js 跑通 createHud/renderCostTable 即可 ---------- */
const created = [];
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {setProperty() {}, removeProperty() {}},
    classList: {_s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); }},
    _text: '', hidden: false, title: '',
    append(...kids) { for (const k of kids) { if (k && k.tagName === 'FRAGMENT') this.children.push(...(k.children || [])); else this.children.push(k); } },
    appendChild(k) { this.children.push(k); return k; },
    replaceChildren(...kids) { this.children = kids; },
    prepend(...kids) { this.children.unshift(...kids); },
    querySelector(sel) { return findIn(this, sel); },
    querySelectorAll() { return []; },
    closest() { return null; },
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(type, event = {}) { for (const fn of this._listeners[type] || []) fn({ preventDefault() {}, ...event }); },
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect() { return {left: 100, top: 200, right: 440, bottom: 600, width: 340, height: 400}; },
    get offsetWidth() { return 340; },
    get offsetHeight() { return 400; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    attachShadow() { return this._shadow || (this._shadow = makeEl('shadow')); },
    cloneNode() { return makeEl(this.tagName); },
    remove() {},
    get isConnected() { return true; },
    get clientRects() { return [1]; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); if (v === '') this.children = []; },
    get innerText() { return this._text; },
    set innerText(v) { this._text = String(v); },
    get value() { return this._value ?? ''; },
    set value(v) { this._value = v; },
    get className() { return [...this.classList._s].join(' '); },
    set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
  };
  el.style = Object.assign(el.style, {cssText: ''});
  created.push(el);
  return el;
}
function findIn(root, sel) {
  const queue = [...root.children];
  while (queue.length) {
    const node = queue.shift();
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    if (cls && node.classList?.contains(cls)) return node;
    if (node.tagName === sel.toUpperCase()) return node;
    queue.push(...(node.children || []));
  }
  return null;
}

const documentEl = makeEl('html');
const document = {
  documentElement: documentEl,
  body: makeEl('body'),
  getElementById() { return null; },
  createElement: makeEl,
  createDocumentFragment: () => makeEl('fragment'),
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {}, dispatchEvent() {},
  get activeElement() { return null; },
  cookie: '',
};
const sandbox = {
  __ampTestHook: true,
  console, URL, Date, Math, JSON, Number, String, Array, Object, Set, Map, Promise, Error, RegExp, crypto: {randomUUID: () => 'x'},
  document, window: {addEventListener() {}, navigation: null, scrollTo() {}, postMessage() {}, innerWidth: 1280, innerHeight: 900},
  location: {origin: 'https://arena.ai', pathname: '/agent/test-12345678', href: 'https://arena.ai/agent/test-12345678'},
  getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
  MutationObserver: class { observe() {} disconnect() {} },
  PointerEvent: class {}, KeyboardEvent: class {}, Event: class {},
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, queueMicrotask,
  get localStorage() { return {getItem: () => null, setItem() {}}; },
  chrome: {
    runtime: {
      getURL: (p) => p, id: 'test', lastError: null,
      getManifest: () => ({permissions: ['storage']}),
      onMessage: {addListener() {}}, onConnect: {addListener() {}},
      sendMessage: async () => ({}), connect: () => ({onMessage: {addListener() {}}, onDisconnect: {addListener() {}}, postMessage() {}}),
    },
    permissions: {contains: async () => true, request: async () => true},
    storage: {local: {get: async () => ({}), set: async () => {}, remove: async () => {}}},
    tabs: {onRemoved: {addListener() {}}},
  },
  ArenaProbeRuntime: {
    probes: [], sceneProbes: [], signatures: [], TEXT_PROBES: [], TEXT_SCORE_PROBES: [],
    selectCandidate: () => null, planProbes: () => [], renameTitleForResult: (x) => x,
    isTaskSuccessText: () => false, isContinueWorkText: () => false,
    sceneParseChoice: () => null, sceneParsePick: () => null, sceneVote: () => null,
    validateScene: () => false, findSceneSentence: () => null, sceneKeyOf: () => null, sceneClusterOf: () => null,
    TEXT_BANK_TARGET: 0,
  },
  ArenaProbeRename: undefined,
};

const ctx = vm.createContext(sandbox);
let loadError = null;
try {
  vm.runInContext(read('content.js'), ctx, {filename: 'content.js'});
} catch (err) {
  loadError = err;
}

/* ---------- 行为级：加载与结构 ---------- */

test('content.js：最小 DOM 下加载无异常（createHud 全路径可跑）', () => {
  assert.equal(loadError, null, loadError && loadError.stack);
});

test('浮层：Tab 布局 —— 3 个页签挂在 .body 下、文案为数字指纹/价格指纹/花费', () => {
  const api = ctx.__ampTest;
  assert.ok(api, '测试钩子应已导出（__ampTestHook=true）');
  assert.deepEqual(Object.keys(api.tabs), ['numeric', 'price', 'cost'], '三个页签 key');
  assert.equal(api.tabs.price.children[0].textContent, '价格指纹', '页签文案');
  const bar = findIn(findIn(created.map(n => n._shadow).find(Boolean), '.box'), '.tabs');
  assert.ok(bar, '.body 下应有 .tabs 容器');
  assert.equal(bar.children.length, 3, '.tabs 应有 3 个按钮');
});

test('浮层：三个面板共用一个 .body 滚动区，价格面板带 price-panel 类', () => {
  const api = ctx.__ampTest;
  assert.deepEqual(Object.keys(api.panels), ['numeric', 'price', 'cost'], '三个面板');
  assert.ok(api.panels.price.classList.contains('price-panel'), '价格面板标记 price-panel');
  const shadow = created.map(n => n._shadow).find(Boolean);
  const body = findIn(findIn(shadow, '.box'), '.body');
  const direct = body.children.filter(c => c.classList?.contains('panel'));
  assert.equal(direct.length, 3, '.body 直接子代应有 3 个面板');
});

test('浮层：轨迹直读不再作为独立卡片（并入数字指纹面板）', () => {
  const api = ctx.__ampTest;
  const shadow = created.map(n => n._shadow).find(Boolean);
  const numeric = api.panels.numeric;
  /* trace 节点必须在数字面板内，而不是独立挂在 body 下。 */
  assert.ok(!findIn(api.panels.price, '.trace'), '价格面板不含轨迹节点');
  assert.ok(!findIn(api.panels.cost, '.trace'), '花费面板不含轨迹节点');
  assert.equal(findIn(shadow, '.box div.body > .trace'), null, '轨迹不再是 body 的直接子卡片');
});

test('价格面板：消费级明细表 6 列（# / Input / Output / Cache写 / Cache读 / 合计）', () => {
  const shadow = created.map(n => n._shadow).find(Boolean);
  const table = findIn(shadow, '.cost-table');
  assert.ok(table, '价格面板应有 .cost-table');
  const headers = table.children[0].children[0].children.map(th => th.textContent);
  assert.deepEqual(headers, ['#', 'Input', 'Output', 'Cache写', 'Cache读', '合计']);
});

/* ---------- 行为级：表格填充 ---------- */

test('renderCostTable：只渲染带四项分项的官方行，合计为四项之和', () => {
  const api = ctx.__ampTest;
  api.ledgerState.data = {rows: [
    {index: 1, base_usd: 0.206319, breakdown: {input_usd: 0.1, output_usd: 0.09, cache_write_usd: 0.016, cache_read_usd: 0.000319}},
    {index: 2, base_usd: 0.05, breakdown: {input_usd: 0.02, output_usd: 0.03, cache_write_usd: 0, cache_read_usd: 0}},
    {index: 3, base_usd: 0.02},   /* 无 breakdown 的非官方行 —— 不该进表 */
  ]};
  api.renderCostTable();
  assert.equal(api.costTableBody.children.length, 2, '只渲染带 breakdown 的 2 行');
  assert.equal(api.costTableFoot.children.length, 1, '一行合计');
  const cells = api.costTableFoot.children[0].children.map(td => td.textContent);
  assert.equal(cells[0], '合计', '首格为「合计」');
  /* 四项分别求和：input .12 / output .12 / write .016 / read .000319，末列 = 四项之和 .256319 */
  assert.equal(cells[1], '$0.120000');
  assert.equal(cells[2], '$0.120000');
  assert.equal(cells[3], '$0.016000');
  assert.equal(cells[4], '$0.000319');
  assert.equal(cells[5], '$0.256319', '末列 = 四项之和（与 base 总和自洽）');
});

test('renderCostTable：没有分项数据时表格隐藏、显示空态提示', () => {
  const api = ctx.__ampTest;
  api.ledgerState.data = {rows: [{index: 1, base_usd: 0.02}]};
  api.renderCostTable();
  assert.equal(api.costTableBody.children.length, 0, 'tbody 清空');
  assert.equal(api.costTableFoot.children.length, 0, 'tfoot 清空');
  assert.equal(api.costTableEmpty.hidden, false, '空态提示可见');
});

/* ---------- 源码级：防样式被改回去 ---------- */

test('content.js：Tab 样式与面板切换语义（.panel.active 才显示）', () => {
  const content = read('content.js');
  assert.match(content, /\.tabs\{flex:none;display:flex/, '.tabs 是固定不滚的 flex 行');
  assert.match(content, /\.tab\.active\{color:#bdf0d4;border-bottom-color:#559174\}/, '当前页签有下边框高亮');
  assert.match(content, /\.panel\{display:none\}/, '非当前面板隐藏');
  assert.match(content, /\.panel\.active\{display:block\}/, '只有 .active 面板显示');
  assert.match(content, /table\.cost-table th\{position:sticky;top:0/, '表头 sticky');
  assert.match(content, /\.cost-scroll\{max-height:210px;overflow:auto\}/, '表格区域独立滚动（防撑高浮层）');
  assert.match(content, /table\.cost-table td\{padding:4px 6px;text-align:right/, '数值列右对齐');
});

test('content.js：页签可点切换 + 选择持久化（重开仍停在原页签）', () => {
  const content = read('content.js');
  assert.match(content, /button\.addEventListener\('click',\(\)=>selectTab\(key\)\)/, '页签点击切换');
  assert.match(content, /const COST_TAB_KEY='amp\.hud\.tab\.v1'/, '页签选择有持久化键');
  assert.match(content, /chrome\.storage\.local\.set\(\{\[COST_TAB_KEY\]:key\}\)/, '切换时写回 storage');
  assert.match(content, /if\(tabs\[tab\]\)selectTab\(tab\)/, '加载时恢复');
});

test('content.js：测试钩子在 createHud 之后导出且用 getter（重建后仍取到最新节点）', () => {
  const content = read('content.js');
  const hookIdx = content.indexOf('globalThis.__ampTest=');
  const hudIdx = content.indexOf('createHud();setInterval(paint,5000)');
  assert.ok(hookIdx > 0 && hudIdx > 0 && hookIdx > hudIdx, '★ 钩子必须在 createHud() 之后（否则节点还是 undefined）');
  assert.match(content, /get costTableBody\(\)\{return costTableBody;\}/, '节点用 getter 导出');
  assert.match(content, /get panels\(\)\{return panels;\}/, 'panels 用 getter 导出');
});

/* ---------- v2.19.2 浮层拖动 ---------- */

test('浮层：标题栏可拖动，拖动后转成 left/top 绝对定位并落盘', () => {
  const api = ctx.__ampTest;
  const shadow = created.map(n => n._shadow).find(Boolean);
  const head = findIn(shadow, '.head');
  assert.ok(head, '.head 存在');
  /* 默认停靠：用 right/bottom，无 left/top。 */
  api.applyHudPos();
  const host = api.host;
  assert.equal(host.style.right, '16px', '默认停靠右下角');
  /* 模拟一次拖动：按下 (150,250) → 移动到 (400,300)。 */
  head.dispatch('pointerdown', {button: 0, pointerId: 1, clientX: 150, clientY: 250});
  head.dispatch('pointermove', {pointerId: 1, clientX: 400, clientY: 300});
  head.dispatch('pointerup', {pointerId: 1});
  assert.ok(api.pos, '拖动后记录了位置');
  assert.equal(api.pos.left, 400 - (150 - 100), 'left = 指针位移后的浮层左边');
  assert.equal(api.pos.top, 300 - (250 - 200), 'top = 指针位移后的浮层上边');
  assert.equal(host.style.left, `${api.pos.left}px`, 'host 用 left 定位');
  assert.equal(host.style.right, 'auto', 'right 让位给 left');
  assert.equal(host.style.top, `${api.pos.top}px`, 'host 用 top 定位');
  assert.equal(host.style.bottom, 'auto', 'bottom 让位给 top');
});

test('浮层：单击标题栏（位移<3px）不算拖动，保持默认停靠', () => {
  const api = ctx.__ampTest;
  const shadow = created.map(n => n._shadow).find(Boolean);
  const head = findIn(shadow, '.head');
  const before = {left: api.host.style.left, top: api.host.style.top, right: api.host.style.right};
  head.dispatch('pointerdown', {button: 0, pointerId: 2, clientX: 150, clientY: 250});
  head.dispatch('pointermove', {pointerId: 2, clientX: 151, clientY: 250});   // 1px 抖动
  head.dispatch('pointerup', {pointerId: 2});
  assert.deepEqual({left: api.host.style.left, top: api.host.style.top, right: api.host.style.right}, before, '死区内位置不变');
});

test('content.js：拖动样式与实现要点（标题栏 cursor:move / 边界夹紧 / 位置持久化）', () => {
  const content = read('content.js');
  assert.match(content, /\.head\{[^}]*cursor:move;user-select:none;touch-action:none\}/, '标题栏 cursor:move 且禁选/禁滚动');
  assert.match(content, /const POS_KEY='amp\.hud\.pos\.v1'/, '位置持久化键');
  assert.match(content, /installDrag\(head\)/, 'createHud 里给标题栏装拖动');
  assert.match(content, /chrome\.storage\.local\.set\(\{\[POS_KEY\]:next\}\)/, '拖动结束落盘');
  assert.match(content, /Math\.max\(-width\+40,pos\.left\)/, '★ 左边界夹紧（至少留 40px 在视口内）');
  assert.match(content, /const maxLeft=Math\.max\(0,window\.innerWidth-width-4\)/, '右边界夹紧');
  assert.match(content, /applyHudPos\(\);\s*$|\n\s+applyHudPos\(\);/m, 'renderHud 每拍应用位置');
  assert.match(content, /Number\.isFinite\(Number\(savedPos\.left\)\)/, '加载时恢复位置并校验');
});

/* ---------- v2.19.3 未唯一定名时的候选列表 ---------- */

test('未唯一定名：候选列表展示硬筛选候选 + 软判据 top + 同价组 + 费率不全', () => {
  const api = ctx.__ampTest;
  const view = {
    separable: false,
    reason: 'not-separable',
    hit: {model_key: 'claude-opus-5.5-high-vertex-agent', label: 'Claude Opus 5.5 (High)', ratio: 1.299, implied_usd_per_mtok: 12.5},
    runner_up: {model_key: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', ratio: 1.01},
    hard_filter: {
      checked_models: 208,
      state: 'multiple',
      candidates: [
        {model_key: 'claude-opus-5.5-high-vertex-agent', display: 'Claude Opus 5.5 (High)', counts: {O: 163, R: 16744}, cache_rate_source: 'openrouter-public', cache_rate_batch: false},
        {model_key: 'gpt-6-sol-max-agent', display: 'GPT 6 Sol (Max)', counts: {O: 326, R: 16744}, cache_rate_source: 'openrouter-public', cache_rate_batch: true},
      ],
      partial: 13,
    },
    same_price_groups: [{ids: ['a', 'b'], ambiguous: true, input_usd_per_mtok: 2, output_usd_per_mtok: 10, cache_write_usd_per_mtok: 2.5, cache_read_usd_per_mtok: 0.2}],
  };
  api.renderPriceCandidates(view, false);
  assert.equal(api.fpCands.hidden, false, '未唯一定名时候选列表可见');
  const rows = api.fpCandsList.children;
  assert.ok(rows.length >= 5, `候选列表应有若干行，实际 ${rows.length}`);
  const flat = rows.map(r => r.children.map(c => c.textContent).join(' | ')).join('\n');
  assert.match(flat, /208 个模型里 2 个能整除/, '报硬筛选统计');
  assert.match(flat, /Claude Opus 5\.5 \(High\)/, '列出硬筛选候选名');
  assert.match(flat, /O=163 R=16744/, '列出反推 token 数');
  assert.match(flat, /batch 半价/, '⚠️ 标注 batch 口径');
  assert.match(flat, /比值 1\.299/, '列出软判据比值');
  assert.match(flat, /GPT 5\.6 Sol/, '列出第二名');
  assert.match(flat, /四项价格完全相同/, '列出同价等价类');
  assert.match(flat, /13 个变体缺计价字段/, '报 partial 数量');
});

test('价格候选列表显示每百万单价与期望/观察账单金额', () => {
  const api = ctx.__ampTest;
  const gemini = {
    model_key: 'skimaki-kwc6-agent', label: 'Gemini 3.8 Flash (High)', ratio: 1,
    expected_usd: 0.0045, complete: true,
    rates: {input_usd_per_mtok: 0.75, output_usd_per_mtok: 3.75},
  };
  const gpt = {
    model_key: 'gpt-6.1-sol-max-agent', label: 'GPT 6.1 Sol (Max)', ratio: 0.375,
    expected_usd: 0.012, complete: true,
    rates: {
      input_usd_per_mtok: 2, output_usd_per_mtok: 10,
      cache_read_usd_per_mtok: 0.2, cache_write_usd_per_mtok: 2.5,
      cache_rate_source: 'openrouter-public', cache_rate_batch: true,
    },
  };
  api.renderPriceCandidates({
    separable: false, observed_usd: 0.0045,
    price_window_matches: 1, price_ranked_models: 2,
    price_window_hits: [gemini], hit: gemini, runner_up: gpt,
  }, false);
  const flat = api.fpCandsList.children.map(row => row.children.map(child => child.textContent).join(' | ')).join('\n');
  assert.match(flat, /Gemini 3\.8 Flash \(High\)/);
  assert.match(flat, /输入 \$0\.75 \/ 输出 \$3\.75/);
  assert.match(flat, /期望 \$0\.0045 \/ 账单 \$0\.0045/);
  assert.match(flat, /GPT 6\.1 Sol \(Max\)/);
  assert.match(flat, /输入 \$2 \/ 输出 \$10/);
  assert.match(flat, /缓存读\/写 \$0\.2 \/ \$2\.5（OpenRouter 公开）/);
  assert.match(flat, /batch 半价/);
  assert.match(flat, /期望 \$0\.012 \/ 账单 \$0\.0045/);
});

test('唯一定名：候选列表收起（不干扰结论）', () => {
  const api = ctx.__ampTest;
  api.renderPriceCandidates({separable: true, hit: {model_key: 'x'}, hard_filter: {candidates: [{model_key: 'x', display: 'X', counts: {}}]}}, true);
  assert.equal(api.fpCands.hidden, true, '唯一定名时候选列表隐藏');
});

test('content.js：候选列表样式与字段消费（源码级）', () => {
  const content = read('content.js');
  assert.match(content, /\.fp-cands\{margin-top:8px;border:1px solid #35544a/, '候选列表容器样式');
  assert.match(content, /\.fp-cands-list\{max-height:190px;overflow:auto\}/, '候选列表独立滚动（防撑高）');
  assert.match(content, /function renderPriceCandidates\(view,separable\)/, '渲染函数存在');
  assert.match(content, /renderPriceCandidates\(view,separable\);/, 'renderPricePanel 里接线');
  assert.match(content, /if\(separable\)\{fpCands\.hidden=true;/, '唯一定名时收起');
});

/* ---------- v2.19.4 默认页签必须点亮（首装空存储 = 不能空白） ---------- */

test('浮层：createHud() 建完 DOM 后即点亮默认页签（首个面板 active）', () => {
  const api = ctx.__ampTest;
  /* ★ 真机回归：此前只有 loadLocalState() 读到存储值才 selectTab()，
     存储为空（首次安装）时三个 .panel 全是 display:none，用户看到空白浮层。
     断言：不依赖任何存储恢复，createHud() 后必须恰好有一个面板带 .active。 */
  const active = Object.entries(api.panels).filter(([, p]) => p.classList.contains('active'));
  assert.equal(active.length, 1, `createHud() 后应有且仅有 1 个 active 面板，实际 ${active.length}`);
  assert.equal(active[0][0], 'numeric', '默认页签是数字指纹');
  assert.ok(api.tabs.numeric.classList.contains('active'), '默认页签按钮也高亮');
});

test('浮层：默认页签点亮不写存储（不污染「恢复上次页签」）', () => {
  const content = read('content.js');
  /* createHud() 里的初次点亮必须 persist=false，否则 loadLocalState() 永远读到默认值 */
  assert.match(content, /selectTab\(activeTab,false\);\s*\n\s*paint\(\);/, 'createHud 末尾用 persist=false 点亮');
  assert.match(content, /function selectTab\(key,persist=true\)/, 'selectTab 支持 persist 开关');
  assert.match(content, /if\(persist\)\{try\{void chrome\.storage\.local\.set\(\{\[COST_TAB_KEY\]:key\}\);/, '仅在 persist 时落盘');
});

/* ---------- v2.19.9 费率族在浮层里的呈现 ---------- */

test('浮层：价格面板有费率族时标题显示族名、徽章显示「费率族」', () => {
  const api = ctx.__ampTest;
  api.setPrice({
    separable: false, reason: 'not-separable', evidence: 'rate-family',
    text: '价格指纹: 费率结构指向 …',
    rate_family: {
      members: 3,
      groups: 1,
      rates: {input: 0.1, output: 0.5, cache_read: 0.01},
      models: [{model_key: 'a', display: 'Claude Haiku 5.5'}, {model_key: 'b', display: 'GPT 6 Luna'}, {model_key: 'c', display: 'X'}],
      text: '…',
    },
  });
  api.renderPricePanel();
  const name = api.panels.price.querySelector('.fp-name').textContent;
  const badge = api.panels.price.querySelector('.fp-badge').textContent;
  assert.match(name, /Claude Haiku 5\.5 \/ GPT 6 Luna 等 3 个/, '★ 标题直接报族名，不再只写「未唯一定名」');
  assert.equal(badge, '费率族');
});

test('浮层：没有费率族时标题仍是「未唯一定名」（不假装有结论）', () => {
  const api = ctx.__ampTest;
  api.setPrice({separable: false, reason: 'not-separable', text: '价格指纹: 不能唯一定名（…）'});
  api.renderPricePanel();
  assert.equal(api.panels.price.querySelector('.fp-name').textContent, '未唯一定名');
  assert.equal(api.panels.price.querySelector('.fp-badge').textContent, '不能定名');
});
