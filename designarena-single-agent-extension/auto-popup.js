(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const available = typeof chrome !== 'undefined' && chrome.scripting?.executeScript && chrome.tabs?.query;
  const bindingInputs = [...document.querySelectorAll('[data-binding]')];
  let busy = false, refreshing = false, target = false, report = null;
  let interval;
  function notice(text, error = false) { $('auto-notice').textContent = text; $('auto-notice').hidden = !text; $('auto-notice').classList.toggle('error', error); }
  function controls() {
    const configured = bindingInputs.filter(input => input.dataset.binding !== 'completed').every(input => input.value.trim());
    $('auto-start').disabled = !available || !target || busy || report?.active || !configured || !$('confirm-cost').checked;
    $('auto-stop').disabled = busy || !report?.active;
    $('auto-export').disabled = busy || !report;
    document.querySelectorAll('[data-pick]').forEach(button => button.disabled = !available || !target || busy || report?.active);
  }
  async function targetTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    let url;
    try { url = new URL(tab?.url || ''); } catch { target = false; throw new Error('请在自己的 DesignArena 页面打开插件。'); }
    target = url.protocol === 'https:' && (url.hostname === 'designarena.ai' || url.hostname.endsWith('.designarena.ai')) && typeof tab.id === 'number';
    $('auto-target').textContent = target ? url.hostname : '请选择自己的 DesignArena 标签页';
    if (!target) throw new Error('仅支持在 DesignArena 的 HTTPS 页面按需运行。');
    return tab;
  }
  async function page(tabId, method, args = {}) {
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: (name, values) => {
      const auto = window.__designArenaAutoDraw;
      if (!auto || auto.owner !== 'scope-bounded-auto-draw') return { ok: false };
      if (!['snapshot', 'pick', 'start', 'stop', 'exportReport'].includes(name)) return { ok: false };
      if (name === 'pick') return { ok: true, value: auto.pick(values.binding) };
      return { ok: true, value: name === 'start' ? auto.start(values) : auto[name]() };
    }, args: [method, args] });
    return results[0]?.result || { ok: false };
  }
  async function ensure(tabId, includeProbe = false) {
    if (includeProbe) {
      const found = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { const p = window.__designArenaSingleAgentProbe; return Boolean(p?.owner === 'designarena-single-agent-observer' && p.snapshot().status !== 'stopped'); } });
      if (!found[0]?.result) await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['probe.js'] });
    }
    if (!(await page(tabId, 'snapshot')).ok) await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['automation.js'] });
  }
  function render(value) {
    report = value || null;
    const names = { idle: '未启动', starting: '准备中', 'new-chat': '新建会话', submitting: '提交中', waiting: '等待结果', cooldown: '间隔等待', matched: '声明命中', unknown: '型号未知', stopped: '已停止', completed: '批次完成' };
    $('auto-badge').textContent = !available ? '网页预览' : names[value?.phase] || '未启动';
    $('auto-badge').classList.toggle('active', Boolean(value?.active));
    $('auto-badge').classList.toggle('error', value?.phase === 'stopped' && Boolean(value?.lastHttpError));
    $('auto-counter').textContent = `${Number(value?.round) || 0} / ${Number(value?.maxRounds) || 0}`;
    $('auto-reason').textContent = typeof value?.reason === 'string' && value.reason ? value.reason : '手动确认后才会开始。关闭弹窗可继续；切换标签页或离开页面会停止。';
    for (const input of bindingInputs) if (!input.dataset.dirty && typeof value?.bindings?.[input.dataset.binding] === 'string') input.value = value.bindings[input.dataset.binding];
    $('auto-history').replaceChildren();
    for (const row of Array.isArray(value?.history) ? value.history.slice(-5) : []) {
      const line = document.createElement('div'); line.className = 'auto-history-row';
      const round = document.createElement('span'); round.textContent = `第 ${row.round} 轮 · ${row.targetMatched ? '声明命中' : row.status || '未知'}`;
      const model = document.createElement('strong'); model.textContent = typeof row.model === 'string' ? row.model.slice(0, 120) : '未取得明确型号';
      line.append(round, model); $('auto-history').append(line);
    }
    controls();
  }
  async function refresh(silent = false) {
    if (!available || busy || refreshing) return;
    refreshing = true;
    try { const tab = await targetTab(); const result = await page(tab.id, 'snapshot'); render(result.ok ? result.value : null); }
    catch (error) { target = false; render(null); if (!silent) notice(error.message, true); }
    finally { refreshing = false; controls(); }
  }
  async function choose(binding) {
    if (busy) return; busy = true; controls();
    try { const tab = await targetTab(); await ensure(tab.id); const result = await page(tab.id, 'pick', { binding }); if (!result.ok) throw new Error('无法启动控件选择。'); window.close(); }
    catch (error) { notice(error.message || '无法绑定控件。', true); }
    finally { busy = false; controls(); }
  }
  async function start() {
    if (busy || !$('confirm-cost').checked) return;
    busy = true; controls();
    try {
      const tab = await targetTab(); await ensure(tab.id, true);
      const bindings = Object.fromEntries(bindingInputs.map(input => [input.dataset.binding, input.value.trim()]));
      const result = await page(tab.id, 'start', { bindings, prompt: $('task-prompt').value, targetModel: $('target-model').value, maxRounds: Number($('max-rounds').value), intervalSeconds: Number($('interval').value), timeoutSeconds: Number($('timeout').value), continueUnknown: $('continue-unknown').checked, confirmCosts: $('confirm-cost').checked });
      if (!result.ok) throw new Error('自动抽卡控制器未安装。');
      render(result.value); notice('自动抽卡已由你启动。可能消耗生成额度；可随时停止后续提交。');
      $('confirm-cost').checked = false;
    } catch (error) { notice(error.message || '启动失败，未继续操作。', true); }
    finally { busy = false; controls(); }
  }
  async function stop() {
    busy = true; controls();
    try { const tab = await targetTab(); const result = await page(tab.id, 'stop'); if (result.ok) render(result.value); notice('已请求停止后续提交。网站已经开始的任务不会被自动取消。'); }
    catch (error) { notice(error.message || '无法读取当前页面，请刷新目标页面停止页面内自动化。', true); }
    finally { busy = false; controls(); }
  }
  async function exportReport() {
    try {
      const tab = await targetTab(); const result = await page(tab.id, 'exportReport'); if (!result.ok) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.value, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'scope-auto-draw-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 15000);
      notice('已导出本批元数据，不包含任务内容或控件选择器。');
    } catch (error) { notice(error.message || '无法导出。', true); }
  }
  document.querySelectorAll('[data-pick]').forEach(button => button.addEventListener('click', () => void choose(button.dataset.pick)));
  bindingInputs.forEach(input => input.addEventListener('input', () => { input.dataset.dirty = 'true'; controls(); }));
  $('confirm-cost').addEventListener('change', controls);
  $('auto-start').addEventListener('click', () => void start());
  $('auto-stop').addEventListener('click', () => void stop());
  $('auto-export').addEventListener('click', () => void exportReport());
  if (!available) { $('auto-target').textContent = '网页预览 · 不会操作目标页面'; render(null); notice('这是插件界面预览。下载并安装扩展后，才能在自己的目标页面绑定控件和启动。'); }
  else { void refresh(); interval = setInterval(() => void refresh(true), 1500); }
  window.addEventListener('pagehide', () => clearInterval(interval));
})();
