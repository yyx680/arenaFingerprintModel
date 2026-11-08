/* DesignArena passive model-metadata observer — 2026-10-19.
 * Run in your own designarena.ai page via DevTools > Sources > Snippets.
 * No additional requests, no endpoint scanning, no credential collection.
 * Observations are response declarations, NOT proof of the underlying model.
 */
(() => {
  'use strict';
  const OWNER = 'designarena-passive-observer';
  const KEY = '__designArenaProbe';
  const allowedHost = host => host === 'designarena.ai' || host.endsWith('.designarena.ai');
  if (!allowedHost(location.hostname)) {
    console.warn('[DesignArenaProbe] 请在自己的 designarena.ai 页面中运行。未安装监听器。');
    return { installed: false, reason: 'wrong_origin' };
  }
  if (window[KEY]?.owner === OWNER) window[KEY].stop();

  const limits = Object.freeze({ bytesPerResponse: 524288, streamMilliseconds: 90000, records: 200, readers: 4, depth: 9, nodes: 1800 });
  const original = { fetch: window.fetch, open: XMLHttpRequest.prototype.open, send: XMLHttpRequest.prototype.send };
  const xhrInfo = new WeakMap();
  const xhrListeners = new Map();
  const readers = new Set();
  const observations = new Map();
  const state = { paused: false, stopped: false, seen: 0, skipped: 0, startedAt: new Date().toISOString() };
  const modelKeys = new Set(['model', 'modelname', 'modelid', 'llmmodel', 'providermodel', 'requestmodel', 'responsemodel', 'basemodel', 'modelversion', 'deploymentmodel']);
  const providerKeys = new Set(['provider', 'providername', 'llmprovider', 'modelprovider']);
  const sensitiveKey = /prompt|content|text|reason|thought|token|secret|authorization|cookie|password|email|userdata|userprofile|input|output|attachment|image|audio|video|embedding/i;
  const headers = ['x-model', 'x-model-name', 'x-model-id', 'x-provider', 'x-provider-model'];
  const compactKey = value => String(value).toLowerCase().replace(/[_-]/g, '');
  const active = () => !state.paused && !state.stopped;
  let redrawQueued = false;

  function requestInfo(input) {
    try {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(raw, location.href);
      if (!allowedHost(url.hostname) || url.protocol !== 'https:') return null;
      const path = url.pathname.split('/').map(segment => {
        if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(segment) || /^\d+$/.test(segment) || segment.length > 28 || /@|%40/i.test(segment)) return ':id';
        return /^[a-zA-Z0-9_.-]*$/.test(segment) ? segment : ':segment';
      }).join('/');
      return { endpoint: url.hostname + path, catalog: /(?:^|\/)(models?|leaderboards?|catalog)(?:\/|$)/i.test(url.pathname) };
    } catch { return null; }
  }

  function identifier(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 120 || /^eyJ/.test(trimmed) || /https?:\/\//i.test(trimmed)) return null;
    return /^[a-zA-Z0-9][a-zA-Z0-9_.:/+@ -]*$/.test(trimmed) ? trimmed : null;
  }

  function record(field, value, kind, source, path, info) {
    const safe = identifier(value);
    if (!safe || !active()) return;
    const catalog = info.catalog || /(?:^|\.)(?:models|availableModels|revealedModels|leaderboard|catalog)(?:\[|\.|$)/i.test(path);
    const evidence = info.status >= 400 ? 'error-response' : catalog ? 'catalog-metadata' : 'response-declaration';
    const signature = JSON.stringify([kind, field, safe, source, path, info.endpoint, evidence]);
    const now = new Date().toISOString();
    const existing = observations.get(signature);
    if (existing) { existing.count++; existing.lastSeen = now; }
    else {
      if (observations.size >= limits.records) { state.skipped++; scheduleRender(); return; }
      observations.set(signature, { kind, field, value: safe, source, path, endpoint: info.endpoint, status: info.status, evidence, firstSeen: now, lastSeen: now, count: 1 });
      console.info('[DesignArenaProbe] 元数据观测（未经底层验证）', { kind, field, value: safe, source, path, endpoint: info.endpoint, evidence });
    }
    scheduleRender();
  }

  function inspect(value, source, info) {
    let visited = 0;
    function walk(node, path, depth, modelContext = false) {
      if (!node || typeof node !== 'object' || depth > limits.depth || ++visited > limits.nodes || !active()) return;
      if (Array.isArray(node)) {
        for (let index = 0; index < Math.min(node.length, 100); index++) walk(node[index], `${path}[${index}]`, depth + 1, modelContext);
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (++visited > limits.nodes) break;
        const normalized = compactKey(key);
        if (sensitiveKey.test(key)) continue;
        const safeKey = /^[A-Za-z_][A-Za-z0-9_-]{0,35}$/.test(key) ? key : ':key';
        const childPath = path ? `${path}.${safeKey}` : safeKey;
        if (modelKeys.has(normalized)) {
          if (typeof child === 'string') record(key, child, 'model', source, childPath, info);
          else walk(child, childPath, depth + 1, true);
        } else if (providerKeys.has(normalized)) {
          if (typeof child === 'string') record(key, child, 'provider', source, childPath, info);
          else if (child && typeof child === 'object') {
            for (const property of ['name', 'id']) record(`${key}.${property}`, child[property], 'provider', source, `${childPath}.${property}`, info);
          }
        } else if (modelContext && ['name', 'id', 'slug'].includes(normalized)) record(key, child, 'model', source, childPath, info);
        else if (child && typeof child === 'object') walk(child, childPath, depth + 1, /^(models|availablemodels|revealedmodels)$/.test(normalized));
      }
    }
    walk(value, '', 0);
  }

  function inspectHeaders(getHeader, info) {
    for (const header of headers) {
      try {
        const value = getHeader(header);
        if (value) record(header, value, header === 'x-provider' ? 'provider' : 'model', 'response-header', header, info);
      } catch { /* An unavailable header is not evidence of a model. */ }
    }
  }

  function parseLine(line, source, info) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || trimmed === 'data: [DONE]') return;
    const payload = trimmed.replace(/^data:\s?/, '').replace(/^[0-9a-zA-Z_-]{1,12}:(?=[\[{])/, '');
    if (!/^[\[{]/.test(payload) || payload.length > 131072) return;
    try { inspect(JSON.parse(payload), source, info); } catch { /* Incomplete/text frames are intentionally ignored. */ }
  }

  async function inspectResponse(response, info) {
    if (!active()) return;
    inspectHeaders(name => response.headers.get(name), info);
    const type = response.headers.get('content-type') || '';
    const isJson = /application\/(?:[^;]+\+)?json(?:;|$)/i.test(type);
    const isStream = /text\/event-stream|application\/(?:x-)?ndjson|text\/x-component|text\/plain/i.test(type);
    if ((!isJson && !isStream) || !response.body) return;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (readers.size >= limits.readers || (contentLength > limits.bytesPerResponse && isJson)) { state.skipped++; scheduleRender(); return; }
    let reader;
    try { reader = response.clone().body.getReader(); } catch { state.skipped++; scheduleRender(); return; }
    readers.add(reader);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; state.skipped++; void reader.cancel().catch(() => {}); scheduleRender(); }, limits.streamMilliseconds);
    const decoder = new TextDecoder();
    let buffered = '';
    let byteCount = 0;
    let complete = false;
    try {
      while (active() && !timedOut) {
        const { value, done } = await reader.read();
        if (done) { complete = true; buffered += decoder.decode(); break; }
        byteCount += value.byteLength;
        if (byteCount > limits.bytesPerResponse) { state.skipped++; break; }
        buffered += decoder.decode(value, { stream: true });
        if (isStream) {
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          for (const line of lines) parseLine(line, /event-stream/i.test(type) ? 'SSE' : /x-component/i.test(type) ? 'RSC' : 'JSON-lines', info);
          if (buffered.length > 131072) { state.skipped++; break; }
        }
      }
      if (complete && active() && !timedOut) {
        if (isJson) { try { inspect(JSON.parse(buffered), 'JSON-response', info); } catch { state.skipped++; } }
        else parseLine(buffered, 'stream-final-frame', info);
      }
    } catch { state.skipped++; }
    finally {
      clearTimeout(timer);
      buffered = '';
      readers.delete(reader);
      void reader.cancel().catch(() => {});
      scheduleRender();
    }
  }

  function wrappedFetch(...args) {
    const promise = Reflect.apply(original.fetch, this, args);
    return promise.then(response => {
      try {
        const info = requestInfo(response.url || args[0]);
        if (info && active()) {
          state.seen++;
          scheduleRender();
          void inspectResponse(response, { ...info, status: response.status }).catch(() => {});
        }
      } catch { /* Observation errors never change the caller's response. */ }
      return response;
    });
  }

  function wrappedOpen(method, url, ...rest) {
    const oldListener = xhrListeners.get(this);
    if (oldListener) { this.removeEventListener('loadend', oldListener); xhrListeners.delete(this); }
    const info = requestInfo(url);
    if (info) xhrInfo.set(this, info); else xhrInfo.delete(this);
    return Reflect.apply(original.open, this, [method, url, ...rest]);
  }

  function wrappedSend(...args) {
    const info = xhrInfo.get(this);
    if (info && active()) {
      const listener = () => {
        xhrListeners.delete(this);
        if (!active()) return;
        try {
          state.seen++;
          const context = { ...info, status: this.status };
          inspectHeaders(name => this.getResponseHeader(name), context);
          const type = this.getResponseHeader('content-type') || '';
          if (this.responseType === 'json') inspect(this.response, 'XHR-JSON', context);
          else if ((!this.responseType || this.responseType === 'text') && /json|event-stream|ndjson|x-component/i.test(type)) {
            const text = this.responseText;
            if (text.length <= limits.bytesPerResponse) {
              try { inspect(JSON.parse(text), 'XHR-JSON', context); }
              catch { text.split('\n').forEach(line => parseLine(line, 'XHR-frame', context)); }
            } else state.skipped++;
          }
        } catch { state.skipped++; }
        scheduleRender();
      };
      xhrListeners.set(this, listener);
      this.addEventListener('loadend', listener, { once: true });
    }
    try { return Reflect.apply(original.send, this, args); }
    catch (error) {
      const listener = xhrListeners.get(this);
      if (listener) this.removeEventListener('loadend', listener);
      xhrListeners.delete(this);
      throw error;
    }
  }

  function snapshot() {
    return { schema: 'designarena-passive-probe/v1', createdAt: new Date().toISOString(), startedAt: state.startedAt, pageHost: location.hostname, passive: true, status: state.stopped ? 'stopped' : state.paused ? 'paused' : 'listening', responsesObserved: state.seen, skipped: state.skipped, limits, caveat: '响应字段仅是声明或目录信息，不证明底层实际调用的模型。无观测不代表没有使用模型。', observations: [...observations.values()].map(row => ({ ...row })) };
  }

  function download() {
    const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'designarena-observations-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.documentElement.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const host = document.createElement('div');
  host.id = 'designarena-passive-probe-panel';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;font-family:system-ui,sans-serif;color-scheme:light';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{font:12px system-ui,sans-serif;color:#293d34}section{width:350px;max-width:calc(100vw - 36px);background:#fbfcf7;border:1px solid #dbe5d6;border-radius:13px;box-shadow:0 9px 50px #173b2526;overflow:hidden}header{display:flex;align-items:center;justify-content:space-between;padding:15px 16px;border-bottom:1px solid #e5eadd}h2{font-size:13px;margin:0;font-weight:650}button{font:11px system-ui,sans-serif;cursor:pointer;color:#496647;border:1px solid #d9e3d0;border-radius:5px;background:#f0f4e9;padding:7px 9px}button:focus-visible{outline:2px solid #668659;outline-offset:2px}.body{padding:14px 16px}.status{display:flex;align-items:center;justify-content:space-between;font-size:10px;color:#7a8b70;margin-bottom:12px}.list{max-height:200px;overflow:auto}.record{padding:9px 0;border-top:1px solid #e5eadd}.value{font:12px ui-monospace,monospace;color:#365b41;overflow-wrap:anywhere}.meta{font-size:9px;color:#91a087;margin-top:4px;overflow-wrap:anywhere}.empty{padding:17px 0;color:#8a987f;font-size:11px;line-height:1.8}.notice{font-size:10px;line-height:1.8;color:#8a967f;background:#f0f3e8;padding:9px;border-radius:5px;margin-top:10px}.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.mini{background:none;border:0;font-size:15px;padding:1px 7px}footer{font-size:9px;letter-spacing:.5px;color:#93a088;padding:0 16px 12px}[hidden]{display:none!important}';
  function el(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
  const panel = el('section');
  const heading = el('header');
  heading.append(el('h2', '◉  DesignArena · 响应观察器'));
  const minimize = el('button', '−', 'mini');
  minimize.setAttribute('aria-label', '折叠观察面板');
  heading.append(minimize);
  const body = el('div', '', 'body');
  const stats = el('div', '', 'status');
  const statusLabel = el('span');
  const countLabel = el('span');
  stats.append(statusLabel, countLabel);
  const list = el('div', '', 'list');
  list.setAttribute('aria-live', 'polite');
  const notice = el('div', '仅观察当前页面已收到的数据。响应自报 ≠ 底层模型验证；未发现字段时保持未知。', 'notice');
  const actions = el('div', '', 'actions');
  const pauseButton = el('button', '暂停');
  const exportButton = el('button', '导出 JSON');
  const clearButton = el('button', '清空');
  const stopButton = el('button', '卸载');
  actions.append(pauseButton, exportButton, clearButton, stopButton);
  body.append(stats, list, notice, actions);
  const footer = el('footer', 'PASSIVE ONLY · NO EXTRA REQUESTS');
  panel.append(heading, body, footer);
  shadow.append(style, panel);
  document.documentElement.append(host);

  function render() {
    redrawQueued = false;
    if (state.stopped) return;
    statusLabel.textContent = state.paused ? '已暂停' : '被动监听中';
    countLabel.textContent = `${state.seen} 个响应 · ${observations.size} 项观测`;
    pauseButton.textContent = state.paused ? '继续' : '暂停';
    pauseButton.setAttribute('aria-pressed', String(state.paused));
    list.replaceChildren();
    if (!observations.size) list.append(el('div', '等待明确的模型字段。请在页面上正常进行自己的操作；探针不会自动发送消息或消耗额度。', 'empty'));
    else for (const row of [...observations.values()].reverse().slice(0, 12)) {
      const item = el('div', '', 'record');
      item.append(el('div', row.value, 'value'), el('div', `${row.kind} · ${row.source} · ${row.evidence === 'catalog-metadata' ? '目录/揭示信息' : row.evidence === 'error-response' ? '错误响应' : '响应声明'} · ×${row.count}`, 'meta'), el('div', `${row.path} · ${row.endpoint}`, 'meta'));
      list.append(item);
    }
    footer.textContent = `被动观察 · ${state.skipped} 项因上限/格式跳过 · 不采集凭据`;
  }
  function scheduleRender() { if (redrawQueued || state.stopped) return; redrawQueued = true; queueMicrotask(render); }
  function cancelReaders() { for (const reader of readers) void reader.cancel().catch(() => {}); readers.clear(); }
  function pause() { if (state.stopped) return false; state.paused = true; cancelReaders(); render(); return true; }
  function resume() { if (state.stopped) return false; state.paused = false; render(); return true; }
  function clear() { observations.clear(); state.seen = 0; state.skipped = 0; render(); }
  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    if (window.fetch === wrappedFetch) window.fetch = original.fetch;
    if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = original.open;
    if (XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = original.send;
    for (const [xhr, listener] of xhrListeners) xhr.removeEventListener('loadend', listener);
    xhrListeners.clear();
    cancelReaders();
    host.remove();
    console.info('[DesignArenaProbe] 已卸载自己的监听器；已有报告仍可通过 __designArenaProbe.snapshot() 读取。');
  }
  minimize.addEventListener('click', () => { body.hidden = !body.hidden; footer.hidden = body.hidden; minimize.textContent = body.hidden ? '+' : '−'; minimize.setAttribute('aria-label', body.hidden ? '展开观察面板' : '折叠观察面板'); });
  pauseButton.addEventListener('click', () => state.paused ? resume() : pause());
  exportButton.addEventListener('click', download);
  clearButton.addEventListener('click', clear);
  stopButton.addEventListener('click', stop);
  const api = Object.freeze({ owner: OWNER, version: '1.0.0', installed: true, snapshot, export: download, clear, pause, resume, stop });
  window[KEY] = api;
  try {
    window.fetch = wrappedFetch;
    XMLHttpRequest.prototype.open = wrappedOpen;
    XMLHttpRequest.prototype.send = wrappedSend;
  } catch {
    stop();
    console.warn('[DesignArenaProbe] 当前页面禁止安装网络观察器。未主动发送任何请求。');
    return { installed: false, reason: 'hook_not_allowed' };
  }
  render();
  console.info('[DesignArenaProbe] 已安装。仅观察之后发生的当前站点 fetch/XHR；不覆盖 WebSocket、独立 EventSource 或 Web Worker。使用 __designArenaProbe.snapshot() 查看，__designArenaProbe.stop() 卸载。');
  return api;
})();
