#!/usr/bin/env node
/**
 * tools/cdp.mjs — 极简 CDP 客户端（零依赖，走 Node 22 内置 WebSocket）
 *
 * 用途：连上 --remote-debugging-port 的 Chrome/Edge，在页面上下文里执行 JS，
 *       拿回结构化结果。用于 Arena 侦察（读登录态 / 发请求 / 抓成本字段）。
 *
 * 用法：
 *   node tools/cdp.mjs <port> --list
 *   node tools/cdp.mjs <port> --url arena.ai --file expr.js
 *   node tools/cdp.mjs <port> --url arena.ai --eval "return document.title"
 *   node tools/cdp.mjs <port> --new https://arena.ai/ --file expr.js
 *
 * expr 文件内容会被包进 async IIFE，可以用 `await`，最后 `return` 一个可序列化值。
 * 也可写成完整表达式（自动探测）：若不含 `return`，则按表达式求值。
 *
 * 退出码：0 成功；2 连不上 CDP；3 找不到目标页；4 页面执行抛异常。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const out = { port: 9222, list: false, url: 'arena.ai', file: null, eval: null, neu: null, timeout: 45000, raw: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--raw') out.raw = true;
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--eval') out.eval = argv[++i];
    else if (a === '--new') out.neu = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (/^\d+$/.test(a)) out.port = Number(a);
    else rest.push(a);
  }
  // 位置参数回退：cdp.mjs 9222 expr.js
  if (!out.file && rest.length) {
    const maybe = rest[rest.length - 1];
    if (/\.js$|\.mjs$/.test(maybe)) out.file = maybe;
  }
  return out;
}

export async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) });
  return await r.json();
}

export function pickTarget(targets, urlSub) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (urlSub) {
    const hit = pages.find((t) => (t.url || '').includes(urlSub));
    if (hit) return hit;
  }
  return pages.find((t) => !/^(devtools|chrome-extension|about:)/.test(t.url || '')) || pages[0] || null;
}

/** 打开一个新标签页（/json/new 在新版 Chrome 需要 PUT） */
export async function openTarget(port, url) {
  const endpoints = [
    [`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, 'PUT'],
    [`http://127.0.0.1:${port}/json/new?${url}`, 'PUT'],
    [`http://127.0.0.1:${port}/json/new?${url}`, 'GET'],
  ];
  for (const [u, method] of endpoints) {
    try {
      const r = await fetch(u, { method, signal: AbortSignal.timeout(8000) });
      if (r.ok) return await r.json();
    } catch { /* try next */ }
  }
  return null;
}

class Conn {
  constructor(wsUrl, reqTimeoutMs = 60000) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.reqTimeout = reqTimeoutMs;
  }
  async open(timeoutMs = 10000) {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws open timeout')), timeoutMs);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error('ws error')); };
    });
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        this.events.push(m);
        if (this.events.length > 500) this.events.shift();
      }
    };
    ws.onclose = () => {
      for (const { rej } of this.pending.values()) rej(new Error('ws closed'));
      this.pending.clear();
    };
    return this;
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`timeout: ${method}`)); }
      }, this.reqTimeout);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

/** 在页面上下文执行表达式，返回可序列化值 */
export async function evaluate({ port, urlSub, expression, timeout = 45000, newUrl = null, reload = false }) {
  if (newUrl) {
    const t = await openTarget(port, newUrl);
    if (!t) throw new Error('无法新建标签页');
    await new Promise((r) => setTimeout(r, 1200));
  }
  const targets = await listTargets(port);
  const t = pickTarget(targets, urlSub);
  if (!t) throw new Error('找不到匹配的目标页');
  // CDP 层等待时间 = 页面执行超时 + 30s 余量
  const c = await new Conn(t.webSocketDebuggerUrl, Math.max(60000, timeout + 30000)).open();
  try {
    await c.send('Runtime.enable');
    if (reload) {
      await c.send('Page.enable');
      await c.send('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 4000));
    }
    // 以 `(` 开头 → 视为单个表达式（含 IIFE）；含 return → 语句块；否则也当表达式。
    // 注意：IIFE 内部有 return，必须先按「以 ( 开头」判掉，否则返回值会丢。
    const trimmed = expression.trim();
    const statementStyle = !trimmed.startsWith('(') && /\breturn\b/.test(trimmed);
    const wrapped = statementStyle
      ? `(async () => { ${expression} })()`
      : `(async () => { return (${expression}); })()`;
    const r = await c.send('Runtime.evaluate', {
      expression: wrapped,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout,
    });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error('页面异常: ' + (e.exception?.description || e.text || JSON.stringify(e)).slice(0, 1200));
    }
    return { target: { id: t.id, url: t.url, title: t.title }, value: r.result?.value };
  } finally {
    c.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.list) {
    const ts = await listTargets(a.port);
    for (const t of ts) console.log(`${t.type}\t${(t.url || '').slice(0, 120)}\t${t.id}`);
    return 0;
  }
  let expr = a.eval;
  if (!expr && a.file) expr = readFileSync(a.file, 'utf8');
  if (!expr) { console.error('缺少 --file 或 --eval'); return 1; }
  const out = await evaluate({ port: a.port, urlSub: a.url, expression: expr, timeout: a.timeout, newUrl: a.neu });
  const val = out.value;
  if (a.raw) console.log(typeof val === 'string' ? val : JSON.stringify(val));
  else console.log(JSON.stringify({ target: out.target, value: val }, null, 2));
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((c) => process.exit(c)).catch((e) => {
    const msg = String(e?.message || e);
    console.error('CDP_ERROR: ' + msg);
    process.exit(/timeout|ECONNREFUSED|fetch failed|ws error|ws open/.test(msg) ? 2 : 4);
  });
}
