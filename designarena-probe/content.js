/* DesignArena Probe — 在 designarena.ai 新对话里发探针、采集回复、提取风格特征。
 *
 * 实测（2026-10-19，Chrome 155 / CDP 9333）：
 *   · 输入框 = Lexical 编辑器：`div[role="textbox"]` 里是 `p[contenteditable]`。
 *     **只能靠 focus + execCommand('insertText') 写入**；`Input.insertText` 与合成事件都无效。
 *     注意：会话页在「有待投票的 A/B」时编辑器被置为 contenteditable=false（占位符写
 *     「请先为上方设计投票…」），此时不可用 —— 所以本扩展只在**新对话**里工作。
 *   · 发送按钮 = `button[aria-label="Submit prompt"]`。
 *   · 发送后 URL 变成 `/chat/<id>`，回复是纯文本（DOM 没有稳定 class，故用 innerText 快照差分）。
 *
 * 刻意不做的事：不自动投票、不调 /tournament/<id>/reveal、不新建 A/B 项目。
 * 盲测是 designarena 的根基，自动投票会制造假票、污染榜单。
 */
(() => {
  'use strict';
  if (window.__daProbeLoaded) return;
  window.__daProbeLoaded = true;

  const HOME = 'https://www.designarena.ai/';
  const KEY = 'da.probe.v1';
  const SUBMIT_SEL = 'button[aria-label="Submit prompt"]';

  /* ---------- 探针题库：短、纯文本、尽量不触发建站 ---------- */
  const PROBES = [
    '先不要写代码，也不要创建项目。只用两句话回答：你会用什么思路做一个设置图标？',
    '先不要写代码。用一句话解释：为什么圆角比直角看起来更友好？',
    '先不要写代码。只回答下面这个算式的结果，不要解释：17 × 23 = ?',
    '先不要写代码。用两句话说明：深色模式下，强调色应该怎么选？',
  ];

  /* ---------- 工具 ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const text = el => (el && el.textContent || '').trim();
  const box = () => document.querySelector('[role="textbox"]');
  const usable = () => {
    const b = box();
    return !!b && b.getAttribute('contenteditable') !== 'false';
  };
  const submitBtn = () => document.querySelector(SUBMIT_SEL);
  const snapshot = () => (document.body ? document.body.innerText : '') || '';

  /* 填入文字：Lexical 只认真实编辑命令，而且 **DOM 更新是异步的**（实测 execCommand 返回 true
     之后立刻读 textContent 还是空的，下一帧才出现）—— 必须等一拍再校验，否则会误判失败。 */
  async function fill(probe) {
    const b = box();
    if (!b) return {ok: false, why: '找不到输入框'};
    if (b.getAttribute('contenteditable') === 'false') return {ok: false, why: '输入框被禁用（多半有待投票的 A/B）'};
    b.focus();
    await sleep(120);
    /* 先清空（同样要等一拍） */
    if (text(b)) {
      try { document.execCommand('selectAll'); document.execCommand('delete'); } catch {}
      await sleep(200);
    }
    try { document.execCommand('insertText', false, probe); } catch (e) { return {ok: false, why: '写入失败: ' + e.message}; }
    await sleep(300);
    const after = text(b);
    if (!after.includes(probe.slice(0, 8))) return {ok: false, why: `写入未生效（当前: "${after.slice(0, 20)}"）`};
    return {ok: true};
  }

  /* 回复提取：SPA 跳转后整页 DOM 会被替换，**公共前缀差分不可靠**（实测差分出整页、永远不稳定）。
     改成按行过滤：去掉导航/UI 固定文案、去掉探针回声，取最长的候选行（实测回复就是最长那行）。 */
  const UI_LINES = [
    '新建项目', '搜索', '我的项目', '排行榜', '模型', '博客', '关于', 'ZH', 'DesignArena by',
    'What would you like to create?', 'Describe what you want to build', '最近的设计',
    '可缩放矢量图形', '图片', 'UI 组件', '网站', '幻灯片', '游戏开发', '3D 设计', '数据可视化',
    '移动应用', '文本转语音', 'MCP连接', 'MCP连接与工具准备指南', 'MCP连接与自动化准备',
    'We use cookies', 'Accept', 'Reject', 'Learn more',
  ];
  function extractReply(probe) {
    const probeKey = probe.slice(0, 12);
    const lines = snapshot().split('\n').map(l => l.trim()).filter(Boolean);
    const cands = lines.filter(l =>
      l.length >= 20 &&
      !l.includes(probeKey) &&
      !UI_LINES.some(u => l === u || l.startsWith(u))
    );
    if (!cands.length) return '';
    return cands.reduce((a, b) => (b.length > a.length ? b : a), '');
  }

  /* 风格特征：用于后续标定/最近邻 */
  function features(s) {
    if (!s) return null;
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const punct = (s.match(/[，。；：、！？]/g) || []).length;
    const asciiPunct = (s.match(/[,.;:!?]/g) || []).length;
    const quotes = (s.match(/[「」“”"']/g) || []).length;
    const emoji = (s.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
    const sentences = s.split(/[。！？.!?]+/).filter(x => x.trim());
    const lines = s.split('\n').filter(x => x.trim());
    return {
      len: s.length,
      cjk_ratio: Number((cjk / Math.max(1, s.length)).toFixed(3)),
      punct_ratio: Number((punct / Math.max(1, cjk || 1)).toFixed(3)),
      ascii_punct: asciiPunct,
      cjk_punct: punct,
      quotes,
      emoji,
      sentences: sentences.length,
      avg_sentence_len: Number((s.length / Math.max(1, sentences.length)).toFixed(1)),
      lines: lines.length,
      bullets: (s.match(/^[\s]*[-*•\d]/gm) || []).length,
      has_code: /```/.test(s),
      ends_with_period: /[。.!?]$/.test(s.trim()),
    };
  }

  /* ---------- 记录 ---------- */
  async function load() {
    const got = await chrome.storage.local.get(KEY);
    return got[KEY] || {records: [], pending: null, label: null};
  }
  async function save(state) { await chrome.storage.local.set({[KEY]: state}); }

  /* ---------- 单轮 ---------- */
  async function runOne(probe, log) {
    const f = await fill(probe);
    if (!f.ok) return {ok: false, why: f.why};
    log('已填入探针，准备发送…');
    await sleep(400);
    const btn = submitBtn();
    if (!btn) return {ok: false, why: '找不到发送按钮'};
    btn.click();
    log('已发送，等待回复…');

    /* 等回复：最多 90s，检测到候选行并稳定 3s 视为完成 */
    let last = '', stable = 0, reply = '';
    for (let t = 0; t < 90; t += 1) {
      await sleep(1000);
      const cur = extractReply(probe);
      if (cur && cur === last) stable += 1; else stable = 0;
      last = cur;
      if (cur.length > 20 && stable >= 3) { reply = cur; break; }
      if (t === 20) log('仍在等待…（20s）');
    }
    if (!reply) return {ok: false, why: '等待回复超时'};
    return {ok: true, reply, url: location.href};
  }

  /* ---------- HUD ---------- */
  let hud, statusEl, logEl, countEl;
  function ui() {
    hud = document.createElement('div');
    hud.id = 'da-probe-hud';
    hud.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;background:#14161a;color:#e8ecef;font:12px/1.55 system-ui,sans-serif;border:1px solid #2a2f37;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.45);padding:10px 12px';
    hud.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <b style="font-size:12px">DesignArena Probe</b>
        <span id="da-count" style="color:#8b98a5;margin-left:auto"></span>
      </div>
      <div id="da-status" style="color:#9fb0c0;min-height:32px;margin-bottom:6px">就绪</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button id="da-one" style="flex:1;padding:5px;background:#2b6cb0;color:#fff;border:0;border-radius:6px;cursor:pointer">发 1 条</button>
        <button id="da-many" style="flex:1;padding:5px;background:#2f855a;color:#fff;border:0;border-radius:6px;cursor:pointer">连发 3 轮</button>
        <button id="da-stop" style="padding:5px;background:#4a2020;color:#f6b0b0;border:0;border-radius:6px;cursor:pointer">停</button>
        <button id="da-export" style="padding:5px;background:#2d3748;color:#cbd5e0;border:0;border-radius:6px;cursor:pointer">导出</button>
        <button id="da-label" style="padding:5px;background:#2d3748;color:#cbd5e0;border:0;border-radius:6px;cursor:pointer">标定</button>
      </div>
      <div id="da-log" style="margin-top:6px;color:#6b7a88;font-size:11px;max-height:64px;overflow:auto"></div>`;
    document.documentElement.appendChild(hud);
    statusEl = hud.querySelector('#da-status');
    logEl = hud.querySelector('#da-log');
    countEl = hud.querySelector('#da-count');
  }
  const setStatus = s => { if (statusEl) statusEl.textContent = s; };
  const addLog = s => { if (logEl) logEl.textContent = (s + '\n' + logEl.textContent).slice(0, 800); };

  let stopped = false;

  async function oneRound(idx) {
    const probe = PROBES[idx % PROBES.length];
    setStatus('发送中…');
    const r = await runOne(probe, addLog);
    if (!r.ok) { setStatus('失败：' + r.why); addLog('✗ ' + r.why); return false; }
    const state = await load();
    state.records.push({
      at: new Date().toISOString(),
      probe, reply: r.reply, features: features(r.reply),
      url: r.url, label: null,
    });
    await save(state);
    setStatus('已采集 ' + state.records.length + ' 条');
    countEl.textContent = state.records.length + ' 条';
    addLog('回复 ' + r.reply.length + ' 字');
    return true;
  }

  async function loop(n) {
    stopped = false;
    for (let i = 0; i < n; i += 1) {
      if (stopped) break;
      const state = await load();
      const ok = await oneRound(state.records.length);
      if (!ok) return;                 // 失败：保留 oneRound 写的状态，别被「完成」覆盖
      if (i < n - 1) {
        setStatus('准备下一轮（回到首页）…');
        await sleep(1500);
        location.href = HOME;   // 每轮一个全新对话；页面重载后由 pending 续跑
        return;                 // 重载后由 boot() 接手
      }
    }
    setStatus('完成');
  }

  async function exportJson() {
    const state = await load();
    const blob = new Blob([JSON.stringify(state.records, null, 2)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'designarena-probe-' + Date.now() + '.json';
    a.click();
    addLog('已导出 ' + state.records.length + ' 条');
  }

  async function labelLast() {
    const name = prompt('这条回复是哪个模型生成的？（填模型名，用于后续标定）');
    if (!name) return;
    const state = await load();
    if (!state.records.length) { addLog('还没有记录'); return; }
    state.records[state.records.length - 1].label = name.trim();
    await save(state);
    addLog('已标定: ' + name.trim());
  }

  function mount() {
    if (!/designarena\.ai$/.test(location.hostname)) return;
    if (document.getElementById('da-probe-hud')) return;
    ui();
    hud.querySelector('#da-one').onclick = () => void loop(1);
    hud.querySelector('#da-many').onclick = () => void loop(3);
    hud.querySelector('#da-stop').onclick = () => { stopped = true; setStatus('已停止'); };
    hud.querySelector('#da-export').onclick = () => void exportJson();
    hud.querySelector('#da-label').onclick = () => void labelLast();
    void load().then(s => { countEl.textContent = (s.records.length || 0) + ' 条'; });
    setStatus(usable() ? '就绪（输入框可用）' : '输入框当前不可用 —— 请开一个新对话');
  }

  /* 页面加载后挂载；SPA 路由变化也重挂 */
  const boot = () => { mount(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  new MutationObserver(() => { if (!document.getElementById('da-probe-hud')) mount(); })
    .observe(document.documentElement, {childList: true, subtree: false});
})();
