/* User-started, bounded UI automation. No private API calls or authentication bypass. */
(() => {
  'use strict';
  const OWNER = 'scope-bounded-auto-draw';
  const KEY = '__designArenaAutoDraw';
  const allowed = () => location.protocol === 'https:' && (location.hostname === 'designarena.ai' || location.hostname.endsWith('.designarena.ai'));
  if (!allowed()) return;
  if (window[KEY]?.owner === OWNER) return;
  const bindings = { newChat: '', prompt: '', submit: '', completed: '' };
  const state = { active: false, phase: 'idle', round: 0, maxRounds: 0, reason: '', startedAt: null, history: [], job: 0, cancelled: false, lastHttpError: null };
  let config = null, pickerCleanup = null, monitorCleanup = null;
  let banner = null, bannerText = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const probe = () => window.__designArenaSingleAgentProbe;
  const visible = element => element instanceof Element && element.isConnected && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  const label = element => (element?.getAttribute('aria-label') || element?.getAttribute('title') || element?.textContent || '').trim().slice(0, 180);
  const enabled = element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  function selected(selector) {
    if (!selector) return null;
    let items;
    try { items = [...document.querySelectorAll(selector)].filter(visible); } catch { throw new Error('页面控件选择器格式无效，请重新绑定。'); }
    if (items.length > 1) throw new Error('绑定匹配到多个可见控件，请重新选择唯一控件。');
    return items[0] || null;
  }
  function isPrompt(element) { return element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && ['text', 'search'].includes(element.type)) || element?.getAttribute('contenteditable') === 'true'; }
  function isButton(element) { return element?.matches('button,[role="button"],a[href],input[type="submit"]'); }
  function selectorFor(element) {
    for (const attribute of ['id', 'data-testid', 'data-test-id', 'aria-label']) {
      const value = element.getAttribute(attribute);
      if (!value || value.length > 120) continue;
      const selector = `${element.tagName.toLowerCase()}[${attribute}="${CSS.escape(value)}"]`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    const segments = [];
    let current = element;
    for (let depth = 0; current?.parentElement && depth < 10; depth++, current = current.parentElement) {
      const tag = current.tagName.toLowerCase();
      const siblings = [...current.parentElement.children].filter(node => node.tagName === current.tagName);
      segments.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
      const candidate = segments.join(' > ');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    throw new Error('无法生成唯一绑定，请选更具体的控件。');
  }
  function createBanner(message, picking = false) {
    removeBanner();
    banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:15px;right:15px;z-index:2147483647;max-width:440px;font-family:system-ui,sans-serif';
    const shadow = banner.attachShadow({ mode: 'open' });
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;gap:13px;align-items:center;padding:13px 15px;background:#304d39;color:#f0f6e7;border:1px solid #a3bd8a;border-radius:9px;box-shadow:0 8px 35px #183a2630;font-size:12px;line-height:1.7';
    bannerText = document.createElement('span'); bannerText.textContent = message;
    const button = document.createElement('button');
    button.textContent = picking ? '取消选择' : '停止抽卡';
    button.style.cssText = 'flex-shrink:0;background:#e8efd9;color:#5e7d4e;border:0;border-radius:5px;padding:7px 10px;cursor:pointer;font-size:11px';
    button.addEventListener('click', () => picking ? cancelPick() : stop('你已停止自动抽卡。已提交的网页任务不会被自动取消。'));
    box.append(bannerText, button); shadow.append(box); document.documentElement.append(banner);
  }
  function removeBanner() { banner?.remove(); banner = null; bannerText = null; }
  function setPhase(phase, message) { state.phase = phase; state.reason = message; if (bannerText) bannerText.textContent = `Scope · 第 ${state.round}/${state.maxRounds} 轮 · ${message}`; }
  function cancelPick() { if (pickerCleanup) pickerCleanup(); pickerCleanup = null; removeBanner(); }
  function pick(name) {
    if (state.active) throw new Error('请先停止自动抽卡，再绑定控件。');
    if (!Object.prototype.hasOwnProperty.call(bindings, name)) throw new Error('未知绑定类型。');
    cancelPick();
    const names = { newChat: '新建会话按钮', prompt: '任务输入框', submit: '提交 / 生成按钮', completed: '生成完成后出现的唯一标记（可选）' };
    createBanner(`点击页面上的${names[name]}。此次点击只做选择，不执行控件。按 Esc 取消。`, true);
    let highlighted = null, savedOutline = '';
    function target(event) {
      let element = event.target instanceof Element ? event.target : null;
      if (name === 'prompt') element = element?.closest('textarea,input[type="text"],input[type="search"],[contenteditable="true"]');
      else if (name !== 'completed') element = element?.closest('button,[role="button"],a[href],input[type="submit"]');
      if (!element || banner?.contains(element) || element === document.body || element === document.documentElement) return null;
      return element;
    }
    function unhighlight() { if (highlighted) highlighted.style.outline = savedOutline; highlighted = null; }
    function move(event) { const element = target(event); if (element === highlighted) return; unhighlight(); if (element) { highlighted = element; savedOutline = element.style.outline; element.style.outline = '3px solid #93b96b'; } }
    function click(event) {
      if (event.composedPath().includes(banner)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const element = target(event);
      if (!element) return;
      try { bindings[name] = selectorFor(element); state.reason = `已绑定${names[name]}。重新打开插件即可继续。`; cancelPick(); }
      catch (error) { if (bannerText) bannerText.textContent = error.message; }
    }
    function key(event) { if (event.key === 'Escape') { event.preventDefault(); cancelPick(); } }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    pickerCleanup = () => { unhighlight(); document.removeEventListener('mousemove', move, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); };
    return { picking: name };
  }
  function challengeVisible() {
    const nodes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],iframe[src*="recaptcha"][title*="challenge"],iframe[src*="hcaptcha"],#challenge-running,#challenge-stage');
    return [...nodes].some(element => visible(element) && element.getBoundingClientRect().height > 30);
  }
  function siteFailure() {
    return [...document.querySelectorAll('[role="alert"]')].some(element => visible(element) && /rate.?limit|too many requests|unauthorized|forbidden|insufficient|quota|credits|captcha|限流|额度不足|余额不足|登录失效|验证失败|请求失败/i.test(element.textContent || ''));
  }
  function busyControl() {
    return [...document.querySelectorAll('button,[role="button"]')].find(element => visible(element) && /^(stop|cancel)(\s+(generating|generation|running|task))?$|停止生成|停止任务|取消生成|取消任务/i.test(label(element))) || null;
  }
  function guard(job) {
    if (state.cancelled || job !== state.job) throw new Error(state.reason || '抽卡已停止。');
    if (!allowed()) throw new Error('已离开允许的目标站点，自动抽卡停止。');
    if (document.hidden) throw new Error('目标标签页已转到后台，已停止后续提交。回到页面后可手动重新开始。');
    if (challengeVisible()) throw new Error('检测到验证挑战，停止自动操作。请你自行完成验证。');
    if (siteFailure()) throw new Error('页面提示鉴权、额度或限流问题，已停止自动提交。');
    if (!probe() || probe().snapshot().status !== 'listening') throw new Error('观察器未在监听，停止后续提交。');
  }
  async function waitFor(check, timeout, job) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { guard(job); const result = check(); if (result) return result; await sleep(200); }
    throw new Error('等待页面控件超时；没有继续提交。请检查绑定是否仍然有效。');
  }
  function clickControl(element, purpose) {
    if (!isButton(element) || !enabled(element)) throw new Error(`${purpose}不是可操作的可见按钮。`);
    if (/delete|remove account|purchase|subscribe|checkout|payment|删除|注销|购买|付款|支付/i.test(label(element))) throw new Error('绑定疑似删除或支付控件，已拒绝点击。');
    if (element instanceof HTMLAnchorElement) {
      const url = new URL(element.href, location.href);
      if (url.origin !== location.origin) throw new Error('绑定按钮将跳转到外部站点，已停止。');
    }
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!top || (top !== element && !element.contains(top))) throw new Error('目标控件被弹窗遮挡，未执行点击。');
    element.click();
  }
  function fillPrompt(element, value) {
    if (!isPrompt(element) || !enabled(element)) throw new Error('绑定的任务输入框不可编辑。');
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    } else element.textContent = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function monitorHttp() {
    if (monitorCleanup) monitorCleanup();
    const originalFetch = window.fetch;
    const originalSend = XMLHttpRequest.prototype.send;
    const listeners = new Map();
    function check(url, status) {
      if (!state.active || ![401, 403, 429].includes(status)) return;
      try { const parsed = new URL(url, location.href); if (parsed.hostname === 'designarena.ai' || parsed.hostname.endsWith('.designarena.ai')) { state.lastHttpError = status; stop(`检测到 HTTP ${status}，停止后续提交，不自动重试或绕过限制。`); } } catch { /* No valid origin means no inference. */ }
    }
    function fetchWrapper(...args) { return Reflect.apply(originalFetch, this, args).then(response => { check(response.url, response.status); return response; }); }
    function sendWrapper(...args) {
      const listener = () => { listeners.delete(this); check(this.responseURL, this.status); };
      listeners.set(this, listener); this.addEventListener('loadend', listener, { once: true });
      try { return Reflect.apply(originalSend, this, args); } catch (error) { this.removeEventListener('loadend', listener); listeners.delete(this); throw error; }
    }
    window.fetch = fetchWrapper;
    XMLHttpRequest.prototype.send = sendWrapper;
    monitorCleanup = () => { if (window.fetch === fetchWrapper) window.fetch = originalFetch; if (XMLHttpRequest.prototype.send === sendWrapper) XMLHttpRequest.prototype.send = originalSend; for (const [xhr, listener] of listeners) xhr.removeEventListener('loadend', listener); listeners.clear(); monitorCleanup = null; };
  }
  function stop(reason = '已停止后续自动提交。当前网页任务不会被自动取消。') {
    state.cancelled = true; state.active = false; state.phase = 'stopped'; state.reason = reason;
    if (monitorCleanup) monitorCleanup();
    removeBanner();
    return snapshot();
  }
  function snapshot() {
    return { schema: 'scope-auto-draw/v1', version: '1.1.0', active: state.active, phase: state.phase, round: state.round, maxRounds: state.maxRounds, reason: state.reason, startedAt: state.startedAt, lastHttpError: state.lastHttpError, bindings: { ...bindings }, settings: config ? { maxRounds: config.maxRounds, intervalSeconds: config.intervalSeconds, targetModel: config.targetModel, continueUnknown: config.continueUnknown } : null, history: state.history.map(row => ({ ...row })), currentObservation: probe()?.snapshot?.() || null };
  }
  function exportReport() { const report = snapshot(); delete report.bindings; return report; }
  async function run(job) {
    try {
      for (let round = 1; round <= config.maxRounds; round++) {
        state.round = round;
        guard(job);
        if (busyControl()) throw new Error('网页中有正在生成的任务，停止自动抽卡，避免干扰已有工作。');
        setPhase('new-chat', '正在通过已绑定按钮新建会话');
        probe().begin();
        const newChat = await waitFor(() => { const element = selected(bindings.newChat); return enabled(element) ? element : null; }, 20000, job);
        clickControl(newChat, '新建会话按钮');
        await sleep(900);
        guard(job);
        const input = await waitFor(() => { const element = selected(bindings.prompt); return isPrompt(element) && enabled(element) ? element : null; }, 25000, job);
        fillPrompt(input, config.prompt);
        await sleep(400);
        const submit = await waitFor(() => { const element = selected(bindings.submit); return enabled(element) ? element : null; }, 12000, job);
        const beforeDone = bindings.completed ? selected(bindings.completed) : null;
        let sawDoneAbsent = !beforeDone;
        let sawBusy = false;
        let confirmedFinished = false;
        let targetMatched = false;
        probe().begin();
        setPhase('submitting', '正在提交本轮任务，可能消耗生成额度');
        guard(job);
        clickControl(submit, '提交按钮');
        const startedAt = new Date().toISOString();
        const started = Date.now();
        setPhase('waiting', '等待任务完成及明确的模型字段');
        while (Date.now() - started < config.timeoutSeconds * 1000) {
          guard(job);
          const observation = probe().snapshot();
          if (config.targetModel && observation.summary?.status === 'declared' && String(observation.summary.model).toLowerCase() === config.targetModel.toLowerCase()) { targetMatched = true; break; }
          const currentBusy = busyControl();
          if (currentBusy) sawBusy = true;
          if (sawBusy && !currentBusy && Date.now() - started > 1500) confirmedFinished = true;
          if (bindings.completed) {
            const done = selected(bindings.completed);
            if (!done) sawDoneAbsent = true;
            if (done && sawDoneAbsent && Date.now() - started > 1500) confirmedFinished = true;
          }
          if (confirmedFinished) break;
          await sleep(250);
        }
        const summary = probe().snapshot().summary || { status: 'unknown', model: null };
        state.history.push({ round, startedAt, endedAt: new Date().toISOString(), model: summary.model || null, provider: summary.provider || null, status: summary.status || 'unknown', verified: false, completionConfirmed: confirmedFinished, targetMatched });
        if (targetMatched) { state.phase = 'matched'; state.reason = '响应声明命中目标，停止后续抽卡。当前网页任务仍可继续；型号未作底层验证。'; break; }
        if (!confirmedFinished) throw new Error('未确认本轮任务完成，已停止，避免重复提交。请绑定可靠的完成标记。');
        if (summary.status !== 'declared' && !config.continueUnknown) { state.phase = 'unknown'; state.reason = '本轮没有唯一明确型号，已停止。没有依据猜测或继续消耗额度。'; break; }
        if (round === config.maxRounds) { state.phase = 'completed'; state.reason = '已达到你设置的轮次上限，自动提交结束。'; break; }
        setPhase('cooldown', `等待 ${config.intervalSeconds} 秒后开始下一轮`);
        const nextAt = Date.now() + config.intervalSeconds * 1000;
        while (Date.now() < nextAt) { guard(job); await sleep(300); }
      }
    } catch (error) { if (job === state.job) { state.phase = 'stopped'; if (!state.cancelled) state.reason = error.message || '自动抽卡已停止。'; } }
    finally { if (job === state.job) { state.active = false; if (monitorCleanup) monitorCleanup(); removeBanner(); } }
  }
  function start(options = {}) {
    if (state.active) throw new Error('当前抽卡仍在运行，请先停止。');
    if (options.confirmCosts !== true) throw new Error('必须先确认自动生成可能消耗账号额度。');
    if (!allowed() || document.hidden) throw new Error('请在当前可见的 DesignArena 标签页启动。');
    if (!probe() || probe().snapshot().status === 'stopped') throw new Error('单 Agent 观察器尚未安装。');
    const prompt = typeof options.prompt === 'string' ? options.prompt.trim() : '';
    if (!prompt || prompt.length > 4000) throw new Error('任务内容需为 1–4000 个字符。');
    const supplied = options.bindings || {};
    for (const name of Object.keys(bindings)) if (typeof supplied[name] === 'string') bindings[name] = supplied[name].trim().slice(0, 1000);
    for (const name of ['newChat', 'prompt', 'submit']) { if (!bindings[name]) throw new Error('请先绑定新建会话、输入框和提交按钮。'); document.querySelector(bindings[name]); }
    if (bindings.completed) document.querySelector(bindings.completed);
    if (bindings.newChat === bindings.submit) throw new Error('新建会话与提交不能绑定到同一个控件。');
    const bounded = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
    config = { prompt, maxRounds: bounded(options.maxRounds, 1, 5, 2), intervalSeconds: bounded(options.intervalSeconds, 30, 600, 60), timeoutSeconds: bounded(options.timeoutSeconds, 30, 600, 180), targetModel: String(options.targetModel || '').trim().slice(0, 120), continueUnknown: options.continueUnknown === true };
    cancelPick();
    state.job++; state.cancelled = false; state.active = true; state.phase = 'starting'; state.round = 0; state.maxRounds = config.maxRounds; state.startedAt = new Date().toISOString(); state.reason = '准备开始'; state.history = []; state.lastHttpError = null;
    probe().resume();
    createBanner('Scope · 自动抽卡即将开始。可随时停止后续提交。');
    monitorHttp();
    void run(state.job);
    return snapshot();
  }
  window[KEY] = Object.freeze({ owner: OWNER, version: '1.1.0', pick, cancelPick, start, stop, snapshot, exportReport });
  window.addEventListener('pagehide', () => { cancelPick(); stop('页面已离开，自动抽卡停止。'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.active) stop('标签页进入后台，停止后续提交。'); });
})();
;void 0;
