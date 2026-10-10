import {identifyPrepared, prepareOutputs} from './model-probe-engine.js';
import {loadProbeBank} from './model-probe-bank.js';
import {createBalanceReader} from './billing.js';
import {countNumbers, parseNumbers} from './modeltrace-core.js';
import {queryRunTrace} from './model-trace.js';
import {rhythmProfile, rhythmVote, rhythmAccumulate} from './rhythm-channel.js';
import './text-channel.js';

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

function isAgentUrl(value) {
  try { const url = new URL(value); return url.origin === 'https://arena.ai'; } // 与 content.js agentPage() 一致：v2.9.15 起各模式（Battle/Code/Text 等）都会探测，不再限定 /agent、/work 路径
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
        },
        signals: result.signals,
        used_outputs: result.used_outputs,
        bank_models: result.bank_models,
        bank_source: loaded.info.source,
      },
    };
  })().then(reply, error => reply({error: error?.message || '模型指纹评分失败'}));
  return true;
});

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

const netState = {token: '', tokenAt: 0, models: [], currentModels: [], streams: [], pendingStreams: [], lastTraceAt: 0, recentRequests: [], pageSnifferAliveAt: 0, pageScanStats: null};
const traceState = {status: 'idle', text: '等待 public-access-token（页面自身请求的响应头）', runId: null, name: null, environment: null, rhythm: null, endpoints: [], error: null, at: null};

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
    {urls: ['https://arena.ai/*', 'https://api.trigger.dev/*']},
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
