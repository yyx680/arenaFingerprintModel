(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const available = typeof chrome !== 'undefined' && chrome.scripting?.executeScript && chrome.tabs?.query;
  let busy = false;
  let refreshing = false;
  let lastReport = null;
  let correctTarget = false;
  let pollTimer;
  const text = (value, limit = 250) => typeof value === 'string' ? value.slice(0, limit) : '';

  function notify(message, error = false) {
    $('notice').textContent = message;
    $('notice').hidden = !message;
    $('notice').classList.toggle('error', error);
  }
  function updateButtons() {
    $('begin-button').disabled = !available || !correctTarget || busy;
    $('pause-button').disabled = busy || !lastReport || lastReport.status === 'stopped';
    $('stop-button').disabled = busy || !lastReport || lastReport.status === 'stopped';
    $('export-button').disabled = !lastReport || busy;
    $('endpoint-filter').disabled = busy || !available;
    $('pause-button').textContent = lastReport?.status === 'paused' ? '继续' : '暂停';
  }
  function number(value) { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0; }
  function render(report) {
    lastReport = report || null;
    const listening = report?.status === 'listening';
    $('status-badge').textContent = !available ? '网页预览' : !correctTarget ? '非目标页面' : !report ? '等待启动' : listening ? '本轮监听中' : report.status === 'paused' ? '已暂停' : '已停止';
    $('status-badge').classList.toggle('active', listening);
    $('status-badge').classList.toggle('warning', report?.summary?.status === 'ambiguous');
    const summary = report?.summary;
    const labels = { declared: '明确声明', ambiguous: '存在歧义', 'identifier-only': '仅有内部 ID', unknown: '未知' };
    $('evidence-label').textContent = labels[summary?.status] || '未知';
    $('model-value').textContent = summary?.status === 'declared' ? text(summary.model, 120) || '未知' : summary?.status === 'ambiguous' ? '多个声明，暂不选择' : summary?.status === 'identifier-only' ? '仅观察到内部 ID' : '等待明确证据';
    $('model-value').classList.toggle('known', summary?.status === 'declared');
    $('provider-value').textContent = text(summary?.provider, 120) || '未披露';
    $('round-value').textContent = report ? String(number(report.observationWindow)) : '—';
    $('response-value').textContent = String(number(report?.responsesObserved));
    const rows = Array.isArray(report?.observations) ? report.observations : [];
    $('record-value').textContent = String(rows.length);
    $('skipped-label').textContent = report ? `${number(report.skipped)} 项因格式/上限跳过` : '无额外网络请求';
    const list = $('observation-list');
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '开始观察后，正常提交自己的任务。未下发型号时保持未知，不根据回答风格猜测。';
      list.append(empty);
    } else for (const row of rows.slice(-5).reverse()) {
      const item = document.createElement('div');
      item.className = 'record';
      const value = document.createElement('strong');
      value.textContent = text(row.value, 120);
      const details = document.createElement('p');
      details.textContent = `${text(row.source, 40)} · ${text(row.path)} · ×${number(row.count)}`;
      item.append(value, details);
      list.append(item);
    }
    updateButtons();
  }
  async function targetTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    let url;
    try { url = new URL(tab?.url || ''); } catch { correctTarget = false; throw new Error('请切换到你自己的 DesignArena 页面，再打开插件。'); }
    correctTarget = url.protocol === 'https:' && (url.hostname === 'designarena.ai' || url.hostname.endsWith('.designarena.ai')) && typeof tab.id === 'number';
    $('target-host').textContent = correctTarget ? url.hostname : '请打开 DesignArena 页面';
    if (!correctTarget) throw new Error('仅允许在 DesignArena 的 HTTPS 页面手动启动。未注入任何脚本。');
    return tab;
  }
  async function pageCall(tabId, method, args = {}) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (methodName, methodArgs) => {
        const api = window.__designArenaSingleAgentProbe;
        if (!api || api.owner !== 'designarena-single-agent-observer' || typeof api.snapshot !== 'function') return { ok: false, reason: 'not_installed' };
        if (!['snapshot', 'begin', 'pause', 'resume', 'stop'].includes(methodName)) return { ok: false, reason: 'unsupported_method' };
        if (methodName !== 'snapshot') api[methodName](methodArgs);
        return { ok: true, report: api.snapshot() };
      },
      args: [method, args],
    });
    return results[0]?.result || { ok: false, reason: 'no_result' };
  }
  async function refresh(silent = false) {
    if (!available || busy || refreshing) return;
    refreshing = true;
    try {
      const tab = await targetTab();
      const result = await pageCall(tab.id, 'snapshot');
      render(result.ok ? result.report : null);
      if (!silent) notify(result.ok ? '' : '点击「开始新一轮观察」，再正常提交自己的单 Agent 任务。');
    } catch (error) {
      render(null);
      if (!silent) notify(error.message || '无法读取当前标签页。', true);
    } finally { refreshing = false; updateButtons(); }
  }
  async function perform(action) {
    if (busy || !available) return;
    busy = true;
    updateButtons();
    try {
      const tab = await targetTab();
      let result;
      if (action === 'begin') {
        const endpointIncludes = $('endpoint-filter').value.trim();
        if (/[?#]/.test(endpointIncludes)) throw new Error('只填写端点路径片段，不填写查询参数、哈希或访问令牌。');
        const current = await pageCall(tab.id, 'snapshot');
        if (!current.ok || current.report?.status === 'stopped') {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['probe.js'] });
        }
        result = await pageCall(tab.id, 'begin', { endpointIncludes });
        if (!result.ok) throw new Error('当前页面未能安装探针，请刷新目标页面后重试。');
        notify('本轮已开始。现在可在网页中正常提交自己的任务，插件不会代发消息。');
      } else {
        const method = action === 'toggle' ? (lastReport?.status === 'paused' ? 'resume' : 'pause') : action;
        result = await pageCall(tab.id, method);
        if (!result.ok) throw new Error('页面已刷新或探针不存在，请重新开始本轮观察。');
        notify(method === 'stop' ? '已卸载页面内的探针。报告仍可导出；没有改变网站任务。' : method === 'pause' ? '已暂停元数据观察。' : '继续观察之后出现的响应。');
      }
      render(result.report);
    } catch (error) { notify(error.message || '操作未完成，请在目标页面重试。', true); }
    finally { busy = false; updateButtons(); }
  }
  function downloadReport() {
    if (!lastReport) return;
    const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'designarena-single-agent-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    notify('已导出本轮元数据报告，不包含提示词、正文或认证信息。');
  }
  function toggleHelp(show) { $('help-view').hidden = !show; $('observer-view').hidden = show; $('help-button').setAttribute('aria-expanded', String(show)); }
  $('help-button').addEventListener('click', () => toggleHelp($('help-view').hidden));
  $('back-button').addEventListener('click', () => toggleHelp(false));
  $('begin-button').addEventListener('click', () => void perform('begin'));
  $('pause-button').addEventListener('click', () => void perform('toggle'));
  $('stop-button').addEventListener('click', () => void perform('stop'));
  $('export-button').addEventListener('click', downloadReport);
  if (!available) {
    $('target-host').textContent = '插件弹窗预览 · 未连接任何目标页面';
    correctTarget = false;
    render(null);
    notify('这是普通网页预览，浏览器扩展 API 不可用。安装独立插件后，再在自己的目标页面使用。');
  } else {
    void refresh();
    pollTimer = setInterval(() => void refresh(true), 1500);
  }
  window.addEventListener('pagehide', () => clearInterval(pollTimer));
})();
